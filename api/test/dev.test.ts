// Dev routes (src/dev.ts): the demo seed, a port of Go's TestSeedDev, the settle that replaces
// the Go server's start, the dump route, and COLANDER_TEST_NOW.
import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { describe, expect, inject, it, vi } from 'vitest';
import { keyHash, targetKey } from '@colander/shared/ids';
import { decodeEntry, ENTRY, FLAG_IMPORTED, FLAG_LARGE, verifyList } from '@colander/shared/list';
import { importKeys } from '@colander/shared/signing';
import { hex } from '@colander/shared/bytes';
import type { Platform } from '@colander/shared/verdicts';
import { testNow } from '../src/dev';
import worker from '../src/index';
import { Sig } from '../src/scoring/rules';
import { AppealAwaiting, AppealDenied, AppealExpired, AppealPendingManual, appealsWithStatus, AppealUnderReview, AppealUpheld } from '../src/store/appeals';
import { SNAPSHOT_KEY } from '../src/store/list';
import { findSource, getSource } from '../src/store/sources';
import { openReports, reportsBySource } from '../src/store/tags';
import { verdictCounts } from '../src/store/misc';
import { openEscalations } from '../src/store/verdicts';
import type { Store } from '../src/store/store';
import type { YouTube } from '../src/youtube';

const keys = await importKeys([inject('contract').devPublicKey]);
const stub = env.STORE.getByName('seed');
const post = (path: string) => stub.fetch(`https://store${path}`, { method: 'POST' });

describe('/__dev/seed', () => {
	it("scores without a YouTube client, as Go's seed-dev did, and gives the Store's back", async () => {
		const seeded = env.STORE.getByName('seed-youtube');
		const enrichStale = vi.fn(async () => {});
		const client = { enrichStale } as unknown as YouTube;
		await runInDurableObject(seeded, (store: Store) => void (store.engine.youtube = client));
		expect((await seeded.fetch('https://store/__dev/seed', { method: 'POST' })).status).toBe(200);
		expect(enrichStale, 'the seed reached no Data API').not.toHaveBeenCalled();
		await runInDurableObject(seeded, async (store: Store) => {
			expect(store.engine.youtube).toBe(client);
			// Settling afterwards is the Go server's start, which does enrich.
			await store.engine.fullPass(store.now());
		});
		expect(enrichStale).toHaveBeenCalledOnce();
		// The seed published; the next test's Store starts from an empty bucket, as in production.
		await env.LISTS.delete(SNAPSHOT_KEY);
	});

	// Go's TestSeedDev: every verdict and appeal state, settled (a further pass changes nothing),
	// and the contract fixture targets with the verdicts the extension's tests expect.
	it('fills an empty Store with every verdict and appeal state, once', async () => {
		const res = await post('/__dev/seed');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sources: Record<string, number>; items: number; sequence: number; reviewers: unknown[]; awaiting_link: string };
		expect(body.reviewers).toEqual([
			{ email: 'rae@colander.test', role: 'staff' },
			{ email: 'sam@colander.test', role: 'curator' }
		]);
		expect(body.awaiting_link).toMatch(/^\/appeal\/status\/apl_[a-z2-9]{16}\?secret=[\w-]{43}$/);
		const again = await post('/__dev/seed');
		expect(again.status).toBe(409);
		expect(((await again.json()) as { error: { code: string } }).error.code).toBe('already_seeded');

		await runInDurableObject(stub, async (store: Store) => {
			const db = store.db;
			const { counts } = verdictCounts(db);
			expect(counts).toEqual(body.sources);
			for (const [v, n] of Object.entries(counts)) expect(n, `no source is ${v}`).toBeGreaterThan(0);
			for (const status of [AppealAwaiting, AppealPendingManual, AppealUnderReview, AppealUpheld, AppealDenied, AppealExpired]) {
				expect(appealsWithStatus(db, status).length, `no appeal is ${status}`).toBeGreaterThan(0);
			}
			expect(openReports(db).length).toBeGreaterThan(0);
			// The curator journey in e2e/ decides Fitness Tips AI from an open report in the side panel.
			const fitness = reportsBySource(db, findSource(db, 'ig', 'fitness.tips.ai')!);
			expect(fitness.map((r) => r.status)).toEqual(['open']);
			expect(db.get<{ n: number }>("SELECT count(*) AS n FROM reports WHERE status = 'decided'")!.n).toBeGreaterThan(0);
			const escalations = new Set(openEscalations(db).map((e) => `${e.kind}: ${e.summary}`));
			expect(escalations).toContain('capped: Scores as Slop, held at Likely slop: audience size unknown, needs staff review');
			expect(escalations).toContain('appeal: Appeal filed more than 14 days ago still waits for staff to check its code');

			const seedEnd = Math.floor(Date.now() / 1000);
			expect(await store.engine.fullPass(seedEnd * 1000), 'a pass after seeding changes nothing').toBe(0);

			const head = await store.publisher.publish(seedEnd * 1000);
			expect(head.seq).toBe(body.sequence);
			const snap = await verifyList((await store.publisher.currentSnapshot())!.bytes, keys);
			const byHash = new Map<string, number>();
			for (let at = 0; at < snap.entries.length; at += ENTRY) byHash.set(hex(snap.entries.subarray(at, at + 8)), at);
			const entry = (key: string) => {
				const [platform, type, ...id] = key.split(':');
				const at = byHash.get(hex(keyHash(targetKey(platform as Platform, type === 's' ? 'source' : 'item', id.join(':')))));
				return at === undefined ? undefined : { hit: decodeEntry(snap.entries, at)!, flags: snap.entries[at + 9]!, signals: snap.entries[at + 10]! | (snap.entries[at + 11]! << 8) };
			};
			for (const [key, want] of Object.entries({
				'yt:s:@aihistorydaily': 'slop',
				'yt:s:UCaaaaaaaaaaaaaaaaaaaaaa': 'slop',
				'yt:s:@catrescuetales': 'likely_slop',
				'tt:s:@sloppyfacts': 'disputed',
				'ig:s:handmadepottery': 'clear',
				'fb:i:pfbid02abcDEF': 'slop',
				'tt:i:7412345678901234567': 'likely_slop',
				'tt:s:@petpalsai': 'slop',
				'fb:s:100087654321098': 'likely_slop',
				'yt:s:@galaxyfacts4k': 'ai_made',
				// a mixed source keeps its items' entries
				'yt:i:demoGF00000': 'ai_made'
			})) {
				expect(entry(key)?.hit.verdict, key).toBe(want);
			}
			const sloppy = entry('tt:s:@sloppyfacts')!;
			expect(sloppy.flags & FLAG_LARGE, '@sloppyfacts is large').not.toBe(0);
			expect(sloppy.signals & Sig.open_appeal, '@sloppyfacts has an open appeal').not.toBe(0);
			// Seed lists put nothing on the list: flag bit 5 stays 0, and a source only a seed list
			// names has no entry, only a review lead.
			for (let at = 0; at < snap.entries.length; at += ENTRY) expect(snap.entries[at + 9]! & FLAG_IMPORTED).toBe(0);
			expect(entry('yt:s:@dailymotivationmachine')).toBeUndefined();
			expect(escalations).toContain('seed: Seed lead, not evidence: listed on Demo list (CC0-1.0) as a blocklist entry');
			// The journeys in e2e/: staff recorded @gossipnarrated as large, and a viewer reported it since.
			const gossip = getSource(db, findSource(db, 'yt', '@gossipnarrated')!)!;
			expect(gossip).toMatchObject({ largeStaff: true, name: 'Celebrity Gossip Narrated' });
			expect(reportsBySource(db, gossip.ref).map((r) => r.status)).toEqual(['open']);
			expect(entry('yt:s:@gossipnarrated')!.flags & FLAG_LARGE).not.toBe(0);
		});
	});
});

describe('/__dev/settle', () => {
	it('publishes, scores everything and publishes again, as the Go server did when it started', async () => {
		const other = env.STORE.getByName('settle');
		// A fresh deployment: the seed's publication above came from another Store.
		await env.LISTS.delete(SNAPSHOT_KEY);
		await runInDurableObject(other, (store: Store) => {
			// What the old rules left on the list for a seed alone, which this settle takes off.
			store.db.run(
				"INSERT INTO sources (platform, canonical_id, created_at, import_list, import_source, import_license, imported_at, verdict, signals, flags, changed_at) VALUES ('yt', '@imported', 1, 'blocklist', 'Demo', 'CC0', 1, 'likely_slop', 32, 32, 1)"
			);
			const id = store.db.get<{ id: number }>('SELECT id FROM sources')!.id;
			store.db.run("INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', '@imported', ?)", id);
		});
		const res = await other.fetch('https://store/__dev/settle', { method: 'POST' });
		const body = (await res.json()) as { changed: number; head_seq: number };
		expect(body.changed).toBe(1);
		expect(body.head_seq).toBeGreaterThan(0);
		expect(((await (await other.fetch('https://store/__dev/settle', { method: 'POST' })).json()) as typeof body)).toEqual({ changed: 0, head_seq: body.head_seq });
	});

	it.each(['seed', 'settle'])('%s answers while another publication still waits on R2, as one from the publish job', async (route) => {
		const busy = env.STORE.getByName(`${route}-busy`);
		// R2 answers that publication only after the request below has started; inside
		// blockConcurrencyWhile it would never get the answer, and the Store would reset.
		const publishing = runInDurableObject(busy, (store: Store) => {
			const publisher = store.publisher as unknown as { bucket: R2Bucket };
			const head = publisher.bucket.head.bind(publisher.bucket);
			publisher.bucket = Object.assign(Object.create(publisher.bucket) as R2Bucket, {
				head: async (key: string) => (await scheduler.wait(200), head(key))
			});
			return store.publisher.publish(store.now());
		});
		const res = await busy.fetch(`https://store/__dev/${route}`, { method: 'POST' });
		expect(res.status).toBe(200);
		await expect(publishing).resolves.toMatchObject({ seq: expect.any(Number) });
	});
});

describe('COLANDER_TEST_NOW', () => {
	it('freezes the clock only in dev mode, and only with an RFC 3339 time', () => {
		const at = (COLANDER_DEV: string, COLANDER_TEST_NOW?: string) => testNow({ ...env, COLANDER_DEV, COLANDER_TEST_NOW } as Env);
		expect(at('1')).toBeUndefined();
		expect(at('', '2026-05-01T12:00:00Z')).toBeUndefined();
		expect(at('1', '2026-05-01T12:00:00Z')).toBe(Date.UTC(2026, 4, 1, 12));
		expect(at('1', '2026-05-01T14:00:00+02:00')).toBe(Date.UTC(2026, 4, 1, 12));
		expect(() => at('1', 'yesterday')).toThrow(/RFC 3339/);
		expect(() => at('1', '2026-05-01')).toThrow(/RFC 3339/);
	});

	it('moves the edge check on since with the frozen clock', async () => {
		const since = Date.UTC(2026, 4, 1, 12) / 1000 + 61;
		const delta = (overrides: Record<string, string>) =>
			worker.fetch(new Request(`https://getcolander.com/v1/list/delta?since=${since}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }) as Request<unknown, IncomingRequestCfProperties>, { ...env, ...overrides } as Env, createExecutionContext());
		expect((await delta({ COLANDER_TEST_NOW: '2026-05-01T12:00:00Z' })).status).toBe(400);
		expect((await delta({ COLANDER_TEST_NOW: '2026-05-01T12:00:01Z' })).status).not.toBe(400);
	});
});

describe('/__dev/dump', () => {
	it('answers the SQL dump the backups write, uncompressed', async () => {
		const res = await env.STORE.getByName('nodev').fetch('https://store/__dev/dump');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/sql; charset=utf-8');
		// application/sql is not a type workerd reads as text, so decode the bytes.
		expect(new TextDecoder().decode(await res.arrayBuffer())).toMatch(/^-- Colander Store dump, schema version 5, taken .*\nCOMMIT;\n$/s);
	});
});
