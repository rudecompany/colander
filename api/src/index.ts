// The edge Worker on getcolander.com and the admin host (hosting plan sections 2 and 4; contracts
// 6.1 and 6.9). Workers Static Assets serves the website; this code runs only for /v1/*, /ops/*,
// /healthz, /__dev/*, the admin pages, the home page and the two SPA shell paths, and only on
// cache misses. It answers preflights, checks `since` and the query of the other cached GETs,
// rate-limits misses per salted IP hash, serves snapshot misses from R2 (from the Store while R2
// has none or fails), verifies Cloudflare Access on the admin host and GitHub OIDC on the ops
// channel, and forwards the rest of /v1 to the Store with the headers it trusts (storeHeaders).
// The cron triggers run src/scheduled.ts.
import { adminHostname, adminOrigin, devAccessToken, devLocal, verifyAccess, type AccessIdentity } from './access';
import { normalizeEmail } from './auth';
import { testNow } from './dev';
import { finish, ipKey, isCorsPath, json, jsonError, notFound, preflight, ROUTE_HEADER, setCache, storeHeaders, tooMany } from './http';
import { opsCaller, ops as runOps } from './ops';
import { scheduled } from './scheduled';
import { SNAPSHOT_KEY } from './store/list';
import { primary } from './store/store';

// Only the handler and the Durable Object class are exported: named exports of the main module
// are Worker entrypoints.
export { Store } from './store/store';

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
		const admin = isAdminHost(url, env);
		let handled: Handled;
		try {
			handled = admin ? await handleAdmin(request, url, env) : await handle(request, url, env, ctx);
		} catch (err) {
			const route = `${request.method} (error)`;
			console.error(JSON.stringify({ message: 'internal error', route, error: String(err) }));
			handled = { route, res: jsonError(500, 'internal', 'Something went wrong on our side. Please try again.') };
		}
		const res = finish(handled.res, request.method, url.pathname, admin);
		console.log(JSON.stringify({ route: handled.route, host: admin ? 'admin' : 'main', status: res.status, ms: Date.now() - started }));
		return res;
	}
} satisfies ExportedHandler<Env>;

/** Whether the request came to the admin host. */
function isAdminHost(url: URL, env: Env): boolean {
	const host = adminHostname(env);
	return host !== '' && url.hostname.toLowerCase() === host;
}

/**
 * The admin host: Access in front, A3T Identity behind it. Every request that reaches the Worker
 * (the run_worker_first paths: /, /admin and /admin/*, /v1/*, /ops/*, /__dev/*, /healthz and the
 * shells) needs a valid Access token; other static files are served without running the Worker,
 * and Cloudflare Access covers them at the edge. Only the admin and review APIs exist here, without
 * CORS, and the home page is the admin console. Dev mode's Access stub is the one exception, and
 * only on admin.localhost.
 */
async function handleAdmin(request: Request, url: URL, env: Env): Promise<Handled> {
	const path = url.pathname;
	const method = request.method;
	if (path === '/__dev/access') return { route: `${method} /__dev/access`, res: await devAccess(request, env) };
	const access = await verifyAccess(request, env);
	if (!access) {
		return {
			route: `${method} (access required)`,
			res: jsonError(403, 'access_required', 'Sign in through Cloudflare Access to use the admin console.')
		};
	}
	if (path === '/') return { route: 'GET (admin home)', res: Response.redirect(new URL('/admin', url).toString(), 302) };
	if (path.startsWith('/v1/admin/') || path.startsWith('/v1/review/')) {
		const ipHash = await hashIp(ipKey(request.headers.get('cf-connecting-ip') ?? ''), env.IP_SALT);
		return forward(request, env, ipHash, access);
	}
	if (path.startsWith('/v1/') || path.startsWith('/ops') || path.startsWith('/__dev/') || path === '/healthz') {
		return { route: `${method} (admin unmatched)`, res: notFound() };
	}
	if (path === '/200' || path === '/404') {
		return { route: `${method} (site)`, res: await env.ASSETS.fetch(new Request(new URL('/__not_found__', url), request)) };
	}
	return { route: `${method} (site)`, res: await env.ASSETS.fetch(request) };
}

/**
 * POST /__dev/access {"email", "subject"?}: dev mode's stand-in for an Access login on
 * admin.localhost. Sets the CF_Authorization cookie the edge then reads, and answers the token for
 * API clients. Anywhere else it does not exist.
 */
async function devAccess(request: Request, env: Env): Promise<Response> {
	if (!devLocal(env) || request.method !== 'POST') return notFound();
	const body = (await request.json().catch(() => null)) as { email?: unknown; subject?: unknown } | null;
	const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '');
	if (!email) return jsonError(400, 'invalid_email', 'email must be an email address.');
	const subject = typeof body?.subject === 'string' ? body.subject : '';
	const token = await devAccessToken(env, email, subject);
	return json(200, { token }, { 'Set-Cookie': `CF_Authorization=${token}; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict` });
}

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
	// The admin console lives on the admin host only; its API does not exist here.
	if (path === '/admin' || path.startsWith('/admin/')) {
		const origin = adminOrigin(env);
		if (!origin) return { route: `${method} (site)`, res: await env.ASSETS.fetch(new Request(new URL('/__not_found__', url), request)) };
		return { route: 'GET /admin/* (to the admin host)', res: Response.redirect(origin + path + url.search, 302) };
	}
	if (path.startsWith('/v1/admin/') || path === '/__dev/access') return { route: `${method} (unmatched)`, res: notFound() };
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

/**
 * Everything the edge does not answer goes to the Store, with the client address hashed and only
 * the identity headers the edge set itself.
 */
async function forward(request: Request, env: Env, ipHash: string, access?: AccessIdentity): Promise<Handled> {
	const headers = storeHeaders(request.headers, {
		ipHash,
		host: access ? 'admin' : 'main',
		requestId: request.headers.get('cf-ray') ?? '',
		access
	});
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

/**
 * The ops channel: GitHub workflows on a protected main post here with a GitHub Actions OIDC token
 * (src/ops.ts checks it); src/ops.ts runs the commands.
 */
async function ops(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const caller = await opsCaller(request, env);
	if (caller instanceof Response) return caller;
	return runOps(request, env, ctx.cache, caller);
}
