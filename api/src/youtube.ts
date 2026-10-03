// A small YouTube Data API v3 client for source enrichment and appeal checks (Go's
// internal/youtube). Responses are cached in the Store's youtube_cache for 7 days to stay well
// inside the daily quota. Every call is a network request: never make one inside a transaction.
import { lowerSimple } from '@colander/shared/ids';
import type { Db } from './store/db';
import { cacheGet, cachePut } from './store/misc';
import { markYouTubeChecked, setYouTube, youTubeStale, type YouTubeInfo } from './store/sources';
import { parseRFC3339, queryEscape, readBody } from './routes/respond';

const DAY = 24 * 3_600_000;

/** The channel does not exist (Go's youtube.ErrNotFound). */
export class YouTubeNotFoundError extends Error {
	constructor() {
		super('youtube channel not found');
	}
}

/** The part of a channel resource Colander uses. */
export interface Channel {
	id: string;
	/** with @, lowercased */
	handle: string;
	title: string;
	description: string;
	subscribers: number;
	hiddenCount: boolean;
	uploadsPlaylist: string;
}

/** Go's url.Values.Encode: keys sorted, each pair escaped. */
const encode = (params: Record<string, string>): string =>
	Object.keys(params)
		.sort()
		.map((k) => `${queryEscape(k)}=${queryEscape(params[k]!)}`)
		.join('&');

/** Go's json decoding of a string field: null or absent is "", anything else fails. */
function str(v: unknown, what: string): string {
	if (v === undefined || v === null) return '';
	if (typeof v !== 'string') throw new Error(`${what} is not a string`);
	return v;
}

/** Go's json decoding of a struct field: null or absent is the zero struct, a non-object fails. */
function obj(v: unknown): Record<string, unknown> {
	if (v === undefined || v === null) return {};
	if (typeof v !== 'object' || Array.isArray(v)) throw new Error('youtube: unexpected JSON shape');
	return v as Record<string, unknown>;
}

/** Go's json decoding of a slice field: null or absent is empty, a non-array fails. */
function list(v: unknown): unknown[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw new Error('youtube: unexpected JSON shape');
	return v;
}

/** Calls the Data API with an API key. */
export class YouTube {
	baseUrl = 'https://www.googleapis.com/youtube/v3';
	/** Responses younger than this come from the cache. */
	cacheTtl = 7 * DAY;
	/** How far back uploads are counted for uploads per day. */
	window = 14 * DAY;

	constructor(
		public key: string,
		/** the response cache */
		private readonly db: Db,
		/** the clock in unix milliseconds */
		private readonly now: () => number = Date.now
	) {}

	/** Fetches path with params, using the cache unless fresh is set. */
	private async get(path: string, params: Record<string, string>, fresh: boolean): Promise<unknown> {
		const cacheKey = `${path}?${encode(params)}`;
		const now = this.now();
		if (!fresh) {
			const body = cacheGet(this.db, cacheKey, Math.floor((now - this.cacheTtl) / 1000));
			if (body) return JSON.parse(new TextDecoder().decode(body));
		}
		let resp: Response;
		try {
			resp = await fetch(`${this.baseUrl}${path}?${encode({ ...params, key: this.key })}`, { signal: AbortSignal.timeout(15_000) });
		} catch (err) {
			// Never surface the URL: it carries the API key.
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`youtube ${path}: ${this.key ? message.replaceAll(this.key, '***') : message}`);
		}
		const { bytes: body, over } = await readBody(resp.body, 4 << 20);
		if (resp.status !== 200) throw new Error(`youtube ${path}: status ${resp.status}`);
		let out: unknown;
		try {
			if (over) throw new Error('response larger than 4 MiB');
			out = JSON.parse(new TextDecoder().decode(body));
		} catch (err) {
			throw new Error(`youtube ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		cachePut(this.db, cacheKey, body, Math.floor(now / 1000));
		return out;
	}

	/** Looks a channel up by channel ID (UC...) or handle (@name). fresh skips the cache, which appeal verification needs. */
	async channel(alias: string, fresh: boolean): Promise<Channel> {
		const params: Record<string, string> = { part: 'snippet,statistics,contentDetails' };
		if (alias.startsWith('@')) params.forHandle = alias;
		else params.id = alias;
		const resp = obj(await this.get('/channels', params, fresh));
		const it = list(resp.items)[0];
		if (it === undefined) throw new YouTubeNotFoundError();
		const item = obj(it);
		const snippet = obj(item.snippet);
		const stats = obj(item.statistics);
		const hidden = stats.hiddenSubscriberCount ?? false;
		if (typeof hidden !== 'boolean') throw new Error('youtube /channels: hiddenSubscriberCount is not a boolean');
		const handle = lowerSimple(str(snippet.customUrl, 'customUrl'));
		const count = str(stats.subscriberCount, 'subscriberCount');
		return {
			id: str(item.id, 'id'),
			handle: handle.startsWith('@') ? handle : '',
			title: str(snippet.title, 'title'),
			description: str(snippet.description, 'description'),
			// Go's ParseInt with the error dropped: anything else is 0.
			subscribers: /^[+-]?\d+$/.test(count) ? Number(count) : 0,
			hiddenCount: hidden,
			uploadsPlaylist: str(obj(obj(item.contentDetails).relatedPlaylists).uploads, 'uploads')
		};
	}

	/** Uploads per day in the window, counted from the uploads playlist, newest first. now is unix milliseconds. */
	async uploadsPerDay(playlist: string, now: number): Promise<number> {
		const cutoff = (now - this.window) / 1000;
		let count = 0;
		let token = '';
		// ponytail: at most 20 pages (1,000 uploads); enough to tell 10 a day from fewer.
		for (let page = 0; page < 20; page++) {
			const params: Record<string, string> = { part: 'contentDetails', playlistId: playlist, maxResults: '50' };
			if (token !== '') params.pageToken = token;
			const resp = obj(await this.get('/playlistItems', params, false));
			let older = false;
			for (const it of list(resp.items)) {
				const at = str(obj(obj(it).contentDetails).videoPublishedAt, 'videoPublishedAt');
				// A missing time is Go's zero time, older than any window.
				const published = at === '' ? -Infinity : parseRFC3339(at);
				if (published === undefined) throw new Error(`youtube /playlistItems: videoPublishedAt ${JSON.stringify(at)} is not RFC 3339`);
				if (published < cutoff) {
					older = true;
					continue;
				}
				count++;
			}
			token = str(resp.nextPageToken, 'nextPageToken');
			if (older || token === '') break;
		}
		return count / (this.window / DAY);
	}

	/** Whether a channel's current description holds code. */
	async descriptionContains(alias: string, code: string): Promise<boolean> {
		return (await this.channel(alias, true)).description.includes(code);
	}

	/**
	 * Refreshes up to limit YouTube sources whose data is older than the cache TTL: both aliases,
	 * subscriber count and uploads per day. It stops at the first API error. now is unix milliseconds.
	 */
	async enrichStale(db: Db, now: number, limit: number): Promise<void> {
		const s = Math.floor(now / 1000);
		for (const src of youTubeStale(db, Math.floor((now - this.cacheTtl) / 1000), limit)) {
			let ch: Channel;
			try {
				ch = await this.channel(src.canonicalId, false);
			} catch (err) {
				if (!(err instanceof YouTubeNotFoundError)) throw err;
				markYouTubeChecked(db, src.ref, s);
				continue;
			}
			const info: YouTubeInfo = { channelId: ch.id, handle: ch.handle, title: ch.title, subscribers: null, uploadsPerDay: null };
			if (!ch.hiddenCount) info.subscribers = ch.subscribers;
			if (ch.uploadsPlaylist !== '') info.uploadsPerDay = await this.uploadsPerDay(ch.uploadsPlaylist, now);
			setYouTube(db, src.ref, info, s);
		}
	}
}
