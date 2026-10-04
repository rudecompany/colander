// The whole Worker as `wrangler dev` runs it, static assets included: page routing, the SPA shell
// rewrites, the 404 page and response headers, plus the Worker routes behind run_worker_first.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

const build = new URL('../../../web/build/', import.meta.url);
const page = (name: string) => readFileSync(new URL(name, build), 'utf8');

const server = createTestHarness({
	workers: [
		{
			configPath: new URL('../../wrangler.jsonc', import.meta.url),
			// Production-like: no dev routes. Secrets override a developer's api/.dev.vars.
			secrets: { COLANDER_SIGNING_KEY: process.env.COLANDER_SIGNING_KEY!, IP_SALT: 'harness-salt', OPS_TOKEN: 'harness-ops-token', COLANDER_DEV: '' }
		}
	]
});

beforeAll(() => server.listen());
afterAll(() => server.close());

const SECURITY = {
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'x-frame-options': 'DENY',
	'content-security-policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
};

function expectSecurityHeaders(res: { headers: { get(name: string): string | null } }) {
	for (const [k, v] of Object.entries(SECURITY)) expect(res.headers.get(k), k).toBe(v);
}

describe('pages', () => {
	it.each([
		['/', 'index.html'],
		['/definition', 'definition.html'],
		['/plans/welcome', 'plans/welcome.html']
	])('%s serves %s', async (path, file) => {
		const res = await server.fetch(path);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(await res.text()).toBe(page(file));
		expectSecurityHeaders(res);
	});

	it('redirects .html URLs to the clean path', async () => {
		const res = await server.fetch('/definition.html', { redirect: 'manual' });
		expect(res.status).toBe(307);
		expect(res.headers.get('location')).toBe('/definition');
	});

	it.each(['/s/yt/@x', '/s/tt/@someone', '/s/ig/someone', '/s/fb/100064', '/appeal/yt/@x', '/appeal/fb/100064', '/appeal/status/apl_123'])('%s gets the SPA shell with status 200', async (path) => {
		const res = await server.fetch(path, { redirect: 'manual' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(page('200.html'));
		expectSecurityHeaders(res);
	});

	// Only the client-rendered routes get the shell: an unknown platform or a wrong segment count is a
	// real 404, not a soft one. Static Assets first answers an unmatched path holding "@" with a 307 to
	// its percent-encoded form, which is then the 404.
	// The shells themselves are files, not pages: /200 and /404 are not found either.
	it.each(['/no-such-page', '/s/xx/@x', '/s/xx/x', '/s/yt', '/s/yt/@x/extra', '/appeal/yt/@x/extra', '/appeal/status', '/appeal/xx/@x', '/200', '/404'])('answers %s with the 404 page and status 404', async (path) => {
		const res = await server.fetch(path);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe(page('404.html'));
		expect(page('404.html')).toBe(page('200.html'));
		expectSecurityHeaders(res);
	});

	it('caches hashed build assets for a year', async () => {
		const dir = new URL('_app/immutable/entry/', build);
		const file = readdirSync(dir).find((f) => f.endsWith('.js'))!;
		const res = await server.fetch(`/_app/immutable/entry/${file}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
	});
});

describe('Worker routes', () => {
	it('/healthz reaches the Store', async () => {
		const res = await server.fetch('/healthz');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get('cache-control')).toBe('no-store');
		expectSecurityHeaders(res);
	});

	it('serves the snapshot from R2', async () => {
		const env = await server.getWorker<Env>().getEnv();
		const bytes = readFileSync(new URL('../../../testdata/contract/list-snapshot.bin', import.meta.url));
		await env.LISTS.put('list/snapshot.bin', bytes, { customMetadata: { seq: '42' } });
		const res = await server.fetch('/v1/list/snapshot');
		expect(res.status).toBe(200);
		expect(res.headers.get('x-colander-sequence')).toBe('42');
		expect(res.headers.get('cache-control')).toBe('public, max-age=60');
		expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
	});

	it('has no dev routes outside dev mode', async () => {
		const res = await server.fetch('/__dev/seed');
		expect(res.status).toBe(404);
		expect(await res.text()).toBe(page('404.html'));
	});
});

interface Env {
	LISTS: { put(key: string, value: Uint8Array, options: { customMetadata: Record<string, string> }): Promise<unknown> };
}
