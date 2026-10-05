// Firefox smoke test: the Firefox build (pnpm test:firefox builds it against a local API) installs
// in Playwright's Firefox as a temporary add-on, syncs and verifies the signed list, registers its
// content scripts, hides slop on a YouTube page, and holds a tag on the device until Firefox's data
// collection consent allows sending it: Options opens at Sharing, and allowing it sends the tag.
// Playwright cannot open or script add-on pages in Firefox, so those run through the remote
// debugging protocol (rdp.ts), which also grants the consent as Firefox's own prompt would.
import { expect, firefox, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { Rdp } from './rdp';

const ROOT = resolve(import.meta.dirname, '../..');
const DIST = resolve(ROOT, 'dist/firefox-mv3-e2e');
const ID = 'colander@getcolander.com';
/** The same ports the build script uses; both stay inside the range CI and local runs may take. */
const API_PORT = Number(process.env.COLANDER_FF_API_PORT) || 9206;
const RDP_PORT = Number(process.env.COLANDER_FF_RDP_PORT) || 9205;
const SEARCH = 'https://www.youtube.com/results?search_query=history';
const fixture = (name: string) => readFileSync(resolve(ROOT, 'tests/fixtures', name));

/** The API the build talks to: the signed contract list, no adapter config, and tags recorded. */
function api(): Promise<{ server: Server; tags: unknown[] }> {
	const tags: unknown[] = [];
	const server = createServer((req, res) => {
		const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
		if (path === '/v1/list/snapshot') return void res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' }).end(fixture('../../../testdata/contract/list-snapshot.bin'));
		if (path === '/v1/list/delta') return void res.writeHead(204, cors).end();
		if (path === '/v1/tags') {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				const sent = (JSON.parse(body) as { tags: { client_id: string }[] }).tags;
				tags.push(...sent);
				res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: sent.map((t) => t.client_id), rejected: [] }));
			});
			return;
		}
		res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }).end('{"error":{"code":"not_found","message":"Not found."}}');
	});
	return new Promise((done) => server.listen(API_PORT, '127.0.0.1', () => done({ server, tags })));
}

test('the Firefox build blocks from the signed list and sends tags only once sharing is allowed', async () => {
	test.setTimeout(120_000);
	const { server, tags } = await api();
	const ctx = await firefox.launchPersistentContext('', {
		headless: true,
		args: ['-start-debugger-server', String(RDP_PORT)],
		firefoxUserPrefs: { 'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false, 'devtools.chrome.enabled': true }
	});
	const rdp = await Rdp.connect(RDP_PORT);
	try {
		await rdp.install(DIST, ID);

		// The Firefox manifest: the AMO ID, consent kinds Firefox has not granted, the sidebar kept closed.
		const manifest = await rdp.eval<{ id: string; sidebar: unknown; perms: { data_collection: string[] } }>(
			`const m = browser.runtime.getManifest();
			return { id: m.browser_specific_settings.gecko.id, sidebar: m.sidebar_action, perms: await browser.permissions.getAll() };`
		);
		expect(manifest.id).toBe(ID);
		expect(manifest.sidebar).toMatchObject({ default_panel: expect.stringMatching(/\/sidepanel\.html$/), default_title: 'Colander review', open_at_install: false });
		expect(manifest.perms.data_collection).toEqual([]);

		// First run opened the welcome page; YouTube is switched on, and the install synced the list.
		await expect.poll(() => rdp.eval<string>(`return document.querySelector('h1')?.textContent ?? '';`, /\/welcome\.html$/)).toBe('Set up Colander in 3 steps.');
		await rdp.eval(`await browser.storage.local.set({ settings: { platforms: { yt: true, tt: false, ig: false, fb: false }, onboarded: true } });`);
		await expect.poll(() => rdp.eval<number | null>(`return (await browser.storage.local.get('listIndex')).listIndex?.sequence ?? null;`)).toBe(42);
		await expect.poll(() => rdp.eval<string[]>(`return (await browser.scripting.getRegisteredContentScripts()).map((s) => s.id).sort();`)).toEqual(['cl-yt', 'cl-yt-bridge']);

		await ctx.route(/^https:\/\/www\.youtube\.com\//, (route) => {
			const url = new URL(route.request().url());
			if (url.pathname.startsWith('/__fixture__/')) return route.fulfill({ contentType: 'text/css', body: fixture(`styles/${url.pathname.slice(13)}`) });
			if (url.pathname === '/results') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture('yt-search.html') });
			return route.fulfill({ status: 404, body: '' });
		});
		const page = await ctx.newPage();
		await page.goto(SEARCH);
		const cards = page.locator('ytd-search ytd-video-renderer');
		await expect(cards.nth(0)).toHaveAttribute('data-colander', 'hide');
		await expect(cards.nth(1)).toHaveAttribute('data-colander', 'hide');
		await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');

		// A tag applies at once and waits on the device: Firefox has not allowed sending it.
		const card = cards.nth(3);
		await card.hover();
		await card.locator('colander-ui[data-kind="tag"] button').click();
		const layer = page.locator('colander-ui[data-kind="layer"]');
		await layer.locator('.cl-pop').getByRole('menuitem', { name: /^Slop/ }).click();
		await expect(card).toHaveAttribute('data-colander', 'hide');
		await layer.locator('.cl-toast').getByRole('button', { name: 'Close' }).click();
		await expect.poll(() => rdp.eval<string[]>(`return Object.keys((await browser.storage.local.get('ownTags')).ownTags ?? {});`)).toHaveLength(1);

		// Once the tag is due, Options opens at Sharing, which counts it; nothing went to the server.
		await expect
			.poll(() => rdp.eval<string>(`return document.querySelector('main')?.innerText ?? '';`, /\/options\.html#sharing$/), { timeout: 20_000 })
			.toContain('1 tag waits on this device, sent once you allow it.');
		const sharing = await rdp.eval<string>(`return document.querySelector('main').innerText;`, /\/options\.html#sharing$/);
		expect(sharing).toContain('Allow tags and reports');
		expect(sharing).toContain('Allow Plus and review');
		expect(tags).toEqual([]);

		// Allowing it, as the Allow button or about:addons does, sends the tag that waited.
		await rdp.evalChrome(`
			const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
			await ExtensionPermissions.add('${ID}', { permissions: [], origins: [], data_collection: ['websiteContent'] }, WebExtensionPolicy.getByID('${ID}').extension);
		`);
		await expect.poll(() => tags.length).toBe(1);
		expect(tags[0]).toMatchObject({ platform: 'yt', verdict: 'slop', ext_version: '1.0.0' });
		await expect.poll(() => rdp.eval<string>(`return document.querySelector('main')?.innerText ?? '';`, /\/options\.html#sharing$/)).not.toContain('Allow tags and reports');
	} finally {
		rdp.close();
		await ctx.close();
		server.close();
	}
});
