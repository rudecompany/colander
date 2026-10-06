// The jobs table and the Store's alarm (src/jobs.ts), driven with runDurableObjectAlarm and a
// clock set far ahead, so no alarm fires on its own while a test runs.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEBOUNCE, dumpBackoff, nextDump, nextSeeds, PASS_CHUNK, PASS_INTERVAL, PRUNE_INTERVAL, PUBLISH_FLOOR, STATUS, type DumpResult, type PassScorer } from '../src/jobs';
import { nextAuditExport } from '../src/backup';
import { allow } from '../src/limits';
import { SNAPSHOT_KEY } from '../src/store/list';
import type { Store } from '../src/store/store';

const stub = env.STORE.getByName('primary');
const T = 1_900_000_000_000;
const S = T / 1000;
let clock = T;

/** Runs fn in the primary Store with its clock at time. The clock stays there for its alarms. */
function at<R>(time: number, fn: (store: Store, state: DurableObjectState) => R | Promise<R>): Promise<R> {
	clock = time;
	return runInDurableObject(stub, (store: Store, state) => {
		store.now = () => clock;
		return fn(store, state);
	});
}

/** Runs the alarm with the clock at time. */
function alarm(time: number): Promise<boolean> {
	clock = time;
	return runDurableObjectAlarm(stub);
}

const jobRows = (store: Store) => store.db.all<{ name: string; due_at: number }>('SELECT name, due_at FROM jobs ORDER BY name');

afterEach(async () => {
	await runInDurableObject(stub, async (store: Store, state) => {
		store.db.run('DELETE FROM jobs');
		for (const key of Object.values(STATUS)) state.storage.kv.delete(key);
		await state.storage.deleteAlarm();
	});
	await evictDurableObject(stub);
	await env.LISTS.delete(SNAPSHOT_KEY);
	vi.restoreAllMocks();
});

describe('jobs', () => {
	it('run only in the primary Store', async () => {
		const other = env.STORE.getByName('drill');
		await runInDurableObject(other, async (store: Store, state) => {
			store.jobs.requestPublish(T);
			store.jobs.ensure(T);
			expect(jobRows(store)).toEqual([]);
			expect(await store.jobs.arm()).toBeNull();
			// Rows loaded from a dump, and a stray alarm, still run nothing.
			store.db.run("INSERT INTO jobs (name, due_at) VALUES ('publish', 1)");
			await state.storage.setAlarm(Date.now() + 3_600_000);
		});
		expect(await runDurableObjectAlarm(other)).toBe(true);
		await runInDurableObject(other, async (store: Store, state) => {
			expect(jobRows(store)).toEqual([{ name: 'publish', due_at: 1 }]);
			expect(await state.storage.getAlarm()).toBeNull();
		});
		expect(await env.LISTS.head(SNAPSHOT_KEY)).toBeNull();
	});

	it('publish on request, coalesced, at most once per 10 seconds', async () => {
		await at(T, async (store, state) => {
			store.jobs.requestPublish(T);
			store.jobs.requestPublish(T);
			await store.jobs.arm();
			expect(jobRows(store)).toEqual([{ name: 'publish', due_at: T }]);
			expect(await state.storage.getAlarm()).toBe(T);
		});
		expect(await alarm(T)).toBe(true);
		expect((await env.LISTS.head(SNAPSHOT_KEY))!.customMetadata).toEqual({ seq: String(S), created: String(S) });
		await at(T + 1000, async (store, state) => {
			expect(jobRows(store)).toEqual([]);
			expect(state.storage.kv.get(STATUS.publish)).toEqual({ at: T, seq: S });
			store.jobs.requestPublish(T + 1000);
			await store.jobs.arm();
			expect(jobRows(store)).toEqual([{ name: 'publish', due_at: T + PUBLISH_FLOOR }]);
			expect(await state.storage.getAlarm()).toBe(T + PUBLISH_FLOOR);
		});
	});

	it('rescore touched sources together, 5 seconds after the first touch', async () => {
		const calls: string[] = [];
		await at(T, async (store) => {
			store.jobs.define('rescore', (arg) => (calls.push(arg), null));
			store.jobs.touch([1, 2, 1], T);
			store.jobs.touch([1], T + 3000);
			await store.jobs.arm();
			expect(jobRows(store)).toEqual([
				{ name: 'rescore:1', due_at: T + DEBOUNCE },
				{ name: 'rescore:2', due_at: T + DEBOUNCE }
			]);
		});
		await alarm(T + DEBOUNCE - 1);
		expect(calls).toEqual([]);
		await alarm(T + DEBOUNCE);
		expect(calls).toEqual(['1', '2']);
		expect(await at(T + DEBOUNCE, jobRows)).toEqual([]);
	});

	it('run the full pass in chunks with a cursor, let requests in between, and resume after a restart', async () => {
		const scored: number[] = [];
		let starts = 0;
		const scorer: PassScorer = {
			startPass: async () => void starts++,
			scoreSource: (ref) => (scored.push(ref), ref % 100 === 0 ? 1 : 0)
		};
		await at(T, async (store) => {
			store.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
				INSERT INTO sources (platform, canonical_id, created_at) SELECT 'yt', '@s' || i, 1 FROM n`);
			store.jobs.definePass(scorer);
			store.jobs.ensure(T);
			await store.jobs.arm();
		});
		await alarm(T);
		expect(scored).toHaveLength(PASS_CHUNK);
		await at(T, async (store, state) => {
			expect(state.storage.kv.get(STATUS.passProgress)).toMatchObject({ cursor: 1000, startedAt: T, sources: 1000, changes: 10 });
			expect(jobRows(store)).toEqual([
				{ name: 'audit', due_at: nextAuditExport(T) },
				{ name: 'dump', due_at: nextDump(T) },
				{ name: 'pass', due_at: T },
				{ name: 'prune', due_at: T + PRUNE_INTERVAL },
				{ name: 'requests', due_at: T + 3_600_000 },
				{ name: 'seeds', due_at: nextSeeds(T) }
			]);
			// Between turns the Store answers requests, and writes land.
			expect((await store.fetch(new Request('https://store/v1/list/delta?since=1'))).status).toBe(410);
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at) VALUES ('yt', '@late', 2)");
		});

		// A restart loses the scorer's memory, not the pass: the cursor is in storage. The start
		// reconciles with R2 first (a publication due now, run by the real alarm).
		await evictDurableObject(stub);
		await stub.health();
		await runDurableObjectAlarm(stub);
		await vi.waitFor(async () => expect(await runInDurableObject(stub, (_, state) => state.storage.kv.get(STATUS.publish))).toBeTruthy(), {
			timeout: 10_000
		});
		await at(T + 1000, (store) => store.jobs.definePass(scorer));
		await alarm(T + 1000);
		expect(scored).toHaveLength(2 * PASS_CHUNK);
		await alarm(T + 2000);
		expect(scored).toHaveLength(2501);
		expect(new Set(scored).size).toBe(2501);
		expect(starts).toBe(1);
		await at(T + 2000, (store, state) => {
			const status = state.storage.kv.get<{ rowsRead: number }>(STATUS.pass)!;
			expect(status).toMatchObject({ at: T + 2000, ms: 2000, sources: 2501, changes: 25 });
			expect(status.rowsRead).toBeGreaterThanOrEqual(2501);
			expect(state.storage.kv.get(STATUS.passProgress)).toBeUndefined();
			// The next pass is 5 minutes after this one started, and a publication was requested.
			expect(jobRows(store)).toEqual([
				{ name: 'audit', due_at: nextAuditExport(T) },
				{ name: 'dump', due_at: nextDump(T) },
				{ name: 'pass', due_at: T + PASS_INTERVAL },
				{ name: 'prune', due_at: T + PRUNE_INTERVAL },
				{ name: 'publish', due_at: T + 2000 },
				{ name: 'requests', due_at: T + 3_600_000 },
				{ name: 'seeds', due_at: nextSeeds(T) }
			]);
		});
	});

	it('retry a failing job 30 seconds later without holding back the others', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		let ran = 0;
		await at(T, async (store) => {
			store.jobs.define('flaky', () => {
				throw new Error('downstream is down');
			});
			store.jobs.define('steady', () => (ran++, null));
			store.jobs.schedule('flaky', T);
			store.jobs.schedule('steady', T);
			await store.jobs.arm();
		});
		await alarm(T);
		expect(ran).toBe(1);
		expect(await at(T, jobRows)).toEqual([{ name: 'flaky', due_at: T + 30_000 }]);
		expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([{ message: 'job failed', job: 'flaky', error: 'Error: downstream is down' }]);
	});

	it('keep a due time set while the job runs, and the one a handler returns', async () => {
		await at(T, async (store) => {
			// probe stands for a request that schedules the job again while it runs.
			store.jobs.define('probe', (_, now) => (store.jobs.schedule('probe', now + 1234), null));
			store.jobs.define('tick', (_, now) => now + 500);
			store.jobs.schedule('probe', T);
			store.jobs.schedule('tick', T);
			await store.jobs.arm();
		});
		await alarm(T);
		expect(await at(T, jobRows)).toEqual([
			{ name: 'probe', due_at: T + 1234 },
			{ name: 'tick', due_at: T + 500 }
		]);
		expect(await at(T, (_, state) => state.storage.getAlarm())).toBe(T + 500);
	});

	it('drop rows of kinds without a handler, and never schedule them', async () => {
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await at(T, async (store, state) => {
			store.jobs.schedule('retired', T);
			expect(jobRows(store)).toEqual([]);
			store.db.run("INSERT INTO jobs (name, due_at) VALUES ('retired', ?), ('later:5', ?)", T, T);
			await state.storage.setAlarm(T);
		});
		await alarm(T);
		expect(await at(T, jobRows)).toEqual([]);
		expect(warnings.mock.calls.map((c) => JSON.parse(String(c[0])).job).sort()).toEqual(['later', 'retired']);
	});

	it('arm the alarm before answering a request that scheduled a job', async () => {
		await at(T, async (store, state) => {
			store.jobs.requestPublish(T + 5000);
			expect(await state.storage.getAlarm()).toBeNull();
			await store.fetch(new Request('https://store/v1/nothing'));
			expect(await state.storage.getAlarm()).toBe(T + 5000);
		});
	});
});

describe('prune', () => {
	it('drops expired links and sessions, sequences past 30 days but the head, refilled buckets and ended trials\' settings, hourly', async () => {
		await at(T, async (store) => {
			const db = store.db;
			db.run("INSERT INTO accounts (id, email, created_at) VALUES ('acc_1', 'a@example.com', 1)");
			db.run("INSERT INTO installs (hash, created_at) VALUES ('i1', 1), ('i2', 1)");
			db.run("INSERT INTO trials (install_hash, sub, issued_at, expires_at) VALUES ('i1', 'trl_ended', 1, ?), ('i2', 'trl_running', 1, ?)", S, S + 60);
			db.run("INSERT INTO sync_blobs (sub, version, data, updated_at) VALUES ('trl_ended', 1, '{}', 1), ('trl_running', 1, '{}', 1), ('acc_1', 1, '{}', 1)");
			db.run("INSERT INTO magic_links (token_hash, email, next, created_at, expires_at) VALUES ('gone', 'a@example.com', '/', 1, ?), ('live', 'a@example.com', '/', 1, ?)", S - 1, S + 60);
			db.run("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES ('gone', 'acc_1', 1, ?), ('live', 'acc_1', 1, ?)", S, S + 60);
			const old = S - 31 * 86_400;
			db.run('DELETE FROM list_sequences');
			db.run('INSERT INTO list_sequences (seq, created_at) VALUES (1, ?), (2, ?)', old, old);
			db.run("INSERT INTO list_changes (seq, hash, entry) VALUES (1, x'0102030405060708', x'01020304050607080100000000000000')");
			allow(db, T - 3_600_000, 'full', 1, 'donate');
			allow(db, T - 60_000, 'partial', 1, 'donate');
			store.jobs.schedule('prune', T);
			await store.jobs.arm();
		});
		await alarm(T);
		await at(T, (store) => {
			const db = store.db;
			expect(db.all('SELECT token_hash FROM magic_links')).toEqual([{ token_hash: 'live' }]);
			expect(db.all('SELECT token_hash FROM sessions')).toEqual([{ token_hash: 'live' }]);
			expect(db.all('SELECT seq FROM list_sequences')).toEqual([{ seq: 2 }]);
			expect(db.all('SELECT seq FROM list_changes')).toEqual([]);
			expect(db.all('SELECT key FROM limits')).toEqual([{ key: 'partial' }]);
			expect(db.all('SELECT sub FROM sync_blobs ORDER BY sub')).toEqual([{ sub: 'acc_1' }, { sub: 'trl_running' }]);
			expect(db.all('SELECT sub FROM trials ORDER BY sub'), 'each install still gets one trial').toEqual([{ sub: 'trl_ended' }, { sub: 'trl_running' }]);
			expect(jobRows(store)).toEqual([{ name: 'prune', due_at: T + PRUNE_INTERVAL }]);
		});
	});
});

describe('dump hook', () => {
	it('runs at 03:17, 09:17, 15:17 and 21:17 UTC and records how long it took', async () => {
		const day = Date.UTC(2030, 0, 1);
		const hm = (h: number, m: number) => day + (h * 60 + m) * 60_000;
		expect(nextDump(hm(3, 16))).toBe(hm(3, 17));
		expect(nextDump(hm(3, 17))).toBe(hm(9, 17));
		expect(nextDump(hm(15, 20))).toBe(hm(21, 17));
		expect(nextDump(hm(22, 0))).toBe(hm(27, 17));

		const dumps: number[] = [];
		const first = nextDump(T);
		await at(T, async (store) => {
			store.jobs.defineDump(async (now) => (dumps.push(now), { ms: 12, bytes: 3000, size: 400 }));
			store.jobs.ensure(T);
			await store.jobs.arm();
			expect(jobRows(store)).toContainEqual({ name: 'dump', due_at: first });
		});
		await alarm(first);
		expect(dumps).toEqual([first]);
		await at(first, (store, state) => {
			expect(state.storage.kv.get(STATUS.dump)).toEqual({ at: first, ms: 12, bytes: 3000, size: 400 });
			expect(jobRows(store)).toContainEqual({ name: 'dump', due_at: first + 6 * 3_600_000 });
		});
	});

	it('backs off after a failed dump, and after one the platform cut short, instead of retrying every 30 seconds', async () => {
		const MIN = 60_000;
		expect([1, 2, 3, 5, 6, 9].map((f) => dumpBackoff(f) / MIN)).toEqual([2, 4, 8, 32, 60, 60]);
		let fail = true;
		const tries: number[] = [];
		const install = (store: Store) =>
			store.jobs.defineDump(async (now): Promise<DumpResult> => {
				tries.push(now);
				if (fail) throw new Error('R2 is down');
				return { ms: 1, bytes: 2, size: 3 };
			});
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		await at(T, async (store) => {
			install(store);
			store.jobs.schedule('dump', T);
			await store.jobs.arm();
		});
		await alarm(T);
		await at(T, (store) => expect(jobRows(store)).toEqual([{ name: 'dump', due_at: T + 2 * MIN }]));
		await alarm(T + 2 * MIN);
		await at(T, (store, state) => {
			expect(jobRows(store)).toEqual([{ name: 'dump', due_at: T + 6 * MIN }]);
			expect(state.storage.kv.get(STATUS.dumpTry)).toEqual({ failures: 2, at: T + 2 * MIN });
		});
		expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])))).toMatchObject([
			{ message: 'dump failed', failures: 1, error: 'Error: R2 is down' },
			{ message: 'dump failed', failures: 2 }
		]);
		// A try the platform reset mid-dump never returned; the lease brings it back a minute later,
		// and it waits out the backoff of the try it counted.
		await at(T, (store, state) => {
			state.storage.kv.put(STATUS.dumpTry, { failures: 3, at: T + 6 * MIN });
			store.db.run("UPDATE jobs SET due_at = ? WHERE name = 'dump'", T + 7 * MIN);
		});
		await alarm(T + 7 * MIN);
		expect(tries).toEqual([T, T + 2 * MIN]);
		await at(T, (store) => expect(jobRows(store)).toEqual([{ name: 'dump', due_at: T + 14 * MIN }]));
		fail = false;
		await alarm(T + 14 * MIN);
		await at(T, (store, state) => {
			expect(state.storage.kv.get(STATUS.dumpTry)).toBeUndefined();
			expect(state.storage.kv.get(STATUS.dump)).toEqual({ at: T + 14 * MIN, ms: 1, bytes: 2, size: 3 });
			expect(jobRows(store)).toEqual([{ name: 'dump', due_at: nextDump(T + 14 * MIN) }]);
		});
	});
});
