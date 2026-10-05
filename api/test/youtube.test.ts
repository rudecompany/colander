// The YouTube Data API client (src/youtube.ts): the port of server/internal/youtube/youtube_test.go
// against a fake API, plus the client in the Store: enrichment at the start of each scoring pass
// and automatic appeal verification. The fake replaces fetch, as Go's test used httptest. Also the
// API terms: the Pacific-day quota ledger, the derived-use gate and deletion before 30 days.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appeal } from '@colander/shared/api';
import { API_DATA_TABLES, dumpLines } from '../src/backup';
import { ACCESS_EMAIL_HEADER, HOST_HEADER, IP_HASH_HEADER } from '../src/http';
import { prune } from '../src/jobs';
import { rfc3339 } from '../src/routes/respond';
import { unix } from '../src/scoring/engine';
import { grantRole } from '../src/store/accounts';
import { youTubeQuotaUsed } from '../src/store/misc';
import { ensureSource, findSource, getSource, setYouTube, sourceRefs } from '../src/store/sources';
import type { Store } from '../src/store/store';
import { BACKGROUND_SHARE, ENRICH_PER_PASS, pacificDay, YouTube, YouTubeNotFoundError, YouTubeQuotaError } from '../src/youtube';

const CHANNEL = 'UCzzzzzzzzzzzzzzzzzzzzz7';
const BASE = 'https://fake-youtube.test';
const NOW = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Go's fakeAPI: one channel with 28 uploads in the last 14 days, over two pages. It answers 403
 * without the test key, 500 for @broken, YouTube's quotaExceeded 403 for @overquota, and counts
 * calls per path.
 */
function fakeAPI(now: number, description: { text: string }) {
	const paths: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== BASE) throw new Error(`unexpected fetch to ${url.origin}`);
		paths.push(url.pathname);
		const q = url.searchParams;
		if (q.get('key') !== 'test-key') return new Response(null, { status: 403 });
		switch (url.pathname) {
			case '/channels':
				if (q.get('forHandle') === '@broken') return new Response('backend error', { status: 500 });
				if (q.get('forHandle') === '@overquota') {
					return Response.json({ error: { code: 403, errors: [{ domain: 'youtube.quota', reason: 'quotaExceeded' }] } }, { status: 403 });
				}
				if (q.get('forHandle') !== '@ancientwonders' && q.get('id') !== CHANNEL) return Response.json({ items: [] });
				return Response.json({
					items: [
						{
							id: CHANNEL,
							snippet: { title: 'Ancient Wonders Daily AI', description: description.text, customUrl: '@AncientWonders' },
							statistics: { subscriberCount: '150000', hiddenSubscriberCount: false },
							contentDetails: { relatedPlaylists: { uploads: 'UUzzz' } }
						}
					]
				});
			case '/playlistItems': {
				const second = q.get('pageToken') === 'p2';
				const start = second ? 20 : 0;
				// Two uploads a day going back; items 28 and later are older than 14 days.
				const items = Array.from({ length: 20 }, (_, k) => ({
					contentDetails: { videoId: `v${start + k}`, videoPublishedAt: rfc3339(unix(now - (start + k) * 12 * HOUR - 6 * HOUR)) }
				}));
				return Response.json(second ? { items } : { items, nextPageToken: 'p2' });
			}
		}
		return new Response('not found', { status: 404 });
	});
	return { calls: () => paths.length, paths };
}

let stores = 0;
const withStore = (fn: (store: Store, state: DurableObjectState) => Promise<void>) =>
	runInDurableObject(env.STORE.getByName(`youtube-${++stores}`), async (store: Store, state) => {
		store.now = () => NOW;
		await fn(store, state);
	});

function client(store: Store, budget?: number): YouTube {
	const yt = new YouTube('test-key', store.db, () => store.now(), budget);
	yt.baseUrl = BASE;
	return yt;
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('youtube', () => {
	it('enriches stale sources and verifies descriptions live (TestEnrichAndVerify)', () =>
		withStore(async (store) => {
			const description = { text: 'History videos every hour.' };
			const api = fakeAPI(NOW, description);
			const c = client(store);
			const db = store.db;

			// Two sources that are really one channel, tagged under each alias; with derived use.
			const byHandle = ensureSource(db, 'yt', '@ancientwonders', '', unix(NOW));
			const byID = ensureSource(db, 'yt', CHANNEL, '', unix(NOW));
			await c.enrichStale(db, NOW, 10, true);
			expect(sourceRefs(db)).toEqual([Math.min(byHandle, byID)]);
			const src = getSource(db, sourceRefs(db)[0]!)!;
			// The API title is never kept: names come from reports.
			expect(src).toMatchObject({ canonicalId: CHANNEL, name: '', subscribers: 150_000, uploadsPerDay: 2 });
			expect(src.aliases).toEqual([CHANNEL, '@ancientwonders']);

			// Appeal verification always reads the live description.
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(false);
			description.text += ' colander-7KQ2M9XD';
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(true);

			await expect(c.channel('@nobody')).rejects.toBeInstanceOf(YouTubeNotFoundError);
			c.key = 'wrong-key';
			const err = await c.channel('@other').then(
				() => null,
				(e: Error) => e
			);
			expect(err?.message).toBe('youtube /channels: status 403');
		}));

	it('never surfaces the API key from a network error', () =>
		withStore(async (store) => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				throw new TypeError(`connection lost while fetching ${input instanceof Request ? input.url : String(input)}`);
			});
			const err = await client(store)
				.channel(CHANNEL)
				.then(
					() => null,
					(e: Error) => e
				);
			expect(err?.message).toMatch(/^youtube \/channels: connection lost/);
			expect(err?.message).not.toContain('test-key');
		}));

	it('keeps no YouTube figure without derived use, and no figure decides a verdict', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: '' });
			const db = store.db;
			const ref = ensureSource(db, 'yt', '@ancientwonders', '', unix(NOW));
			await client(store).enrichStale(db, NOW, 10, false);
			// The lookup links the channel ID; the uploads playlist is never read.
			expect(api.paths).toEqual(['/channels']);
			expect(getSource(db, ref)).toMatchObject({ canonicalId: CHANNEL, subscribers: null, uploadsPerDay: null, youtubeCheckedAt: unix(NOW) });
			expect(db.get('SELECT count(*) AS n FROM youtube_channels')).toEqual({ n: 0 });

			// Figures stored while derived use was on stop counting once it is off.
			setYouTube(db, ref, { channelId: CHANNEL, handle: '@ancientwonders', subscribers: 1_200_000, uploadsPerDay: 20 }, unix(NOW));
			const engine = store.engine;
			expect(engine.derived, 'off by default').toBe(false);
			expect(engine.explain(ref)!.input).toMatchObject({ large: false, audienceKnown: false, uploadsPerDay: -1 });
			engine.derived = true;
			expect(engine.explain(ref)!.input).toMatchObject({ large: true, audienceKnown: true, uploadsPerDay: 20 });
		}));

	it('deletes YouTube Data API data before it is 30 days old and never dumps it', () =>
		withStore(async (store, state) => {
			const db = store.db;
			const at = unix(NOW);
			const ref = ensureSource(db, 'yt', '@ancientwonders', '', at);
			setYouTube(db, ref, { channelId: CHANNEL, handle: '@ancientwonders', subscribers: 1000, uploadsPerDay: 1 }, at);
			// A response code from before migration 0005 cached, after a rollback.
			db.run('INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, x\'01\', ?)', '/channels?id=' + CHANNEL, at);
			db.run('INSERT INTO youtube_quota (day, units) VALUES (?, 5)', pacificDay(NOW));
			const rows = () => db.get<{ cache: number; channels: number; quota: number }>(
				'SELECT (SELECT count(*) FROM youtube_cache) AS cache, (SELECT count(*) FROM youtube_channels) AS channels, (SELECT count(*) FROM youtube_quota) AS quota'
			);

			const dump = [...dumpLines(state.storage.sql, db, NOW)];
			for (const t of API_DATA_TABLES) {
				expect(dump.some((l) => l.startsWith(`CREATE TABLE ${t} `) || l.startsWith(`CREATE TABLE "${t}"`)), `${t} is created`).toBe(true);
				expect(dump.some((l) => l.startsWith(`INSERT INTO "${t}"`)), `${t} rows are not dumped`).toBe(false);
			}

			prune(db, NOW + 28 * DAY);
			expect(rows()).toEqual({ cache: 1, channels: 1, quota: 1 });
			prune(db, NOW + 29 * DAY + 1000);
			expect(rows()).toEqual({ cache: 0, channels: 0, quota: 1 });
			// The ledger keeps a day as long as API data from it may be kept.
			prune(db, NOW + 30 * DAY);
			expect(rows()).toEqual({ cache: 0, channels: 0, quota: 0 });
			// The source and its aliases stay; only the API figures went.
			expect(getSource(db, ref)).toMatchObject({ canonicalId: CHANNEL, subscribers: null, uploadsPerDay: null });
		}));

	it('dates the quota ledger by the Pacific day YouTube resets on', () => {
		// Standard time (UTC-8) after 1 November 2026, daylight time (UTC-7) in July.
		expect(pacificDay(Date.UTC(2026, 10, 2, 7, 59))).toBe('2026-11-01');
		expect(pacificDay(Date.UTC(2026, 10, 2, 8, 0))).toBe('2026-11-02');
		expect(pacificDay(Date.UTC(2026, 6, 1, 6, 59))).toBe('2026-06-30');
		expect(pacificDay(Date.UTC(2026, 6, 1, 7, 0))).toBe('2026-07-01');
	});

	it('charges every call to the day before making it and makes none past the budget', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: '' });
			const db = store.db;
			const day = pacificDay(NOW);
			const c = client(store, 3);
			await c.channel(CHANNEL);
			// A failed call costs its units too.
			c.key = 'wrong-key';
			await expect(c.channel(CHANNEL)).rejects.toThrow('status 403');
			c.key = 'test-key';
			await c.channel(CHANNEL);
			expect([youTubeQuotaUsed(db, day), api.calls()]).toEqual([3, 3]);
			// A call that does not fit is never made.
			await expect(c.channel(CHANNEL)).rejects.toBeInstanceOf(YouTubeQuotaError);
			expect([youTubeQuotaUsed(db, day), api.calls()]).toEqual([3, 3]);
			// The budget is back once the Pacific day ends.
			store.now = () => NOW + DAY;
			await c.channel(CHANNEL);
			expect(api.calls()).toBe(4);

			// YouTube's own quotaExceeded uses up the day at once.
			store.now = () => NOW + 2 * DAY;
			const big = client(store, 100);
			await expect(big.channel('@overquota')).rejects.toBeInstanceOf(YouTubeQuotaError);
			expect(youTubeQuotaUsed(db, pacificDay(NOW + 2 * DAY))).toBe(100);
			await expect(big.channel(CHANNEL)).rejects.toBeInstanceOf(YouTubeQuotaError);
			expect(api.calls()).toBe(5);
		}));

	it('goes on past a failing channel, stops when the budget is used, and looks up a bounded number per pass', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: '' });
			const db = store.db;
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const gone = ensureSource(db, 'yt', '@gone', '', unix(NOW));
			const broken = ensureSource(db, 'yt', '@broken', '', unix(NOW));
			const ok = ensureSource(db, 'yt', '@ancientwonders', '', unix(NOW));
			await client(store).enrichStale(db, NOW, 10, false);
			expect(getSource(db, gone)).toMatchObject({ youtubeCheckedAt: unix(NOW) });
			expect(getSource(db, broken)).toMatchObject({ youtubeCheckedAt: unix(NOW) });
			expect(getSource(db, ok)).toMatchObject({ canonicalId: CHANNEL, youtubeCheckedAt: unix(NOW) });
			expect(warn).toHaveBeenCalledWith(JSON.stringify({ message: 'youtube lookup failed', error: 'Error: youtube /channels: status 500' }));
			// Nothing is looked up again before its refresh.
			await client(store).enrichStale(db, NOW + DAY, 10, false);
			expect(api.calls()).toBe(3);

			// A used-up budget ends the run; the rest wait for the next Pacific day. Three units are
			// spent, and lookups stop at 4, BACKGROUND_SHARE of 5.
			const first = ensureSource(db, 'yt', '@first', '', unix(NOW));
			const second = ensureSource(db, 'yt', '@second', '', unix(NOW));
			await client(store, 5).enrichStale(db, NOW, 10, false);
			expect(getSource(db, first)!.youtubeCheckedAt).toBe(unix(NOW));
			expect(getSource(db, second)!.youtubeCheckedAt).toBe(0);
			expect(warn).toHaveBeenLastCalledWith(JSON.stringify({ message: 'youtube budget used', day: pacificDay(NOW) }));

			// Each scoring pass looks up at most ENRICH_PER_PASS channels.
			for (let i = 0; i < ENRICH_PER_PASS + 5; i++) ensureSource(db, 'yt', `@more${i}`, '', unix(NOW));
			store.engine.youtube = client(store);
			const calls = api.calls();
			await store.engine.fullPass(NOW);
			expect(api.calls() - calls).toBe(ENRICH_PER_PASS);
		}));

	it('refreshes YouTube sources at the start of each scoring pass, and a failing channel only logs', () =>
		withStore(async (store) => {
			fakeAPI(NOW, { text: '' });
			expect(store.engine.youtube, 'no YOUTUBE_API_KEY in the test config').toBeUndefined();
			const ref = ensureSource(store.db, 'yt', '@ancientwonders', '', unix(NOW));
			store.engine.youtube = client(store);
			store.engine.derived = true;
			await store.engine.fullPass(NOW);
			expect(getSource(store.db, ref)).toMatchObject({ canonicalId: CHANNEL, subscribers: 150_000, uploadsPerDay: 2 });

			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const stale = ensureSource(store.db, 'yt', '@other', '', unix(NOW));
			store.engine.youtube.key = 'wrong-key';
			await store.engine.fullPass(NOW);
			expect(warn).toHaveBeenCalledWith(JSON.stringify({ message: 'youtube lookup failed', error: 'Error: youtube /channels: status 403' }));
			expect(getSource(store.db, stale)!.youtubeCheckedAt).toBe(unix(NOW));
		}));
});

describe('youtube spending and freshness', () => {
	// Figures are stored with the time YouTube returned them, which the 29-day prune goes by: a
	// response from an appeal check days earlier is never reused for them.
	it('looks a channel up afresh for its figures, so they are dated by the call that returned them', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: '' });
			const db = store.db;
			const c = client(store);
			const ref = ensureSource(db, 'yt', CHANNEL, '', unix(NOW));
			await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD');
			store.now = () => NOW + 6 * DAY;
			const before = api.paths.filter((p) => p === '/channels').length;
			await c.enrichStale(db, NOW + 6 * DAY, 10, true);
			expect(api.paths.filter((p) => p === '/channels').length).toBe(before + 1);
			expect(db.all('SELECT source_id, subscribers, fetched_at FROM youtube_channels')).toEqual([{ source_id: ref, subscribers: 150_000, fetched_at: unix(NOW + 6 * DAY) }]);
			expect(db.get('SELECT count(*) AS n FROM youtube_cache'), 'no response is kept').toEqual({ n: 0 });
		}));

	it('stops background lookups at BACKGROUND_SHARE of the budget, keeping the rest for appeal checks', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: 'colander-7KQ2M9XD' });
			const db = store.db;
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			// Channels YouTube does not know cost one unit each.
			for (let i = 0; i < 10; i++) ensureSource(db, 'yt', `@unknown${i}`, '', unix(NOW));
			const c = client(store, 10);
			await c.enrichStale(db, NOW, 10, true);
			expect(BACKGROUND_SHARE).toBe(0.8);
			expect([youTubeQuotaUsed(db, pacificDay(NOW)), api.calls()]).toEqual([8, 8]);
			expect(db.get('SELECT count(*) AS n FROM sources WHERE youtube_checked_at IS NULL')).toEqual({ n: 2 });
			// The appeal check spends from the full budget.
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(true);
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(true);
			await expect(c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).rejects.toBeInstanceOf(YouTubeQuotaError);
			expect(youTubeQuotaUsed(db, pacificDay(NOW))).toBe(10);
		}));
});

describe('appeal verification through the Data API', () => {
	const post = (store: Store, path: string, body: unknown, headers: Record<string, string> = {}) =>
		store.fetch(
			new Request('https://getcolander.com' + path, {
				method: 'POST',
				headers: { [IP_HASH_HEADER]: 'hash-of-192.0.2.1', ...headers },
				body: JSON.stringify(body)
			})
		);

	it('finds the code in the description, refuses without it, and falls back to staff when the API fails', () =>
		withStore(async (store) => {
			const description = { text: 'History videos every hour.' };
			fakeAPI(NOW, description);
			store.engine.youtube = client(store);
			const staff = grantRole(store.db, 'rae@colander.test', 'staff', unix(NOW), { host: 'job' });
			const review = { [HOST_HEADER]: 'admin', [ACCESS_EMAIL_HEADER]: staff.email, 'X-Colander-CSRF': '1', 'Sec-Fetch-Site': 'same-origin' };
			const decided = await post(store, `/v1/review/sources/yt/${CHANNEL}/decision`, { verdict: 'slop', reason: 'Generated.', signals: ['watermark'] }, review);
			expect(decided.status).toBe(200);

			const file = async () => {
				const res = await post(store, '/v1/appeals', { platform: 'yt', source_id: CHANNEL, email: 'a@example.test', statement: 'Mine.' });
				expect(res.status).toBe(201);
				return (await res.json()) as { appeal: Appeal; secret: string };
			};
			const first = await file();
			let res = await post(store, `/v1/appeals/${first.appeal.id}/verify`, { secret: first.secret });
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({
				error: {
					code: 'code_not_found',
					message: `We could not find ${first.appeal.code} in the channel description yet. Add it, wait a minute and try again.`
				}
			});
			description.text += ' ' + first.appeal.code;
			res = await post(store, `/v1/appeals/${first.appeal.id}/verify`, { secret: first.secret });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { appeal: Appeal }).appeal.status).toBe('under_review');
			expect(getSource(store.db, findSource(store.db, 'yt', CHANNEL)!)!.state.verdict).toBe('disputed');

			// The Data API is down (here: the key was revoked): staff check the code by hand.
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			store.engine.youtube.key = 'wrong-key';
			const second = await file();
			res = await post(store, `/v1/appeals/${second.appeal.id}/verify`, { secret: second.secret });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { appeal: Appeal }).appeal.status).toBe('pending_manual');
			expect(warn).toHaveBeenCalledOnce();
		}));

	it('checks an appeal at most 10 times and an address 30 times an hour, refusing before the Data API is called', () =>
		withStore(async (store) => {
			const api = fakeAPI(NOW, { text: 'History videos every hour.' });
			store.engine.youtube = client(store);
			const staff = grantRole(store.db, 'rae@colander.test', 'staff', unix(NOW), { host: 'job' });
			const review = { [HOST_HEADER]: 'admin', [ACCESS_EMAIL_HEADER]: staff.email, 'X-Colander-CSRF': '1', 'Sec-Fetch-Site': 'same-origin' };
			expect((await post(store, `/v1/review/sources/yt/${CHANNEL}/decision`, { verdict: 'slop', reason: 'Generated.', signals: ['watermark'] }, review)).status).toBe(200);
			// Each appeal is filed from its own address; every check comes from 192.0.2.1.
			const file = async (n: number) => {
				const res = await post(store, '/v1/appeals', { platform: 'yt', source_id: CHANNEL, email: 'a@example.test', statement: 'Mine.' }, { [IP_HASH_HEADER]: `hash-of-198.51.100.${n}` });
				expect(res.status).toBe(201);
				return (await res.json()) as { appeal: Appeal; secret: string };
			};
			const verify = (a: { appeal: Appeal; secret: string }) => post(store, `/v1/appeals/${a.appeal.id}/verify`, { secret: a.secret });

			const first = await file(1);
			for (let i = 0; i < 10; i++) expect((await verify(first)).status).toBe(422);
			const calls = api.calls();
			const refused = await verify(first);
			expect(refused.status).toBe(429);
			expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
			expect(api.calls(), 'no Data API call').toBe(calls);

			for (const n of [2, 3]) {
				const a = await file(n);
				for (let i = 0; i < 10; i++) expect((await verify(a)).status).toBe(422);
			}
			const fourth = await file(4);
			expect((await verify(fourth)).status, 'the address used its 30 checks').toBe(429);
			expect(api.calls()).toBe(calls + 20);

			store.now = () => NOW + 3_600_000;
			expect((await verify(first)).status, 'an hour later').toBe(422);
		}));
});
