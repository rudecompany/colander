// The performance budget, measured on the production build the tests serve: at most 40 requests on
// /, no image requests except the favicon and the 8 demo thumbnails (about 100 KB in all, the AI-
// generated illustrations the demo feed discloses), at most 110 KB of JavaScript and 24 KB of CSS
// gzipped on every route, and at most 300 KB transferred with brotli on /.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { test, expect } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

const BUILD = join(import.meta.dirname, '..', 'build');
const KB = 1024;

/** Every same-origin file a page loads, read from build/ the way the server sends it. */
async function load(page: import('@playwright/test').Page, path: string) {
	const urls: { url: URL; type: string }[] = [];
	page.on('request', (r) => urls.push({ url: new URL(r.url()), type: r.resourceType() }));
	await page.goto(path);
	await page.waitForLoadState('networkidle');
	const file = (u: URL) => {
		if (u.pathname.startsWith('/v1/')) return null;
		const p = u.pathname === '/' ? '/index.html' : u.pathname;
		for (const c of [p, `${p}.html`, `${p}/index.html`, '/200.html']) {
			try {
				return readFileSync(join(BUILD, c));
			} catch {
				// Try the next lookup, as the server does.
			}
		}
		return null;
	};
	return urls.map(({ url, type }) => ({ url, type, body: file(url) }));
}

const gz = (b: Buffer | null) => (b ? gzipSync(b).length : 0);

test('/ stays within its request, image and transfer budget', async ({ page }) => {
	await mockApi(page);
	const files = await load(page, '/');
	expect(files.length, 'requests on /').toBeLessThanOrEqual(40);

	const images = files.filter((f) => f.type === 'image');
	const thumbs = images.filter((f) => /\/_app\/immutable\/assets\/[\w-]+\.[\w-]+\.webp$/.test(f.url.pathname));
	expect(images.filter((f) => !thumbs.includes(f) && f.url.pathname !== '/favicon.svg').map((f) => f.url.pathname), 'other images').toEqual([]);
	expect(thumbs.length, 'demo thumbnails').toBeLessThanOrEqual(8);
	expect(thumbs.reduce((n, f) => n + (f.body?.length ?? 0), 0), 'thumbnail bytes').toBeLessThanOrEqual(110 * KB);

	const css = files.filter((f) => f.url.pathname.endsWith('.css')).reduce((n, f) => n + gz(f.body), 0);
	expect(css, 'CSS gzip on /').toBeLessThanOrEqual(24 * KB);
	// Images are already compressed, so they count as they are.
	const brotli = files.reduce((n, f) => n + (f.body ? (f.type === 'image' || f.type === 'font' ? f.body.length : brotliCompressSync(f.body).length) : 0), 0);
	expect(brotli, 'brotli transfer on /').toBeLessThanOrEqual(300 * KB);
});

for (const [path, mocks] of PAGES) {
	test(`${path} loads at most 110 KB of JavaScript`, async ({ page }) => {
		await mockApi(page, mocks);
		const files = await load(page, path);
		const js = files.filter((f) => f.url.pathname.endsWith('.js')).reduce((n, f) => n + gz(f.body), 0);
		expect(js, `JS gzip on ${path}`).toBeLessThanOrEqual(110 * KB);
	});
}
