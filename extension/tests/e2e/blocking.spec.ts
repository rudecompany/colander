// Passive blocking from the signed list: treatments per strictness, live re-application,
// pause, the toolbar count, delta sync and signed adapter configuration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXT_ID, ROOT, devSign, expect, test } from './harness';
import defaults from '../../src/adapters/default-config.json' with { type: 'json' };
import type { PageAction } from '../../src/lib/messages';

const SEARCH = 'https://www.youtube.com/results?search_query=history';

test('Standard hides slop and likely slop without a trace, and labels AI-made', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	for (const n of [0, 1]) {
		await expect(cards.nth(n)).toHaveAttribute('data-colander', 'hide');
		await expect(cards.nth(n)).toBeHidden();
		await expect(cards.nth(n).locator('colander-ui')).toHaveCount(0);
	}
	// The list closes up: the first card left starts where the first card did.
	expect(await page.evaluate(() => {
		const list = [...document.querySelectorAll('ytd-search ytd-video-renderer')];
		return list[2]!.getBoundingClientRect().top - list[0]!.parentElement!.getBoundingClientRect().top;
	})).toBeLessThan(1);
	await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	// The platform's own AI label alone gives the AI-made chip (P0-4).
	await expect(cards.nth(4).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	await expect(cards.nth(3).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	const state = await ext.pageState(page);
	expect(state.counts).toEqual({ hidden: 2, labeled: 2 });
	// Nothing is lost: both hidden items are in the page's actions, which the popup lists with Show.
	expect(state.actions.filter((a: PageAction) => a.action === 'hide').map((a: PageAction) => a.verdict)).toEqual(['slop', 'likely_slop']);
});

test('YouTube home and subscriptions grids close up and reflow, so every row stays full', async ({ ext }) => {
	await ext.setup();
	for (const [url, hidden] of [['https://www.youtube.com/', 3], ['https://www.youtube.com/feed/subscriptions', 1]] as const) {
		const page = await ext.open(url);
		await expect(page.locator('[data-colander="hide"]')).toHaveCount(hidden);
		await expect(page.locator('[data-colander-reflow]')).toHaveCount(1);
		// Laid out as it paints: visible cards and the full-width shelf, top to bottom, left to right.
		const layout = await page.evaluate(() => {
			const box = document.querySelector('[data-colander-reflow]')!;
			const r0 = box.getBoundingClientRect();
			return [...box.children]
				.filter((el) => el.getBoundingClientRect().height > 0)
				.map((el) => {
					const r = el.getBoundingClientRect();
					return { shelf: el.tagName === 'YTD-RICH-SECTION-RENDERER', top: Math.round(r.top), left: Math.round(r.left - r0.left), width: Math.round(r.width) };
				})
				.sort((a, b) => a.top - b.top || a.left - b.left);
		});
		const rows = new Map<number, typeof layout>();
		for (const el of layout) rows.set(el.top, [...(rows.get(el.top) ?? []), el]);
		const list = [...rows.values()];
		const shelf = list.findIndex((row) => row[0]!.shelf);
		expect(shelf, 'the shelf is still on the page').toBeGreaterThan(0);
		// Every row above the shelf is full, its 4 cards in YouTube's own columns.
		const columns = list[0]!.map((el) => el.left);
		expect(columns).toHaveLength(4);
		for (const row of list.slice(0, shelf)) expect(row.map((el) => el.left)).toEqual(columns);
		// The first column stays flush left, the others keep YouTube's 8 px margin.
		expect(columns[0]).toBe(0);
	}
});

test('changing strictness in the popup re-applies within 1 second, no reload (P0-3)', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	await expect(cards.nth(1)).toHaveAttribute('data-colander', 'hide');
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await expect(popup.getByRole('radio')).toHaveText(['Label', 'Standard', 'No AI']);
	await popup.getByRole('radio', { name: 'No AI' }).click();
	const t0 = Date.now();
	await expect(cards.nth(2)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	await expect(cards.nth(4)).toHaveAttribute('data-colander', 'hide', { timeout: 1000 });
	expect(Date.now() - t0).toBeLessThan(1000);
	await popup.getByRole('radio', { name: 'Label' }).click();
	await expect(cards.nth(0)).not.toHaveAttribute('data-colander', /./, { timeout: 1000 });
	await expect(cards.nth(0).locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
});

test('the toolbar badge counts what is hidden on the page', async ({ ext }) => {
	await ext.setup({ strictness: 'no_ai' });
	const page = await ext.open(SEARCH);
	const tabId = await ext.tabId(page);
	await expect.poll(() => ext.ctl.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('4');
	await expect.poll(() => ext.ctl.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId)).toBe('Colander, 4 hidden on this page');
});

test('a delta moves the open page without a reload', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const second = page.locator('ytd-search ytd-video-renderer').nth(1);
	await expect(second).toHaveAttribute('data-colander', 'hide');
	const third = page.locator('ytd-search ytd-video-renderer').nth(2);
	await expect(third.locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	ext.api.delta = true;
	await ext.send({ type: 'sync-now' });
	await expect.poll(() => ext.storage<{ sequence: number }>('listIndex').then((i) => i.sequence)).toBe(43);
	// @catrescuetales went from Likely slop to Slop and stays hidden; the AI-made video left the list.
	await expect(second).toHaveAttribute('data-colander', 'hide');
	await expect.poll(() => ext.pageState(page).then((s) => s.actions.find((a: PageAction) => a.sourceId === '@catrescuetales')?.verdict)).toBe('slop');
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
	expect(status.lastError).toBe('the downloaded list did not pass its signature check');
	expect(status.listSequence).toBe(42);
	const page = await ext.open(SEARCH);
	await expect(page.locator('ytd-search ytd-video-renderer').first()).toHaveAttribute('data-colander', 'hide');
});

test('an unreachable list server is explained in plain words and the last good copy stays', async ({ ext }) => {
	await ext.setup();
	ext.api.offline = true;
	await ext.send({ type: 'sync-now' });
	const status = await ext.storage<{ lastError: string; listSequence: number }>('status');
	expect(status.lastError).toBe('the list server could not be reached');
	expect(status.listSequence).toBe(42);
	const options = await ext.ctx.newPage();
	await options.goto(`chrome-extension://${EXT_ID}/options.html`);
	await expect(options.getByText('The last update failed: the list server could not be reached. Colander keeps using the last good copy.')).toBeVisible();
	await expect(options.getByText(/Failed to fetch|HTTP \d/)).toHaveCount(0);
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

/**
 * Where a hidden card sits inside a wrapper of the page's own (a grid cell), the wrapper goes too:
 * the cells left are packed from the container's start, rows full, with the container's own gap.
 */
function packedProblems(page: import('@playwright/test').Page, card: string) {
	return page.evaluate((sel) => {
		const hidden = document.querySelector(sel)!;
		let cell: Element = hidden;
		while (cell.parentElement?.hasAttribute('data-colander-slot')) cell = cell.parentElement;
		const out: string[] = [];
		if (cell === hidden) out.push('no wrapper was hidden with the card');
		if (cell.getBoundingClientRect().width > 0) out.push('the hidden cell still has a box');
		const box = cell.parentElement!;
		const cs = getComputedStyle(box);
		const gap = parseFloat(cs.columnGap) || 0;
		const r0 = box.getBoundingClientRect();
		const start = r0.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
		const end = r0.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
		const cells = [...box.children].map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0);
		cells.forEach((r, i) => {
			const prev = cells[i - 1];
			const sameRow = !!prev && Math.abs(prev.top - r.top) < 1;
			const want = sameRow ? prev!.right + gap : start;
			if (Math.abs(r.left - want) > 1) out.push(`cell ${i} starts at ${Math.round(r.left)}, not ${Math.round(want)}`);
			if (prev && !sameRow && prev.right + gap + r.width <= end + 1) out.push(`row ends early before cell ${i}`);
		});
		return out;
	}, card);
}

test('a hidden item takes its grid cell with it: Instagram Explore, TikTok profiles and the Shorts shelf', async ({ ext }) => {
	await ext.setup({
		platforms: ['yt', 'tt', 'ig'],
		settings: { blocks: ['ig:i:C9aiWorld01', 'tt:i:7691450773619625247', 'yt:i:JEk-AYHbkmQ'].map((key) => ({ key, at: 1 })) }
	});
	for (const [url, card] of [
		['https://www.instagram.com/explore/', 'main a[href="/p/C9aiWorld01/"]'],
		['https://www.tiktok.com/@tiktok', '[data-e2e="user-post-item"]:has(a[href$="/7691450773619625247"])'],
		[SEARCH, 'ytm-shorts-lockup-view-model:has(a[href="/shorts/JEk-AYHbkmQ"])']
	] as const) {
		const page = await ext.open(url);
		await expect(page.locator(card).first()).toHaveAttribute('data-colander', 'hide');
		expect(await packedProblems(page, card), url).toEqual([]);
		// Show from the popup brings the card back in its own cell, with its chip.
		const hidden = (await ext.pageState(page)).actions.find((a: PageAction) => a.action === 'hide' && a.reason === 'my_list');
		await ext.ctl.evaluate(async ([tabId, id]) => chrome.tabs.sendMessage(tabId, { type: 'show', id }), [await ext.tabId(page), hidden.id] as const);
		await expect(page.locator(card).first()).toBeVisible();
		await expect(page.locator('[data-colander-slot]')).toHaveCount(0);
	}
});
