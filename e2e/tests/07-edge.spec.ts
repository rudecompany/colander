// The edge (hosting plan sections 2 and 4): the website's SPA rewrites and real 404, the _headers
// on static pages, the cache policy of every list answer, and a verified appeal reaching installs
// within a minute. These run against the local Worker and against a deployed origin
// (COLANDER_E2E_BASE_URL). Only the appeal timing writes: it needs a staff credential, the local
// staff session or COLANDER_REVIEWER_TOKEN, and against a deployed origin COLANDER_PUBLIC_KEYS.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseList, targetHash, trustedKeys } from '../../scripts/smoke.ts';
import { BASE_URL, REPO, api, http } from './stack.ts';

test.describe.configure({ mode: 'serial' });

/** Locally the edge cache headers are still on the response; a deployed edge consumes them. */
const LOCAL = !BASE_URL;
const nonce = crypto.randomUUID().slice(0, 8);

/** Fetches without following redirects and reads the body, so headers and status are as served. */
async function get(path: string, init: RequestInit = {}): Promise<{ res: Response; body: Buffer }> {
	const res = await http(path, { redirect: 'manual', ...init });
	return { res, body: Buffer.from(await res.arrayBuffer()) };
}

const SECURITY_HEADERS = {
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'DENY'
};

function expectSecurityHeaders(res: Response, what: string): void {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), `${name} on ${what}`).toBe(value);
	const csp = res.headers.get('content-security-policy') ?? '';
	for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) expect(csp, `CSP on ${what}`).toContain(directive);
	// Script hashes stay in each page's CSP meta tag; the header must not narrow script-src.
	expect(csp, `CSP on ${what}`).not.toContain('script-src');
}

test('source and appeal pages are the app shell with 200, and unknown paths are a real 404', async () => {
	const shell = await get('/200');
	expect(shell.res.status).toBe(200);
	expect(shell.res.headers.get('content-type')).toMatch(/^text\/html/);
	expect(shell.body.toString()).toMatch(/<html/i);
	for (const path of ['/s/yt/@aihistorydaily', '/s/tt/@petpalsai', '/appeal/yt/@aihistorydaily', '/appeal/status/apl_e2e?secret=x']) {
		const page = await get(path);
		expect(page.res.status, path).toBe(200);
		expect(page.res.headers.get('content-type'), path).toMatch(/^text\/html/);
		expect(page.body.equals(shell.body), `${path} is the app shell`).toBe(true);
	}
	// Only the client-rendered routes get the shell: an unknown platform or a wrong segment count is a 404.
	for (const path of [`/no-such-page-${nonce}`, `/s-${nonce}`, `/appealing/${nonce}`, `/s/xx/${nonce}`, '/s/yt', `/appeal/yt/${nonce}/extra`]) {
		const page = await get(path);
		expect(page.res.status, path).toBe(404);
		expect(page.res.headers.get('content-type'), path).toMatch(/^text\/html/);
		// 404.html is a copy of the shell, so the app can still render a not-found page.
		expect(page.body.equals(shell.body), `${path} answers with the shell`).toBe(true);
	}
	// An unknown API path is the API's JSON 404, not the website's.
	const apiMissing = await get(`/v1/no-such-route-${nonce}`);
	expect(apiMissing.res.status).toBe(404);
	expect(JSON.parse(apiMissing.body.toString())).toMatchObject({ error: { code: 'not_found' } });
});

test('static pages carry the _headers, and hashed assets are cached for a year', async () => {
	const home = await get('/');
	expect(home.res.status).toBe(200);
	expectSecurityHeaders(home.res, '/');
	for (const path of ['/privacy', '/s/yt/@aihistorydaily', `/no-such-page-${nonce}`]) expectSecurityHeaders((await get(path)).res, path);

	// SvelteKit links them relative to the page (./_app/immutable/...).
	const asset = /(?:src|href)="\.?(\/_app\/immutable\/[^"]+)"/.exec(home.body.toString())?.[1];
	expect(asset, 'the home page links a hashed asset').toBeTruthy();
	const res = (await get(asset!)).res;
	expect(res.status).toBe(200);
	expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
	expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

/** The list policies of hosting plan section 2: [Cache-Control, Cloudflare-CDN-Cache-Control]. */
const LIST = ['public, max-age=60', 'public, max-age=15, stale-if-error=86400'] as const;
const GONE = ['no-store', 'public, max-age=15'] as const;

function expectPolicy(res: Response, [client, edge]: readonly [string, string], what: string): void {
	expect(res.headers.get('cache-control'), `Cache-Control on ${what}`).toBe(client);
	if (LOCAL) expect(res.headers.get('cloudflare-cdn-cache-control'), `Cloudflare-CDN-Cache-Control on ${what}`).toBe(edge);
}

test('list answers carry their cache policy: snapshot 200, delta 204 at the head and 410 past it', async () => {
	const snapshot = await get('/v1/list/snapshot');
	expect(snapshot.res.status).toBe(200);
	expectPolicy(snapshot.res, LIST, 'the snapshot');
	const head = BigInt(snapshot.res.headers.get('x-colander-sequence')!);

	const current = await get(`/v1/list/delta?since=${head}`);
	// A publication between the two requests makes this a 200; that delta carries the list policy too.
	expect([200, 204], 'delta from the head').toContain(current.res.status);
	expectPolicy(current.res, LIST, `delta ${current.res.status}`);

	// A base past the head that no list had (the edge refuses one more than 60 s ahead with 400).
	const ahead = await get(`/v1/list/delta?since=${head + 1n}`);
	expect(ahead.res.status).toBe(410);
	expectPolicy(ahead.res, GONE, 'delta 410');
	expect(JSON.parse(ahead.body.toString())).toMatchObject({ error: { code: expect.any(String) } });
});

test('a verified appeal reaches installs as a signed delta within 60 s', async () => {
	const token = process.env.COLANDER_REVIEWER_TOKEN;
	test.skip(!LOCAL && !(token && process.env.COLANDER_PUBLIC_KEYS), 'needs COLANDER_REVIEWER_TOKEN and COLANDER_PUBLIC_KEYS against a deployed origin');
	const staff = LOCAL ? { cookie: process.env.COLANDER_E2E_STAFF_COOKIE } : { auth: `Bearer ${token}` };
	const keys = trustedKeys(process.env.COLANDER_PUBLIC_KEYS ?? readFileSync(resolve(REPO, 'testdata/dev-signing.pub'), 'utf8'));
	// A fictional channel only this test uses, rated Slop by staff so it can be appealed.
	const handle = '@colander-e2e-appeal';
	const hash = targetHash(`yt:s:${handle}`);
	const SLOP = 1;
	const DISPUTED = 4;

	/** Polls the delta from `since` until the channel has `verdict`; returns the delta's answer. */
	async function untilListed(since: bigint, verdict: number, deadline: number): Promise<{ res: Response; sequence: bigint }> {
		for (;;) {
			const { res, body } = await get(`/v1/list/delta?since=${since}`);
			expect([200, 204], `delta from ${since}`).toContain(res.status);
			if (res.status === 200) {
				const list = parseList(body, keys);
				if (list.entries.some((e) => e.hash === hash && e.verdict === verdict)) return { res, sequence: list.sequence };
			}
			expect(Date.now(), `verdict ${verdict} in a delta from ${since}`).toBeLessThan(deadline);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	const head = async () => BigInt((await get('/v1/list/snapshot', { method: 'HEAD' })).res.headers.get('x-colander-sequence')!);

	// A run before this one left it Slop; otherwise staff rate it and the list takes it.
	let base = await head();
	const current = await api<{ source?: { verdict: string } }>(`/v1/review/sources/yt/${handle}`, staff);
	if (current.json?.source?.verdict !== 'slop') {
		const decided = await api(`/v1/review/sources/yt/${handle}/decision`, {
			...staff,
			body: { verdict: 'slop', reason: `Full-stack edge test ${nonce}: rated Slop so it can be appealed.`, signals: ['watermark'] }
		});
		expect(decided.status, JSON.stringify(decided.json)).toBe(200);
		base = (await untilListed(base, SLOP, Date.now() + 90_000)).sequence;
	}

	const filed = await api<{ appeal: { id: string } }>('/v1/appeals', {
		body: { platform: 'yt', source_id: handle, email: 'creator@colander-e2e.example.test', statement: `This is my channel (${nonce}).` }
	});
	expect(filed.status, JSON.stringify(filed.json)).toBe(201);
	const id = filed.json.appeal.id;

	const verifiedAt = Date.now();
	const verified = await api(`/v1/review/appeals/${id}/verify`, { ...staff, method: 'POST' });
	expect(verified.status, JSON.stringify(verified.json)).toBe(200);
	const reached = await untilListed(base, DISPUTED, verifiedAt + 60_000);
	const seconds = (Date.now() - verifiedAt) / 1000;
	console.log(`a verified appeal reached the edge after ${seconds.toFixed(1)} s`);
	expect(seconds).toBeLessThan(60);
	// The delta that brought the change carries the list policy.
	expectPolicy(reached.res, LIST, 'delta 200');

	// Close the appeal; denial restores Slop, ready for the next run.
	const resolved = await api(`/v1/review/appeals/${id}/resolve`, {
		...staff,
		body: { outcome: 'denied', reasoning: `Full-stack edge test ${nonce}: closing the test appeal.` }
	});
	expect(resolved.status, JSON.stringify(resolved.json)).toBe(200);
});
