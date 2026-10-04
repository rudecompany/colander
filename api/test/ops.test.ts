// The ops channel (src/ops.ts) through the edge as the workflows call it, and the Store's half of
// each command: status for the probes, grant-role, import-seed (Go's TestImportSeed), sign-config
// against the contract fixture, the restores with their restart, publication and cache purge,
// and the dump drill.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { b64decode } from '@colander/shared/bytes';
import { CONFIG_CONTEXT, importKeys, verifyEnvelope } from '@colander/shared/signing';
import worker from '../src/index';
import { dump, DUMP_PREFIX, dumpKey } from '../src/backup';
import { STATUS } from '../src/jobs';
import { PITR_PREFIX, storeOps } from '../src/ops';
import { log } from '../src/store/verdicts';
import { findSource, getSource, sourceRefs } from '../src/store/sources';
import { SNAPSHOT_KEY } from '../src/store/list';
import type { Store } from '../src/store/store';

const files = inject('contract');
const keys = await importKeys([files.devPublicKey]);
const T = 1_900_000_000_000;
const S = T / 1000;

let client = 0;
/** Workers Cache as the edge sees it in ctx.cache: absent in local runtimes, so tests set it. */
let edgeCache: CacheContext | undefined;
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** POST /ops/<command> through the edge's fetch handler with the test OPS_TOKEN. */
async function op(command: string, body: unknown = {}, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const request = new IncomingRequest(`https://getcolander.com/ops/${command}`, {
		method: 'POST',
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
		headers: { Authorization: 'Bearer test-ops-token', 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++client % 250}`, ...init.headers }
	} as RequestInit<IncomingRequestCfProperties>);
	const res = await worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {}, cache: edgeCache } as unknown as ExecutionContext);
	expect(res.headers.get('Content-Type')).toBe('application/json');
	expect(res.headers.get('Cache-Control')).toBe('no-store');
	return { status: res.status, body: await res.json() };
}

const primary = () => env.STORE.getByName('primary');
let n = 0;
const fresh = () => env.STORE.getByName(`ops-${++n}`);

/** Runs one Store command directly, with the Store's clock at time. */
const inStore = (stub: DurableObjectStub<Store>, time: number, command: string, args: Record<string, unknown> = {}) =>
	runInDurableObject(stub, (store: Store, state) => {
		store.now = () => time;
		return storeOps(store, state, env, command, args);
	});

async function resetPrimary(): Promise<void> {
	await runInDurableObject(primary(), async (store: Store, state) => {
		store.db.tx(() => {
			store.db.run('PRAGMA defer_foreign_keys = ON');
			for (const t of ['tags', 'items', 'source_aliases', 'decision_log', 'decisions', 'escalations', 'reports', 'appeals', 'sources', 'installs', 'accounts', 'adapter_configs', 'list_sequences', 'jobs']) {
				store.db.run(`DELETE FROM ${t}`);
			}
		});
		for (const key of Object.values(STATUS)) state.storage.kv.delete(key);
		await state.storage.deleteAlarm();
	});
	await env.LISTS.delete(SNAPSHOT_KEY);
	for (const prefix of [DUMP_PREFIX, PITR_PREFIX]) for (const o of (await env.BACKUPS.list({ prefix })).objects) await env.BACKUPS.delete(o.key);
}

beforeEach(resetPrimary);
afterEach(() => {
	vi.restoreAllMocks();
	edgeCache = undefined;
});

describe('the channel', () => {
	it('answers only POST with a JSON object body, for the contract commands', async () => {
		expect((await op('nothing')).body.error.code).toBe('unknown_command');
		expect((await op('restart')).status, 'internal Store commands are not exposed').toBe(404);
		expect((await op('status', undefined, { method: 'GET', body: undefined })).status).toBe(405);
		for (const body of ['not json', '[]', '"x"', 'null']) {
			const res = await op('status', body);
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('invalid_body');
		}
	});
});

describe('status', () => {
	it('reports the heads, the job ages and how long the oldest list change has waited', async () => {
		await runInDurableObject(primary(), (store: Store, state) => {
			state.storage.kv.put(STATUS.pass, { at: T - 90_000, ms: 1, sources: 1, changes: 0, rowsRead: 1234 });
			state.storage.kv.put(STATUS.dump, { at: T - 3_600_000, ms: 870 });
			store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?), (?, ?)', S - 500, S - 500, S - 100, S - 100);
		});
		await env.LISTS.put(SNAPSHOT_KEY, 'x', { customMetadata: { seq: String(S - 500) } });
		expect((await inStore(primary(), T, 'status')).body).toEqual({
			head_seq: S - 100,
			r2_seq: S - 500,
			pass_age_s: 90,
			// R2 lacks the sequence published 100 seconds ago.
			publish_lag_s: 100,
			dump_age_s: 3600,
			dump_ms: 870,
			rows_read_last_pass: 1234
		});

		await env.LISTS.put(SNAPSHOT_KEY, 'x', { customMetadata: { seq: String(S - 100) } });
		expect((await inStore(primary(), T, 'status')).body.publish_lag_s, 'R2 holds the head').toBe(0);
		// A verdict change after the head that no sequence holds yet waits too.
		await runInDurableObject(primary(), (store: Store) => {
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at, verdict, changed_at) VALUES ('yt', '@changed', 1, 'slop', ?)", S - 40);
		});
		expect((await inStore(primary(), T, 'status')).body.publish_lag_s).toBe(40);

		// Through the edge, before any pass or dump: the probes fail on the nulls.
		await resetPrimary();
		const res = await op('status');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ head_seq: 0, r2_seq: 0, pass_age_s: null, publish_lag_s: 0, dump_age_s: null, dump_ms: null, rows_read_last_pass: null });
	});
});

describe('grant-role', () => {
	it('sets a role on a normalized email, creating the account', async () => {
		const res = await op('grant-role', { email: '  Sam@Example.COM ', role: 'curator' });
		expect(res.status).toBe(200);
		expect(res.body.account).toMatchObject({ email: 'sam@example.com', role: 'curator', display_name: null });
		expect(res.body.account.id).toMatch(/^acc_[a-z2-9]{16}$/);
		expect(res.body.account.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(res.body.message).toBe(`sam@example.com (${res.body.account.id}) is now curator.`);
		const again = await op('grant-role', { email: 'sam@example.com', role: 'staff' });
		expect(again.body.account).toMatchObject({ id: res.body.account.id, role: 'staff' });
	});

	it("trims as Go's strings.TrimSpace did: U+0085 is space, a byte order mark is not", async () => {
		expect((await op('grant-role', { email: '\u0085Nel@Example.com\u3000', role: 'member' })).body.account.email).toBe('nel@example.com');
		expect((await op('grant-role', { email: '\ufeffbom@example.com', role: 'member' })).body.account.email).toBe('\ufeffbom@example.com');
	});

	it.each([
		[{ email: 'Sam <sam@example.com>', role: 'staff' }, 'invalid_email', '"Sam <sam@example.com>" is not an email address.'],
		[{ email: 'not-an-email', role: 'staff' }, 'invalid_email', '"not-an-email" is not an email address.'],
		[{ role: 'staff' }, 'invalid_email', '"" is not an email address.'],
		[{ email: 'sam@example.com', role: 'admin' }, 'invalid_role', 'role must be member, curator or staff, not "admin".']
	])('refuses %j', async (args, code, message) => {
		const res = await op('grant-role', args);
		expect(res.status).toBe(400);
		expect(res.body.error).toEqual({ code, message });
	});
});

describe('import-seed', () => {
	const seed = '! A tiny synthetic list\n@SlopFarmOne\r\n\nUCzzzzzzzzzzzzzzzzzzzzz9\nnot a channel\n';
	const args = { file: seed, list: 'blocklist', source_name: 'AiSList', license: 'CC BY-NC 4.0' };

	it('refuses without accepting the license, and touches nothing', async () => {
		const res = await op('import-seed', args);
		expect(res.status).toBe(400);
		expect(res.body.error).toEqual({
			code: 'license_not_accepted',
			message: 'Refusing to import: AiSList is licensed CC BY-NC 4.0. Read its terms and set accept_license to true to confirm.'
		});
		expect(await runInDurableObject(primary(), (store: Store) => sourceRefs(store.db))).toEqual([]);
		for (const [bad, message] of [
			[{ ...args, file: '' }, 'file, source_name and license are required.'],
			[{ ...args, license: '' }, 'file, source_name and license are required.'],
			[{ ...args, list: 'greylist' }, 'list must be blocklist or warnlist.']
		] as const) {
			expect((await op('import-seed', { ...bad, accept_license: true })).body.error.message).toBe(message);
		}
	});

	// Go's TestImportSeed: imported blocklist entries are Likely slop at most until reviewed, with
	// the attribution kept; a warnlist import is AI evidence only.
	it('imports the whole file in one transaction, then the scoring pass rates it', async () => {
		const stub = fresh();
		const res = await inStore(stub, T, 'import-seed', { ...args, accept_license: true });
		expect(res).toEqual({
			status: 200,
			body: {
				imported: 2,
				skipped: 1,
				message: 'Imported 2 YouTube channels from AiSList (CC BY-NC 4.0) as blocklist entries, skipped 1 lines. The scoring pass starts now and publishes them.'
			}
		});
		await runInDurableObject(stub, async (store: Store) => {
			store.now = () => T;
			await store.engine.fullPass(T);
			const refs = sourceRefs(store.db);
			expect(refs).toHaveLength(2);
			for (const ref of refs) {
				const src = getSource(store.db, ref)!;
				expect(src).toMatchObject({ importSource: 'AiSList', importLicense: 'CC BY-NC 4.0', importList: 'blocklist' });
				expect(src.state.verdict).toBe('likely_slop');
				expect(src.state.flags & (1 << 5)).not.toBe(0);
			}
			expect(findSource(store.db, 'yt', '@slopfarmone'), 'the handle is lowercased to its canonical form').toBeDefined();
			const entries = log(store.db, { limit: 1 });
			expect(entries).toHaveLength(1);
			expect(entries[0]!.reason).toContain('AiSList');
		});
		await inStore(stub, T, 'import-seed', { file: '@aimadebutfine\n', list: 'warnlist', source_name: 'AiSList', license: 'CC BY-NC 4.0', accept_license: true });
		await runInDurableObject(stub, async (store: Store) => {
			await store.engine.fullPass(T);
			expect(getSource(store.db, findSource(store.db, 'yt', '@aimadebutfine')!)!.state.verdict).toBe('ai_made');
		});
	});

	it("reads lines as Go's import-seed did: a byte order mark stays, so that line is skipped; U+0085 is trimmed", async () => {
		const stub = fresh();
		const res = await inStore(stub, T, 'import-seed', { ...args, file: '\ufeff@BomFirst\n@NelChannel\u0085\n\u2003@Spaced\u3000\n', accept_license: true });
		expect(res.body).toMatchObject({ imported: 2, skipped: 1 });
		await runInDurableObject(stub, (store: Store) => {
			expect(findSource(store.db, 'yt', '@nelchannel')).toBeDefined();
			expect(findSource(store.db, 'yt', '@spaced')).toBeDefined();
			expect(findSource(store.db, 'yt', '@bomfirst')).toBeUndefined();
		});
	});

	it('starts the scoring pass at once in the primary Store', async () => {
		const res = await inStore(primary(), T, 'import-seed', { ...args, accept_license: true });
		expect(res.status).toBe(200);
		await runInDurableObject(primary(), async (store: Store, state) => {
			expect(store.db.all('SELECT name, due_at FROM jobs')).toEqual([{ name: 'pass', due_at: T }]);
			expect(await state.storage.getAlarm()).toBe(T);
		});
	});
});

describe('sign-config', () => {
	it('signs the file byte for byte with the Worker key, as the contract fixture shows', async () => {
		const file = '{"version":7,"note":"contract fixture"}';
		const res = await op('sign-config', { file });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			version: 7,
			key_id: '941afaf31a9c228e',
			message: 'Signed adapter configuration version 7 with key 941afaf31a9c228e. GET /v1/config/adapters now serves it.'
		});
		const stored = await runInDurableObject(primary(), (store: Store) => store.db.get<{ version: number; envelope: string }>('SELECT version, envelope FROM adapter_configs'));
		expect(stored!.version).toBe(7);
		expect(stored!.envelope).toBe(JSON.stringify(JSON.parse(files.configEnvelope)));
		expect(new TextDecoder().decode(b64decode(JSON.parse(stored!.envelope).payload))).toBe(file);
		expect(await verifyEnvelope(JSON.parse(stored!.envelope), CONFIG_CONTEXT, keys)).toEqual(JSON.parse(file));
	});

	it.each([
		['{"version": 12, "selectors": {"version": "x"}}', 12],
		['{"Version": "8"}', 8],
		['{"version": 1, "VERSION": 3}', 3],
		['{"version": -2}', -2],
		// Go's json.Decoder read the first object and ignored the rest; kept for parity.
		['  {"version": 9, "s": "}{\\"x"} and then {not json', 9]
	])('reads the version of %s as Go did', async (file, version) => {
		const res = await inStore(fresh(), T, 'sign-config', { file });
		expect(res.status).toBe(200);
		expect(res.body.version).toBe(version);
	});

	it.each([
		['[1]', 'The file is not a JSON object.'],
		['not json', 'The file is not a JSON object.'],
		['{"version": true}', 'The file is not a JSON object.'],
		['{"version": "seven"}', 'The file is not a JSON object.'],
		['null', 'The file needs a top-level integer version.'],
		['{"note": 1}', 'The file needs a top-level integer version.'],
		['{"version": 7.5}', 'The file needs a top-level integer version.'],
		['{"version": 7.0}', 'The file needs a top-level integer version.'],
		['{"version": 1e3}', 'The file needs a top-level integer version.'],
		['{"version": "7.5"}', 'The file needs a top-level integer version.'],
		['', 'file is required: the adapter configuration JSON.']
	])('refuses %s', async (file, message) => {
		const res = await inStore(fresh(), T, 'sign-config', { file });
		expect(res.status).toBe(400);
		expect((res.body.error as { message: string }).message).toBe(message);
	});
});

describe('restores', () => {
	/** Puts a source on the list and publishes, so R2 holds a head. */
	async function publishOne(alias: string): Promise<number> {
		return runInDurableObject(primary(), async (store: Store) => {
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at, verdict, changed_at) VALUES ('yt', ?, 1, 'slop', 1)", alias);
			const id = store.db.get<{ id: number }>('SELECT id FROM sources WHERE canonical_id = ?', alias)!.id;
			store.db.run("INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', ?, ?)", alias, id);
			return (await store.publisher.publish(Date.now())).seq;
		});
	}

	it('pitr-restore needs the time typed twice, in the last 30 days', async () => {
		const now = new Date(Date.now() - 60_000).toISOString();
		for (const [args, code] of [
			[{ at: now }, 'confirmation_required'],
			[{ at: now, confirm: now.replace('Z', '+00:00') }, 'confirmation_required'],
			[{ at: 'yesterday', confirm: 'yesterday' }, 'invalid_time'],
			[{ at: '2020-01-01T00:00:00Z', confirm: '2020-01-01T00:00:00Z' }, 'invalid_time'],
			[{ at: '2999-01-01T00:00:00Z', confirm: '2999-01-01T00:00:00Z' }, 'invalid_time']
		] as const) {
			const res = await op('pitr-restore', args);
			expect(res.status, JSON.stringify(args)).toBe(400);
			expect(res.body.error.code).toBe(code);
		}
	});

	/** Local runtimes keep no history, so the two PITR calls are stand-ins; the marker shows a restart. */
	const standIns = (asked: number[] = []) =>
		runInDurableObject(primary(), (store: Store, state) => {
			Object.assign(state.storage, {
				getBookmarkForTime: async (t: number) => (asked.push(t), 'bookmark-at'),
				onNextSessionRestoreBookmark: async (b: string) => `undo-before-${b}`
			});
			(store as unknown as { marker: string }).marker = 'old instance';
		});
	const marker = () => runInDurableObject(primary(), (store: Store) => (store as unknown as { marker?: string }).marker);

	it('pitr-restore arms the bookmark, restarts the Store, publishes above R2 and purges the edge cache', async () => {
		const erased = await publishOne('@before');
		const at = new Date(Date.now() - 3_600_000).toISOString();
		const asked: number[] = [];
		await standIns(asked);
		const purge = vi.fn(async () => ({ success: true, errors: [] }));
		edgeCache = { purge, invalidate: purge } as unknown as CacheContext;
		const res = await op('pitr-restore', { at, confirm: at });
		expect(res.status).toBe(200);
		expect(asked).toEqual([Date.parse(at)]);
		expect(res.body).toMatchObject({ at, bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at', r2_seq: res.body.head_seq, cache_purged: true });
		expect(res.body.head_seq).toBeGreaterThanOrEqual(erased);
		expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
		expect(await marker(), 'the Store restarted').toBeUndefined();
		const records = (await env.BACKUPS.list({ prefix: PITR_PREFIX })).objects;
		expect(records).toHaveLength(1);
		expect(await (await env.BACKUPS.get(records[0]!.key))!.json()).toEqual({ bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at' });
	});

	it('pitr-restore restarts the Store in the same call that arms it, so no armed restore waits for a later restart', async () => {
		await standIns();
		const record = `${PITR_PREFIX}direct.json`;
		await expect(inStore(primary(), T, 'pitr-restore', { at: T - 3_600_000, record })).rejects.toThrow();
		expect(await marker(), 'the Store restarted without a second call').toBeUndefined();
		expect(await (await env.BACKUPS.get(record))!.json()).toEqual({ bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at' });
	});

	it('restore-dump replaces the data with a dump, then restarts, publishes above R2 and reports an unpurged cache', async () => {
		await publishOne('@kept');
		const key = await runInDurableObject(primary(), async (store: Store, state) => (await dump(state, store.db, env.BACKUPS, Date.now())).key);
		const lost = await publishOne('@lost');
		expect((await op('restore-dump', { key })).body.error.code).toBe('confirmation_required');
		expect((await op('restore-dump', { key: 'dumps/none', confirm: 'dumps/none' })).status).toBe(404);

		const res = await op('restore-dump', { key, confirm: key });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ key, rows: { sources: 1, source_aliases: 1 }, cache_purged: false });
		expect(res.body.head_seq).toBeGreaterThan(lost);
		expect(res.body.r2_seq).toBe(res.body.head_seq);
		await runInDurableObject(primary(), (store: Store) => {
			expect(store.db.all('SELECT canonical_id FROM sources')).toEqual([{ canonical_id: '@kept' }]);
		});
	});

	it('purge-cache needs the typed word, and says when the cache refused', async () => {
		expect((await op('purge-cache')).body.error.code).toBe('confirmation_required');
		expect((await op('purge-cache', { confirm: 'purge-cache' })).body).toEqual({ purged: false, reason: 'This runtime has no Workers Cache to purge.' });
		edgeCache = { purge: async () => ({ success: true, errors: [] }) } as unknown as CacheContext;
		expect(await op('purge-cache', { confirm: 'purge-cache' })).toEqual({ status: 200, body: { purged: true } });
		edgeCache = { purge: async () => ({ success: false, errors: [{ code: 1134, message: 'rate limited' }] }) } as unknown as CacheContext;
		const refused = await op('purge-cache', { confirm: 'purge-cache' });
		expect(refused.status).toBe(502);
		expect(refused.body).toMatchObject({ error: { code: 'purge_failed' }, errors: [{ code: 1134, message: 'rate limited' }] });
	});
});

describe('drill', () => {
	async function dumpPrimary(at = Date.now()): Promise<string> {
		return runInDurableObject(primary(), async (store: Store, state) => (await dump(state, store.db, env.BACKUPS, at)).key);
	}
	const sources = (count: number) =>
		runInDurableObject(primary(), (store: Store) =>
			store.db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO sources (platform, canonical_id, created_at) SELECT 'tt', '@s' || i || '-' || random(), 1 FROM n`,
				count
			)
		);

	it('fails without a dump', async () => {
		const res = await op('drill');
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ error: { code: 'drill_failed', message: 'There is no dump in the backup bucket.' }, ok: false });
	});

	it('loads the newest dump into the scratch Store, checks it against primary and deletes it', async () => {
		await sources(300);
		await dumpPrimary(Date.now() - 3_600_000);
		const key = await dumpPrimary();
		const res = await op('drill');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, key, quick_check: ['ok'], foreign_key_violations: 0 });
		expect(res.body.age_s).toBeLessThan(60);
		expect(res.body.tables.sources).toEqual({ dump: 300, primary: 300, ok: true });
		expect(Object.values(res.body.tables).every((t: any) => t.ok)).toBe(true);
		const left = await runInDurableObject(env.STORE.getByName('drill'), (store: Store) =>
			store.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'")
		);
		expect(left, 'the scratch data is gone').toEqual([]);
		// The scratch Store migrates again for the next drill.
		expect((await op('drill')).status).toBe(200);
	});

	it('fails on a stale dump or counts that drifted too far', async () => {
		await dumpPrimary();
		await sources(300);
		const drifted = await op('drill');
		expect(drifted.status).toBe(500);
		expect(drifted.body.ok).toBe(false);
		expect(drifted.body.tables.sources).toEqual({ dump: 0, primary: 300, ok: false });
		expect(drifted.body.error.message).toBe('Table sources has 0 rows in the dump and 300 in primary.');

		await dumpPrimary();
		const later = Date.now() + 7 * 3_600_000;
		vi.spyOn(Date, 'now').mockReturnValue(later);
		const stale = await op('drill');
		expect(stale.status).toBe(500);
		expect(stale.body.error.message).toMatch(/^The newest dump is 7\.0 hours old\.$/);
	});

	it('never loads a dump into primary', async () => {
		const key = dumpKey(T);
		expect((await inStore(primary(), T, 'drill-check', { key })).status).toBe(409);
	});
});
