// Passive blocking from the signed list: treatments per strictness, live re-application,
// pause, the toolbar count, delta sync and signed adapter configuration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXT_ID, ROOT, devSign, expect, test } from './harness';
import defaults from '../../src/adapters/default-config.json' with { type: 'json' };

const SEARCH = 'https://www.youtube.com/results?search_query=history';

test('Standard hides slop, collapses likely slop and labels AI-made', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	await expect(cards.nth(0)).toHaveAttribute('data-colander', 'hide');
	await expect(cards.nth(0)).toBeHidden();
	await expect(cards.nth(1)).toHaveAttribute('data-colander', 'collapse');
	await expect(cards.nth(1).locator('colander-ui[data-kind="bar"]')).toBeVisible();
	await expect(cards.nth(1).locator('colander-ui[data-kind="bar"]')).toHaveCSS('height', '40px');
	await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	// The platform's own AI label alone gives the AI-made chip (P0-4).
	await expect(cards.nth(4).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	await expect(cards.nth(3).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	const state = await ext.pageState(page);
	expect(state.counts).toEqual({ hidden: 1, collapsed: 1, labeled: 2 });
});

test('changing strictness in the popup re-applies within 1 second, no reload (P0-3)', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	await expect(cards.nth(1)).toHaveAttribute('data-colander', 'collapse');
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await popup.getByRole('radio', { name: 'Strict' }).click();
	const t0 = Date.now();
	await expect(cards.nth(1)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	await expect(cards.nth(2)).toHaveAttribute('data-colander', 'collapse', { timeout: 1000 });
	expect(Date.now() - t0).toBeLessThan(1000);
	await popup.getByRole('radio', { name: 'Label' }).click();
	await expect(cards.nth(0)).not.toHaveAttribute('data-colander', /./, { timeout: 1000 });
	await expect(cards.nth(0).locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await popup.getByRole('radio', { name: 'No AI' }).click();
	await expect(cards.nth(2)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	await expect(cards.nth(4)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
});

test('the toolbar badge counts what is hidden on the page', async ({ ext }) => {
	await ext.setup({ strictness: 'strict' });
	const page = await ext.open(SEARCH);
	const tabId = await ext.tabId(page);
	await expect.poll(() => ext.ctl.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('4');
	await expect.poll(() => ext.ctl.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId)).toBe('Colander, 4 hidden on this page');
});

test('a delta moves the open page without a reload', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const second = page.locator('ytd-search ytd-video-renderer').nth(1);
	await expect(second).toHaveAttribute('data-colander', 'collapse');
	ext.api.delta = true;
	await ext.send({ type: 'sync-now' });
	await expect.poll(() => ext.storage<{ sequence: number }>('listIndex').then((i) => i.sequence)).toBe(43);
	// @catrescuetales went from Likely slop to Slop; the AI-made video left the list.
	await expect(second).toHaveAttribute('data-colander', 'hide');
	const third = page.locator('ytd-search ytd-video-renderer').nth(2);
	await expect(third.locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	const delta = ext.api.sent.filter((s) => s.path.startsWith('/v1/list/'));
	expect(delta.every((s) => s.auth === undefined)).toBe(true);
});

test('a tampered list is rejected and the last good copy stays', async ({ ext }) => {
	await ext.setup();
	await ext.ctx.route('http://localhost:8787/v1/list/delta**', (r) => r.fulfill({ status: 410 }));
	await ext.ctx.route('http://localhost:8787/v1/list/snapshot', async (r) => {
		const body = readFileSync(resolve(ROOT, '../testdata/contract/list-snapshot.bin'));
		body[42] = body[42]! ^ 1;
		await r.fulfill({ status: 200, body });
	});
	await ext.send({ type: 'sync-now' });
	const status = await ext.storage<{ lastError: string; listSequence: number }>('status');
	expect(status.lastError).toMatch(/signature/);
	expect(status.listSequence).toBe(42);
	const page = await ext.open(SEARCH);
	await expect(page.locator('ytd-search ytd-video-renderer').first()).toHaveAttribute('data-colander', 'hide');
});

test('a signed adapter config fixes selectors without a code change (P0-2)', async ({ ext }) => {
	await ext.setup();
	// A redesign renamed the search card element; the bundled selector no longer matches.
	const page = await ext.open(SEARCH);
	await page.evaluate(() => {
		for (const el of document.querySelectorAll('ytd-search ytd-video-renderer')) {
			const renamed = document.createElement('ytd-video-card-renderer');
			renamed.append(...el.childNodes);
			el.replaceWith(renamed);
		}
	});
	await expect(page.locator('ytd-video-card-renderer').first()).not.toHaveAttribute('data-colander', /./);
	const cfg = structuredClone(defaults) as typeof defaults;
	cfg.version = 2;
	const search = cfg.platforms.yt.surfaces.find((s) => s.id === 'yt.search')!;
	search.card = 'ytd-search ytd-video-card-renderer';
	const payload = Buffer.from(JSON.stringify(cfg));
	ext.api.config = { kid: '941afaf31a9c228e', payload: payload.toString('base64'), sig: devSign('colander:config:v1', payload).toString('base64') };
	await ext.send({ type: 'sync-now' });
	await expect.poll(() => ext.storage<{ version: number }>('adapterConfig').then((c) => c?.version)).toBe(2);
	await expect(page.locator('ytd-video-card-renderer').first()).toHaveAttribute('data-colander', 'hide');

	// An unsigned or forged config is ignored.
	ext.api.config = { kid: '941afaf31a9c228e', payload: Buffer.from(JSON.stringify({ ...cfg, version: 9 })).toString('base64'), sig: devSign('colander:config:v1', payload).toString('base64') };
	await ext.send({ type: 'sync-now' });
	expect(await ext.storage<{ version: number }>('adapterConfig').then((c) => c.version)).toBe(2);
});

test('no layout jump: slop cards inserted by infinite scroll are never painted', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/');
	const painted = await page.evaluate(async () => {
		const grid = document.querySelector('ytd-rich-grid-renderer #contents')!;
		const template = grid.querySelector('ytd-rich-item-renderer[data-colander-bridge*="aihistorydaily"]')!;
		let seen = 0;
		for (let i = 0; i < 20; i++) {
			const card = template.cloneNode(true) as Element;
			card.removeAttribute('data-colander');
			card.removeAttribute('data-colander-card');
			card.querySelectorAll('colander-ui').forEach((e) => e.remove());
			grid.append(card);
			// rAF runs after microtasks and before paint: the content script must already have hidden it.
			await new Promise<void>((r) => requestAnimationFrame(() => {
				if (card.getBoundingClientRect().height > 0) seen++;
				r();
			}));
		}
		return seen;
	});
	expect(painted).toBe(0);
});
