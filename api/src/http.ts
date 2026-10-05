// HTTP helpers shared by the edge Worker and the Store: JSON errors, cache policies, CORS and
// security headers (contracts section 6, hosting plan section 2).

/** Set by the edge on every request it forwards to the Store; never trusted from clients. */
export const IP_HASH_HEADER = 'x-colander-ip-hash';
/** Set by the Store on its responses so the edge logs the route pattern, then removed. */
export const ROUTE_HEADER = 'x-colander-route';

/**
 * The part of a client address that per-IP limits count: an IPv4 address whole, an IPv6 address
 * by its /64, since one host or home line usually holds a whole /64 and could rotate through it.
 * An IPv4-mapped IPv6 address counts as its IPv4 address. Anything unparsable is kept as it is.
 */
export function ipKey(ip: string): string {
	if (!ip.includes(':')) return ip;
	let s = ip.toLowerCase();
	let tail: number[] = [];
	const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (v4) {
		const b = v4.slice(2).map(Number) as [number, number, number, number];
		if (b.some((x) => x > 255)) return ip;
		tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
		s = v4[1]!.endsWith('::') ? v4[1]! : v4[1]!.slice(0, -1);
	}
	const halves = s.split('::');
	if (halves.length > 2) return ip;
	const words = (h: string) => (h === '' ? [] : h.split(':').map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN)));
	const head = words(halves[0]!);
	const back = [...(halves.length === 2 ? words(halves[1]!) : []), ...tail];
	const gap = 8 - head.length - back.length;
	if (halves.length === 2 ? gap < 1 : gap !== 0) return ip;
	const all = [...head, ...Array<number>(gap).fill(0), ...back];
	if (all.some(Number.isNaN)) return ip;
	if (all.slice(0, 5).every((w) => w === 0) && all[5] === 0xffff) return [all[6]! >> 8, all[6]! & 255, all[7]! >> 8, all[7]! & 255].join('.');
	return `${all.slice(0, 4).map((w) => w.toString(16)).join(':')}::/64`;
}

/**
 * Cache policies. `Cache-Control` is what clients see (contract 3.2); Workers Cache obeys
 * `Cloudflare-CDN-Cache-Control` first and strips it. Never use s-maxage, must-revalidate or
 * proxy-revalidate: they turn off stale serving. Everything without a policy is `no-store`.
 */
const POLICIES = {
	/** List 200 and 204: 15 s at the edge keeps a verified appeal under a minute to installs. */
	list: { client: 'public, max-age=60', edge: 'public, max-age=15, stale-if-error=86400' },
	/** Delta 410: briefly at the edge only; without a header the edge would keep it 3 minutes. */
	gone: { client: 'no-store', edge: 'public, max-age=15' },
	/** The signed adapter configuration; the extension rarely asks and keeps its bundled copy meanwhile. */
	config: { client: 'public, max-age=300', edge: 'public, max-age=300, stale-if-error=86400' },
	/** GETs that are the same for every viewer: /v1/sources/*, /v1/log, /v1/stats and /v1/supporters. */
	public: { client: 'public, max-age=60', edge: 'public, max-age=60' }
} as const;

export type CachePolicy = keyof typeof POLICIES;

export function setCache(headers: Headers, policy: CachePolicy): Headers {
	headers.set('Cache-Control', POLICIES[policy].client);
	headers.set('Cloudflare-CDN-Cache-Control', POLICIES[policy].edge);
	return headers;
}

/** A JSON body the way Go's json.Encoder writes it, `no-store` unless headers say otherwise. */
export function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
	const h = new Headers(headers);
	h.set('Content-Type', 'application/json');
	if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
	return new Response(JSON.stringify(body) + '\n', { status, headers: h });
}

/** `{"error": {"code", "message"}}` (contract 6). */
export function jsonError(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
	return json(status, { error: { code, message } }, headers);
}

export const notFound = () => jsonError(404, 'not_found', 'There is no API route for this method and path.');

export function tooMany(retryAfterSeconds: number): Response {
	return jsonError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.', {
		'Retry-After': String(Math.ceil(retryAfterSeconds))
	});
}

// Routes the extension calls from any origin (contract 6); the rest are same-origin only.
const CORS_PREFIXES = ['/v1/list/', '/v1/config/', '/v1/tags', '/v1/reports', '/v1/trial', '/v1/entitlement/refresh', '/v1/sync', '/v1/review/', '/v1/sources/', '/v1/pair/claim'];

export function isCorsPath(path: string): boolean {
	return CORS_PREFIXES.some((pre) => path === pre || (path.startsWith(pre) && (pre.endsWith('/') || path[pre.length] === '/')));
}

/** The preflight answer. Workers Cache never stores OPTIONS, so preflights must stay cheap. */
export function preflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
			'Access-Control-Allow-Headers': 'Authorization, Content-Type',
			// Chromium caps preflight caching at 2 hours.
			'Access-Control-Max-Age': '7200'
		}
	});
}

// The same set web/static/_headers gives the website, for responses the Worker generates.
const SECURITY_HEADERS = {
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
};

/**
 * Final touches on every Worker response: security headers, CORS on extension routes, `no-store`
 * unless a cache policy was set, and no body for HEAD.
 */
export function finish(res: Response, method: string, path: string): Response {
	const out = new Response(method === 'HEAD' ? null : res.body, res);
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
	if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store');
	if (isCorsPath(path)) {
		out.headers.set('Access-Control-Allow-Origin', '*');
		out.headers.set('Access-Control-Expose-Headers', 'X-Colander-Sequence, Retry-After');
	}
	out.headers.delete(ROUTE_HEADER);
	return out;
}
