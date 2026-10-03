// List publication (src/list/publisher.ts with store/list.ts): the port of what Go's api, engine
// and listfmt tests checked about publication, plus the Workers rules: sequences floored to unix
// seconds that never go backwards, the snapshot in R2 and its reconciliation.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { hex } from '@colander/shared/bytes';
import { keyHash } from '@colander/shared/ids';
import { dayNumber, encodeList, ENTRY, FLAG_ITEM, verifyList, type ListFile } from '@colander/shared/list';
import { importKeys, SigningKey } from '@colander/shared/signing';
import { b64decode } from '@colander/shared/bytes';
import { placeholders, type Db } from '../src/store/db';
import { SNAPSHOT_KEY } from '../src/store/list';
import { ensureItem, ensureSource, getSource, findItem, type State } from '../src/store/sources';
import { applyUpdate } from '../src/store/verdicts';
import type { Store } from '../src/store/store';

const files = inject('contract');
const keys = await importKeys([files.devPublicKey]);
const T = 1_900_000_000_000;
const S = T / 1000;
const DAY = 86_400;

let n = 0;
const fresh = () => env.STORE.getByName(`pub-${++n}`);

const state = (verdict: string, over: Partial<State> = {}): State => ({
	verdict,
	signals: 0,
	detail: 0,
	flags: 0,
	changedAt: S,
	rescoreAt: 0,
	lapseHold: false,
	computed: '',
	mixed: false,
	...over
});

/** Gives a source (and optionally one of its items) a list verdict, as the scoring engine does. */
function rate(db: Db, platform: string, alias: string, verdict: string, over: Partial<State> = {}): number {
	const ref = ensureSource(db, platform, alias, '', 1);
	applyUpdate(db, { sourceRef: ref, itemRef: 0, expect: getSource(db, ref)!.state.verdict, state: state(verdict, over) });
	return ref;
}

function rateItem(db: Db, platform: string, sourceRef: number, itemId: string, verdict: string): void {
	const item = ensureItem(db, platform, itemId, sourceRef, 1);
	applyUpdate(db, { sourceRef, itemRef: item, expect: findItem(db, platform, itemId)!.state.verdict, state: state(verdict) });
}

async function r2Snapshot(): Promise<{ file: ListFile; seq: string; created: string } | null> {
	const obj = await env.LISTS.get(SNAPSHOT_KEY);
	if (!obj) return null;
	const file = await verifyList(new Uint8Array(await obj.arrayBuffer()), keys);
	expect(obj.httpMetadata?.contentType).toBe('application/octet-stream');
	return { file, seq: obj.customMetadata!.seq!, created: obj.customMetadata!.created! };
}

const hashes = (file: ListFile) => Array.from({ length: file.count }, (_, i) => hex(file.entries.subarray(i * ENTRY, i * ENTRY + 8)));
const has = (file: ListFile, key: string) => hashes(file).includes(hex(keyHash(key)));

async function decode(res: Response): Promise<ListFile> {
	return verifyList(new Uint8Array(await res.arrayBuffer()), keys);
}

beforeEach(() => env.LISTS.delete(SNAPSHOT_KEY));

describe('publish', () => {
	it('writes the rated targets to R2 as a signed snapshot whose sequence is the unix time', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			rate(store.db, 'yt', '@alpha', 'slop');
			rate(store.db, 'tt', '@beta', 'clear', { flags: 0x40 });
			const seq = await store.publisher.publish(T + 999);
			expect(seq).toEqual({ seq: S, createdAt: S });
			const snap = (await r2Snapshot())!;
			expect([snap.seq, snap.created]).toEqual([String(S), String(S)]);
			expect([snap.file.kind, snap.file.sequence, snap.file.created, snap.file.count]).toEqual(['snapshot', S, S, 2]);
			expect(has(snap.file, 'yt:s:@alpha') && has(snap.file, 'tt:s:@beta')).toBe(true);
			// Nothing changed: no new sequence and no new upload.
			const etag = (await env.LISTS.head(SNAPSHOT_KEY))!.etag;
			expect(await store.publisher.publish(T + 30_000)).toEqual({ seq: S, createdAt: S });
			expect((await env.LISTS.head(SNAPSHOT_KEY))!.etag).toBe(etag);
		});
	});

	it('publishes an empty list the first time, so installs have a base', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			expect(await store.publisher.publish(T)).toEqual({ seq: S, createdAt: S });
			expect((await r2Snapshot())!.file.count).toBe(0);
		});
	});

	// Go's TestDeltaStatuses, at the publisher.
	it('serves 204 at the head, the coalesced delta from an older base, and 410 otherwise', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			const p = store.publisher;
			rate(store.db, 'yt', '@alpha', 'slop');
			const s1 = (await p.publish(T)).seq;
			expect((await p.delta(s1, S)).status).toBe(204);

			rate(store.db, 'tt', '@petpalsai', 'slop');
			const s2 = (await p.publish(T + 20_000)).seq;
			expect(s2).toBe(S + 20);
			const res = await p.delta(s1, S + 20);
			expect(res.status).toBe(200);
			expect(res.headers.get('X-Colander-Sequence')).toBe(String(s2));
			const delta = await decode(res);
			expect([delta.kind, delta.base, delta.sequence, delta.count]).toEqual(['delta', s1, s2, 1]);
			expect(has(delta, 'tt:s:@petpalsai')).toBe(true);
			for (const since of [999, 0, s2 + 1]) expect((await p.delta(since, S + 20)).status, `since=${since}`).toBe(410);
			// Sequences older than 30 days are gone too.
			expect((await p.delta(s1, S + 31 * DAY)).status).toBe(410);
			const snap = (await p.currentSnapshot())!;
			expect(snap.seq).toBe(s2);
			expect((await verifyList(snap.bytes, keys)).count).toBe(2);
		});
	});

	it('records a removal with verdict 0, the platform and item bits, and today', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			const src = rate(store.db, 'ig', 'natgeo', 'clear');
			rateItem(store.db, 'ig', src, 'Cabc12345', 'slop');
			const s1 = (await store.publisher.publish(T)).seq;
			applyUpdate(store.db, { sourceRef: src, itemRef: findItem(store.db, 'ig', 'Cabc12345')!.ref, expect: 'slop', state: state('') });
			await store.publisher.publish(T + 3 * DAY * 1000);
			const delta = await decode(await store.publisher.delta(s1, S + 3 * DAY));
			expect(delta.count).toBe(1);
			const e = delta.entries;
			expect(hex(e.subarray(0, 8))).toBe(hex(keyHash('ig:i:Cabc12345')));
			expect([e[8], e[9], e[10], e[11], e[12]]).toEqual([0, 2 | FLAG_ITEM, 0, 0, 0]);
			expect(e[14]! | (e[15]! << 8)).toBe(dayNumber(S + 3 * DAY));
			expect((await r2Snapshot())!.file.count).toBe(1);
		});
	});

	// The publication half of Go's TestMixedSourceItems.
	it('lists an item only when its verdict differs from its source or its source is mixed', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			const mixed = rate(store.db, 'yt', '@mixedchan', 'ai_made', { mixed: true });
			for (let i = 0; i < 3; i++) rateItem(store.db, 'yt', mixed, `mixedItem0${i}`, 'ai_made');
			const plain = rate(store.db, 'yt', '@plainchan', 'slop');
			rateItem(store.db, 'yt', plain, 'plainItem01', 'slop');
			rateItem(store.db, 'yt', plain, 'plainItem02', 'clear');
			await store.publisher.publish(T);
			const snap = (await r2Snapshot())!.file;
			for (let i = 0; i < 3; i++) expect(has(snap, `yt:i:mixedItem0${i}`), `item ${i}`).toBe(true);
			expect(has(snap, 'yt:i:plainItem01')).toBe(false);
			expect(has(snap, 'yt:i:plainItem02')).toBe(true);
			expect(snap.count).toBe(6);
		});
	});
});

const RESTORED = ['sources', 'source_aliases', 'list_sequences', 'list_entries', 'list_changes'];

function saveTables(db: Db): Record<string, Record<string, SqlStorageValue>[]> {
	return Object.fromEntries(RESTORED.map((t) => [t, db.all(`SELECT * FROM ${t}`)]));
}

/** Puts the tables back as they were: what a point-in-time restore does to the list. */
function restoreTables(db: Db, saved: Record<string, Record<string, SqlStorageValue>[]>): void {
	db.tx(() => {
		for (const t of [...RESTORED].reverse()) db.run(`DELETE FROM ${t}`);
		for (const t of RESTORED) {
			for (const row of saved[t]!) {
				const cols = Object.keys(row);
				db.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`, ...Object.values(row));
			}
		}
	});
}

describe('sequence monotonicity', () => {
	it('never goes backwards: not with the clock behind the head, not after a restore behind R2', async () => {
		const stub = fresh();
		const saved = await runInDurableObject(stub, async (store: Store) => {
			rate(store.db, 'yt', '@a', 'slop');
			expect((await store.publisher.publish(T)).seq).toBe(S);
			return saveTables(store.db);
		});
		const s3 = await runInDurableObject(stub, async (store: Store) => {
			rate(store.db, 'yt', '@b', 'slop');
			expect((await store.publisher.publish(T + 60_000)).seq).toBe(S + 60);
			// The clock runs behind the head: head + 1, not the time.
			rate(store.db, 'yt', '@c', 'slop');
			const s3 = (await store.publisher.publish(T - 3_600_000)).seq;
			expect(s3).toBe(S + 61);
			// The database goes back to the first publication; R2 still holds s3.
			restoreTables(store.db, saved);
			return s3;
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, async (store: Store) => {
			// Nothing differs from the restored list, and the clock is before s2 and s3, yet the new
			// sequence must be above every number an install may hold.
			const s4 = (await store.publisher.publish(T + 30_000)).seq;
			expect(s4).toBe(s3 + 1);
			const snap = (await r2Snapshot())!;
			expect(snap.seq).toBe(String(s4));
			expect([has(snap.file, 'yt:s:@a'), has(snap.file, 'yt:s:@b'), has(snap.file, 'yt:s:@c')]).toEqual([true, false, false]);
			// An install that held s3 (or s2) gets 410 and refetches a snapshot it accepts, being newer.
			for (const since of [s3, S + 60]) expect((await store.publisher.delta(since, S + 30)).status).toBe(410);
			// One that held s1 gets a delta to s4 with nothing in it.
			const delta = await decode(await store.publisher.delta(S, S + 30));
			expect([delta.base, delta.sequence, delta.count]).toEqual([S, s4, 0]);
		});
	});
});

describe('R2 reconciliation', () => {
	it('rewrites a lost or lagging R2 snapshot without a new sequence', async () => {
		await runInDurableObject(fresh(), async (store: Store) => {
			rate(store.db, 'yt', '@a', 'slop');
			await store.publisher.publish(T);
			await env.LISTS.delete(SNAPSHOT_KEY);
			expect(await store.publisher.publish(T + 15_000)).toEqual({ seq: S, createdAt: S });
			expect((await r2Snapshot())!.seq).toBe(String(S));
			await env.LISTS.put(SNAPSHOT_KEY, new Uint8Array([1]), { customMetadata: { seq: String(S - 5) } });
			expect((await store.publisher.publish(T + 30_000)).seq).toBe(S);
			expect((await r2Snapshot())!.file.count).toBe(1);
		});
	});

	it('serves its head snapshot to the edge when R2 misses, and 503 before any publication', async () => {
		const stub = fresh();
		const before = await stub.fetch('https://store/v1/list/snapshot');
		expect(before.status).toBe(503);
		expect(before.headers.get('Retry-After')).toBe('30');
		expect(((await before.json()) as { error: { code: string } }).error.code).toBe('list_unavailable');
		await runInDurableObject(stub, async (store: Store) => {
			rate(store.db, 'yt', '@a', 'slop');
			await store.publisher.publish(T);
		});
		const res = await stub.fetch('https://store/v1/list/snapshot');
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Colander-Sequence')).toBe(String(S));
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
		expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=15, stale-if-error=86400');
		expect(res.headers.get('x-colander-route')).toBe('GET /v1/list/snapshot');
		expect((await decode(res)).count).toBe(1);
	});

	it('publishes above an R2 snapshot that is ahead when the primary Store starts', async () => {
		const stub = env.STORE.getByName('primary');
		const ahead = Math.floor(Date.now() / 1000) + 5000;
		await runInDurableObject(stub, async (store: Store) => {
			rate(store.db, 'yt', '@a', 'slop');
			await store.publisher.publish(Date.now());
			// A Store that has run jobs before reconciles on start.
			store.jobs.ensure(Date.now() + 3_600_000);
			await store.jobs.arm();
			// R2 is ahead, as after a restore of the database.
			await env.LISTS.put(SNAPSHOT_KEY, new Uint8Array([1]), { customMetadata: { seq: String(ahead) } });
		});
		await evictDurableObject(stub);
		expect(await stub.health()).toBeGreaterThan(0);
		// The start scheduled a publication due now; run it unless the alarm already fired.
		await runDurableObjectAlarm(stub);
		await vi.waitFor(async () => expect((await r2Snapshot())?.seq).toBe(String(ahead + 1)), { timeout: 10_000 });
	});
});

describe('list format', () => {
	// Go's TestSnapshotSize: a full sync of 50,000 sources stays under 2 MB, even with two aliases each.
	it('keeps a 100,000-entry snapshot under 2 MB', async () => {
		const key = await SigningKey.fromSeed(b64decode(files.devSeed));
		const rows: Uint8Array[] = [];
		const seen = new Set<string>();
		while (rows.length < 100_000) {
			const row = new Uint8Array(ENTRY);
			crypto.getRandomValues(row.subarray(0, 8));
			const h = hex(row.subarray(0, 8));
			if (seen.has(h)) continue;
			seen.add(h);
			row[8] = 1;
			row[10] = row[11] = 0xff;
			rows.push(row);
		}
		const bytes = await encodeList(key, { kind: 'snapshot', sequence: 1, base: 0, created: S }, rows);
		expect(bytes.length).toBe(32 + ENTRY * rows.length + 72);
		expect(bytes.length).toBeLessThan(2 << 20);
		expect((await verifyList(bytes, keys)).count).toBe(100_000);
	});
});
