// The YouTube Data API client (src/youtube.ts): the port of server/internal/youtube/youtube_test.go
// against a fake API, plus the client in the Store: enrichment at the start of each scoring pass
// and automatic appeal verification. The fake replaces fetch, as Go's test used httptest.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appeal } from '@colander/shared/api';
import { IP_HASH_HEADER } from '../src/http';
import { CookieName, newToken } from '../src/routes/auth';
import { rfc3339 } from '../src/routes/respond';
import { unix } from '../src/scoring/engine';
import { createSession, grantRole } from '../src/store/accounts';
import { ensureSource, findSource, getSource, sourceRefs } from '../src/store/sources';
import type { Store } from '../src/store/store';
import { YouTube, YouTubeNotFoundError } from '../src/youtube';

const CHANNEL = 'UCzzzzzzzzzzzzzzzzzzzzz7';
const BASE = 'https://fake-youtube.test';
const NOW = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;

/**
 * Go's fakeAPI: one channel with 28 uploads in the last 14 days, over two pages. It answers 403
 * without the test key and counts calls.
 */
function fakeAPI(now: number, description: { text: string }) {
	let calls = 0;
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== BASE) throw new Error(`unexpected fetch to ${url.origin}`);
		calls++;
		const q = url.searchParams;
		if (q.get('key') !== 'test-key') return new Response(null, { status: 403 });
		switch (url.pathname) {
			case '/channels':
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
	return { calls: () => calls };
}

let stores = 0;
const withStore = (fn: (store: Store) => Promise<void>) =>
	runInDurableObject(env.STORE.getByName(`youtube-${++stores}`), async (store: Store) => {
		store.now = () => NOW;
		await fn(store);
	});

function client(store: Store): YouTube {
	const yt = new YouTube('test-key', store.db, () => store.now());
	yt.baseUrl = BASE;
	return yt;
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('youtube', () => {
	it('enriches stale sources, caches lookups and verifies descriptions live (TestEnrichAndVerify)', () =>
		withStore(async (store) => {
			const description = { text: 'History videos every hour.' };
			const api = fakeAPI(NOW, description);
			const c = client(store);
			const db = store.db;

			// Two sources that are really one channel, tagged under each alias.
			const byHandle = ensureSource(db, 'yt', '@ancientwonders', '', unix(NOW));
			const byID = ensureSource(db, 'yt', CHANNEL, '', unix(NOW));
			await c.enrichStale(db, NOW, 10);
			expect(sourceRefs(db)).toEqual([Math.min(byHandle, byID)]);
			const src = getSource(db, sourceRefs(db)[0]!)!;
			expect(src).toMatchObject({ canonicalId: CHANNEL, name: 'Ancient Wonders Daily AI', subscribers: 150_000, uploadsPerDay: 2 });
			expect(src.aliases).toEqual([CHANNEL, '@ancientwonders']);

			// Cached for a week: a second lookup of a fresh source costs no calls.
			const before = api.calls();
			await c.channel(CHANNEL, false);
			expect(api.calls()).toBe(before);
			// A week later the cache is stale.
			store.now = () => NOW + 8 * 24 * HOUR;
			await c.channel(CHANNEL, false);
			expect(api.calls()).toBe(before + 1);

			// Appeal verification always reads the live description.
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(false);
			description.text += ' colander-7KQ2M9XD';
			expect(await c.descriptionContains(CHANNEL, 'colander-7KQ2M9XD')).toBe(true);

			await expect(c.channel('@nobody', true)).rejects.toBeInstanceOf(YouTubeNotFoundError);
			c.key = 'wrong-key';
			const err = await c.channel('@other', true).then(
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
				.channel(CHANNEL, true)
				.then(
					() => null,
					(e: Error) => e
				);
			expect(err?.message).toMatch(/^youtube \/channels: connection lost/);
			expect(err?.message).not.toContain('test-key');
		}));

	it('marks a channel that does not exist as checked, and stops at the first API error', () =>
		withStore(async (store) => {
			fakeAPI(NOW, { text: '' });
			const db = store.db;
			const gone = ensureSource(db, 'yt', '@gone', '', unix(NOW));
			await client(store).enrichStale(db, NOW, 10);
			expect(getSource(db, gone)).toMatchObject({ youtubeCheckedAt: unix(NOW), subscribers: null });

			const other = ensureSource(db, 'yt', '@other', '', unix(NOW));
			const c = client(store);
			c.key = 'wrong-key';
			await expect(c.enrichStale(db, NOW, 10)).rejects.toThrow('youtube /channels: status 403');
			expect(getSource(db, other)!.youtubeCheckedAt).toBe(0);
		}));

	it('refreshes YouTube sources at the start of each scoring pass, and a failure only logs', () =>
		withStore(async (store) => {
			fakeAPI(NOW, { text: '' });
			expect(store.engine.youtube, 'no YOUTUBE_API_KEY in the test config').toBeUndefined();
			const ref = ensureSource(store.db, 'yt', '@ancientwonders', '', unix(NOW));
			store.engine.youtube = client(store);
			await store.engine.fullPass(NOW);
			expect(getSource(store.db, ref)).toMatchObject({ canonicalId: CHANNEL, subscribers: 150_000, uploadsPerDay: 2 });

			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const stale = ensureSource(store.db, 'yt', '@other', '', unix(NOW));
			store.engine.youtube.key = 'wrong-key';
			await store.engine.fullPass(NOW);
			expect(warn).toHaveBeenCalledWith(JSON.stringify({ message: 'youtube enrichment failed', error: 'Error: youtube /channels: status 403' }));
			expect(getSource(store.db, stale)!.youtubeCheckedAt).toBe(0);
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
			const staff = grantRole(store.db, 'rae@colander.test', 'staff', unix(NOW));
			const { raw, hash } = newToken();
			createSession(store.db, hash, staff.id, unix(NOW), unix(NOW) + 3600);
			const review = { Cookie: `${CookieName}=${raw}`, 'X-Colander-CSRF': '1' };
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
});
