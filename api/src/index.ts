// The edge Worker on getcolander.com (hosting plan sections 2 and 4). Workers Static Assets serves
// the website; this code runs only for /v1/*, /ops/*, /healthz, /__dev/* and the two SPA shell
// paths, and only on cache misses. It answers preflights, checks `since` and the query of the other cached GETs,
// rate-limits misses per salted IP hash, serves snapshot misses from R2 (from the Store while R2
// has none or fails) and forwards the rest of /v1 to the Store. The cron triggers run
// src/scheduled.ts.
import { testNow } from './dev';
import { finish, IP_HASH_HEADER, ipKey, isCorsPath, json, jsonError, notFound, preflight, ROUTE_HEADER, setCache, tooMany } from './http';
import { ops as runOps } from './ops';
import { scheduled } from './scheduled';
import { SNAPSHOT_KEY } from './store/list';
import { primary } from './store/store';

// Only the handler and the Durable Object class are exported: named exports of the main module
// are Worker entrypoints.
export { Store } from './store/store';

// Requests to these never reach the Store with the client's address.
const CLIENT_ADDRESS_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip', 'cf-connecting-ipv6'];

interface Handled {
	/** The route pattern, the only part of a request that is ever logged (contract 8). */
	route: string;
	res: Response;
}

export default {
	scheduled,
	async fetch(request, env, ctx): Promise<Response> {
		const started = Date.now();
		const url = new URL(request.url);
		let handled: Handled;
		try {
			handled = await handle(request, url, env, ctx);
		} catch (err) {
			const route = `${request.method} (error)`;
			console.error(JSON.stringify({ message: 'internal error', route, error: String(err) }));
			handled = { route, res: jsonError(500, 'internal', 'Something went wrong on our side. Please try again.') };
		}
		const res = finish(handled.res, request.method, url.pathname);
		console.log(JSON.stringify({ route: handled.route, status: res.status, ms: Date.now() - started }));
		return res;
	}
} satisfies ExportedHandler<Env>;

async function handle(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Handled> {
	const path = url.pathname;
	const method = request.method;
	// The SPA shells are files, not pages: /200 and /404 get the 404 page with status 404, like any
	// other unknown path.
	if (path === '/200' || path === '/404') {
		return { route: `${method} (site)`, res: await env.ASSETS.fetch(new Request(new URL('/__not_found__', url), request)) };
	}
	if (method === 'OPTIONS' && path.startsWith('/v1/')) {
		return { route: 'OPTIONS (preflight)', res: isCorsPath(path) ? preflight() : notFound() };
	}
	if (path.startsWith('/__dev/') && env.COLANDER_DEV !== '1') {
		// Outside dev mode these routes do not exist: answer like any unknown path.
		return { route: `${method} (site)`, res: await env.ASSETS.fetch(request) };
	}
	const dev = env.COLANDER_DEV === '1';
	const ipHash = await hashIp(ipKey(request.headers.get('cf-connecting-ip') ?? ''), env.IP_SALT);
	// The limiter shields the Store from cache misses. Local runtimes have no Workers Cache, so every
	// request would be a miss and one developer's browser would trip it: dev mode goes without.
	if (!dev && !(await env.MISSES.limit({ key: ipHash })).success) return { route: `${method} (rate limited)`, res: tooMany(60) };

	const read = method === 'GET' || method === 'HEAD';
	// In production edge analytics count list requests, cache hits included (src/scheduled.ts).
	// Local runtimes have no analytics, so dev mode counts them here, as the Go server did.
	if (dev && read && (path === '/v1/list/snapshot' || path === '/v1/list/delta')) await primary(env).countListRequest();
	if (path === '/healthz' && read) return { route: 'GET /healthz', res: await health(env) };
	if (path === '/ops' || path.startsWith('/ops/')) return { route: `${method} /ops/*`, res: await ops(request, env, ctx) };
	if (read) {
		const bad = checkQuery(path, url.search);
		if (bad) return { route: `GET ${bad.route}`, res: bad.res };
	}
	if (path === '/v1/list/snapshot' && read) {
		const res = await snapshot(env);
		// Before the first publication reaches R2, or if the object is lost, the Store serves its head.
		if (res) return { route: 'GET /v1/list/snapshot', res };
	}
	if (path === '/v1/list/delta' && read) {
		const bad = checkSince(url.search, testNow(env) ?? Date.now());
		if (bad) return { route: 'GET /v1/list/delta', res: bad };
	}
	if (path.startsWith('/v1/') || path.startsWith('/__dev/')) return forward(request, env, ipHash);
	return { route: `${method} (site)`, res: await env.ASSETS.fetch(request) };
}

/**
 * Salted HMAC-SHA256 of the client address (ipKey: an IPv6 address by its /64), hex. The raw
 * address is never stored or forwarded.
 */
async function hashIp(ip: string, salt: string): Promise<string> {
	if (!salt) throw new Error('IP_SALT is not set');
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The delta query must be exactly `?since=N` in canonical decimal, no later than now + 60 s
 * (sequences are floored to unix seconds). Anything else would only fill the cache with junk keys.
 */
function checkSince(search: string, nowMs: number): Response | null {
	const m = /^\?since=(0|[1-9]\d{0,14})$/.exec(search);
	if (m && Number(m[1]) <= nowMs / 1000 + 60) return null;
	return jsonError(400, 'invalid_since', 'The since parameter must be a list sequence number.');
}

/** The cached GETs that take no query, by the route pattern they are logged under. */
const NO_QUERY: [RegExp, string][] = [
	[/^\/v1\/list\/snapshot$/, '/v1/list/snapshot'],
	[/^\/v1\/config\/adapters$/, '/v1/config/adapters'],
	[/^\/v1\/sources\/[^/]+\/[^/]+$/, '/v1/sources/:platform/:source_id'],
	[/^\/v1\/stats$/, '/v1/stats'],
	[/^\/v1\/supporters$/, '/v1/supporters']
];

/** The decision log's parameters in the order the website sends them, their canonical values and the Store's errors. */
const LOG_PARAMS: [string, RegExp, string, string][] = [
	['limit', /^(?:[1-9]\d?|1\d\d|200)$/, 'invalid_limit', 'limit must be a number from 1 to 200.'],
	['platform', /^(?:yt|tt|ig|fb)$/, 'invalid_platform', 'platform must be yt, tt, ig or fb.'],
	['verdict', /^(?:slop|likely_slop|ai_made|disputed|clear)$/, 'invalid_verdict', 'verdict must be one of the five verdicts.'],
	['cursor', /^log_[1-9]\d{0,17}$/, 'invalid_cursor', 'The cursor is not valid.']
];

/**
 * The edge caches the public GETs by their full URL, query included, and their handlers ignore
 * parameters they do not know: only the canonical form may pass, or junk queries would make every
 * request a miss that runs the Store. Routes without parameters take no query; /v1/log takes
 * limit, platform, verdict and cursor, each at most once and in that order (the website's), each
 * with a canonical value; a bad value gets the Store's own error.
 */
function checkQuery(path: string, search: string): { route: string; res: Response } | null {
	const plain = NO_QUERY.find(([re]) => re.test(path));
	if (plain) {
		return search === '' ? null : { route: plain[1], res: jsonError(400, 'invalid_query', 'This address takes no query parameters.') };
	}
	if (path !== '/v1/log' || search === '') return null;
	const bad = { route: '/v1/log', res: jsonError(400, 'invalid_query', 'The log takes only limit, platform, verdict and cursor, each once and in that order.') };
	let next = 0;
	for (const pair of search.slice(1).split('&')) {
		const eq = pair.indexOf('=');
		const name = eq < 0 ? pair : pair.slice(0, eq);
		const at = LOG_PARAMS.findIndex(([n]) => n === name);
		if (at < next || eq < 0 || eq === pair.length - 1) return bad;
		next = at + 1;
		const [, valid, code, message] = LOG_PARAMS[at]!;
		if (!valid.test(pair.slice(eq + 1))) return { route: '/v1/log', res: jsonError(400, code, message) };
	}
	return null;
}

/**
 * Snapshot misses come straight from R2, so installs keep syncing while the Store is down.
 * Null when R2 has no valid snapshot or cannot be read: the Store then serves its head.
 */
async function snapshot(env: Env): Promise<Response | null> {
	let obj: R2ObjectBody | null;
	try {
		obj = await env.LISTS.get(SNAPSHOT_KEY);
	} catch (err) {
		console.error(JSON.stringify({ message: 'reading the snapshot from R2 failed', error: String(err) }));
		return null;
	}
	const seq = obj?.customMetadata?.seq;
	if (!obj || !seq || !/^\d{1,15}$/.test(seq)) {
		if (obj) console.error(JSON.stringify({ message: 'snapshot object has no valid seq metadata' }));
		return null;
	}
	const headers = setCache(new Headers({ 'Content-Type': 'application/octet-stream', 'X-Colander-Sequence': seq }), 'list');
	return new Response(obj.body, { headers });
}

async function health(env: Env): Promise<Response> {
	try {
		await primary(env).health();
		return json(200, { ok: true });
	} catch (err) {
		console.error(JSON.stringify({ message: 'health check failed', error: String(err) }));
		return jsonError(503, 'unhealthy', 'The database is not reachable.');
	}
}

/** Everything the edge does not answer goes to the Store, with the client address hashed. */
async function forward(request: Request, env: Env, ipHash: string): Promise<Handled> {
	const headers = new Headers(request.headers);
	for (const h of CLIENT_ADDRESS_HEADERS) headers.delete(h);
	headers.delete(ROUTE_HEADER);
	headers.set(IP_HASH_HEADER, ipHash);
	const fallback = `${request.method} (store)`;
	const idempotent = request.method === 'GET' || request.method === 'HEAD';
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await primary(env).fetch(new Request(request, { headers }));
			return { route: res.headers.get(ROUTE_HEADER) ?? fallback, res };
		} catch (err) {
			// A deploy restarts the Store; an idempotent request retries once (hosting plan flow 14).
			const e = err as { retryable?: boolean; overloaded?: boolean };
			if (idempotent && e.retryable && !e.overloaded && attempt === 1) continue;
			console.error(JSON.stringify({ message: 'store unavailable', route: fallback, error: String(err) }));
			return { route: fallback, res: jsonError(503, 'unavailable', 'The service is briefly unavailable. Please try again.', { 'Retry-After': '5' }) };
		}
	}
}

/** The ops channel: GitHub workflows post here with OPS_TOKEN; src/ops.ts runs the commands. */
async function ops(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!env.OPS_TOKEN) return jsonError(503, 'ops_unavailable', 'The ops channel is not configured.');
	if (!(await sameSecret(request.headers.get('Authorization') ?? '', `Bearer ${env.OPS_TOKEN}`))) {
		return jsonError(401, 'unauthorized', 'A valid ops token is required.', { 'WWW-Authenticate': 'Bearer' });
	}
	return runOps(request, env, ctx.cache);
}

/** Constant-time comparison: both sides are hashed first so their lengths match. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}
