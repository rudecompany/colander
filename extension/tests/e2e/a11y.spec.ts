// Accessibility (P0-14, WCAG 2.2 AA): axe-core over every extension page and every element the
// extension adds to a platform page, in light and dark. Platform fixtures are not ours, so the
// in-page checks cover only the colander-ui hosts and their shadow roots.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, expect, test, type Ext } from './harness';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SECTIONS = ['lists', 'platforms', 'strictness', 'plus', 'appearance', 'plan', 'reports', 'data', 'privacy'];

/** Violations as readable lines, so a failure says what and where. */
async function audit(page: Page, include?: string): Promise<string[]> {
	// Extension pages in their resting colors: the pointer leaves whatever the last click left it
	// over. In-page checks keep it, since the Tag button shows only on hover.
	if (!include) await page.mouse.move(0, 0);
	// The layer (popovers, notices, the report dialog) lives under <html>, outside <body>, where
	// axe cannot work out colors. It is position: fixed, so moving it into <body> changes nothing
	// on screen and lets axe check its contrast too.
	await page.evaluate(() => {
		const layer = document.querySelector('colander-ui[data-kind="layer"]');
		if (layer?.parentElement === document.documentElement) document.body.append(layer);
	});
	let builder = new AxeBuilder({ page }).withTags(TAGS);
	if (include) builder = builder.include(include);
	const { violations } = await builder.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' > ')}: ${n.failureSummary?.replace(/\s+/g, ' ')}`));
}

async function richState(ext: Ext) {
	await ext.setup({ platforms: ['yt'] });
	await ext.send({ type: 'start-trial' });
	const day = (n: number) => {
		const d = new Date(Date.now() - n * 86_400_000);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};
	await ext.ctl.evaluate(
		({ days }) => chrome.storage.local.set({ stats: { firstRunAt: Date.now() - 9 * 86_400_000, days } }),
		{ days: Object.fromEntries([18, 31, 24, 40, 12, 27, 35].map((n, i) => [day(6 - i), { hidden: n, labeled: n * 2 }])) }
	);
	await ext.send({
		type: 'settings',
		patch: {
			topics: [{ id: 't1', name: 'Kids', terms: ['#kids', 'cartoon'], strictness: 'no_ai', hide: false }],
			perPlatform: { tt: 'no_ai' },
			blocks: [{ key: 'yt:s:@endlessfacts', name: 'Endless Facts', at: Date.now() }],
			allows: [{ key: 'yt:s:@handmadehistory', name: 'Handmade History', at: Date.now() }]
		}
	});
	ext.api.reports = [
		{ id: 'rpt_2', platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' },
		{ id: 'rpt_1', platform: 'tt', source_id: '@sloppyfacts', source_name: 'Sloppy Facts', status: 'slop', verdict: 'slop', protects: 12840, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' }
	];
}

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		// Reduced motion: axe reads colors mid-fade otherwise. The resting colors are the same.
		test.use({ colorScheme: scheme, reducedMotion: 'reduce' });

		test(`popup and options pass axe, ${scheme}`, async ({ ext }) => {
			// Fourteen full-page audits: more than the default minute when the suite runs in parallel.
			test.slow();
			const page = await ext.ctx.newPage();
			await page.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
			await expect(page.getByRole('button', { name: 'Start 14 days free' })).toBeVisible();
			expect.soft(await audit(page), 'options #plus, free').toEqual([]);
			await page.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
			await expect(page.getByRole('heading', { name: 'Current plan: Free' })).toBeVisible();
			expect.soft(await audit(page), 'options #plan, free').toEqual([]);

			await richState(ext);
			const yt = await ext.open('https://www.youtube.com/results?search_query=history');
			await page.setViewportSize({ width: 360, height: 760 });
			await page.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(yt)}`);
			await expect(page.getByText(/slop items this week/)).toBeVisible();
			expect.soft(await audit(page), 'popup').toEqual([]);
			await page.getByRole('button', { name: 'Pause' }).click();
			await expect(page.getByRole('menuitem', { name: 'Pause on this site' })).toBeVisible();
			expect.soft(await audit(page), 'popup, pause menu').toEqual([]);
			await page.keyboard.press('Escape');

			await page.setViewportSize({ width: 1200, height: 860 });
			for (const s of SECTIONS) {
				await page.goto(`chrome-extension://${EXT_ID}/options.html#${s}`);
				await expect(page.locator('main h1, main h2').first()).toBeVisible();
				await page.waitForTimeout(150);
				expect.soft(await audit(page), `options #${s}`).toEqual([]);
			}

			await page.goto(`chrome-extension://${EXT_ID}/options.html#data`);
			await page.getByRole('button', { name: 'Delete local data' }).click();
			await expect(page.getByRole('dialog')).toBeVisible();
			expect.soft(await audit(page), 'options #data, confirm').toEqual([]);
		});

		test(`welcome and side panel pass axe, ${scheme}`, async ({ ext }) => {
			const page = await ext.ctx.newPage();
			await page.setViewportSize({ width: 1200, height: 860 });
			await page.goto(`chrome-extension://${EXT_ID}/welcome.html`);
			await expect(page.getByRole('heading', { name: 'Set up Colander in 3 steps.' })).toBeVisible();
			expect.soft(await audit(page), 'welcome, strictness').toEqual([]);
			await page.getByRole('button', { name: 'Continue' }).click();
			await expect(page.getByRole('heading', { name: 'Where should it work?' })).toBeVisible();
			expect.soft(await audit(page), 'welcome, platforms').toEqual([]);
			await page.getByRole('button', { name: 'Continue' }).click();
			await expect(page.getByRole('heading', { name: 'Pin Colander' })).toBeVisible();
			expect.soft(await audit(page), 'welcome, pin').toEqual([]);

			await page.setViewportSize({ width: 400, height: 900 });
			await page.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
			await expect(page.getByText('Review for curators')).toBeVisible();
			expect.soft(await audit(page), 'side panel, signed out').toEqual([]);
			ext.api.review.queue = REVIEW_QUEUE();
			ext.api.review.source = REVIEW_SOURCE;
			await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
			await page.reload();
			await page.getByRole('button', { name: /Cat Rescue Tales/ }).waitFor();
			expect.soft(await audit(page), 'side panel, queue').toEqual([]);
			await page.getByRole('button', { name: /Cat Rescue Tales/ }).click();
			await expect(page.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
			expect.soft(await audit(page), 'side panel, evidence and decision').toEqual([]);
			await page.keyboard.press('?');
			await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
			expect.soft(await audit(page), 'side panel, shortcuts').toEqual([]);
		});

		test(`in-page elements pass axe, ${scheme}`, async ({ ext }) => {
			await ext.setup();
			const dark = scheme === 'dark';
			const UI = 'colander-ui';
			const page = await ext.open('https://www.youtube.com/results?search_query=history', { dark });
			const cards = page.locator('ytd-search ytd-video-renderer');
			const layer = page.locator('colander-ui[data-kind="layer"]');
			// Chips and the Tag button (shown on hover).
			await cards.nth(3).hover();
			await expect(cards.nth(3).locator('colander-ui[data-kind="tag"]')).toHaveCSS('opacity', '1');
			expect.soft(await audit(page, UI), 'chips, Tag button').toEqual([]);
			// The tag menu, then its confirmation and Add detail.
			await cards.nth(3).locator('colander-ui[data-kind="tag"] button').click();
			await expect(layer.locator('.cl-pop')).toBeVisible();
			expect.soft(await audit(page, UI), 'tag menu').toEqual([]);
			await layer.getByRole('menuitem', { name: /^Slop/ }).click();
			await layer.getByRole('button', { name: 'Add detail' }).click();
			await expect(layer.getByRole('dialog', { name: 'Add detail' })).toBeVisible();
			expect.soft(await audit(page, UI), 'tag confirmation and Add detail').toEqual([]);
			await page.keyboard.press('Escape');
			await layer.getByRole('button', { name: 'Undo' }).click();
			// The Why popover.
			await cards.nth(2).locator('colander-ui[data-kind="chip"] button').click();
			await expect(layer.locator('.cl-pop')).toBeVisible();
			expect.soft(await audit(page, UI), 'Why popover').toEqual([]);
			await page.keyboard.press('Escape');

			// The report sheet, both steps, and an error.
			const channel = await ext.open('https://www.youtube.com/@NASA/videos', { dark });
			await channel.locator('colander-ui[data-kind="report"] button').click();
			const sheet = channel.locator('colander-ui[data-kind="layer"] .report');
			await expect(sheet).toBeVisible();
			expect.soft(await audit(channel, UI), 'report sheet, examples').toEqual([]);
			await sheet.getByRole('button', { name: 'Next' }).click();
			await sheet.getByRole('button', { name: 'Send report' }).click();
			await expect(sheet.getByRole('alert')).toBeVisible();
			expect.soft(await audit(channel, UI), 'report sheet, reason with an error').toEqual([]);

			// Swipe feeds: the skip notice, with it switched on in Appearance.
			await ext.send({ type: 'settings', patch: { skipNotice: true } });
			const shorts = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			await expect(shorts.locator('colander-ui[data-kind="layer"] .cl-toast')).toBeVisible();
			expect.soft(await audit(shorts, UI), 'skip notice').toEqual([]);

			// Plain-language chips, on a card shown again from the popup too. Plain words read neutrally (VERDICT_PLAIN).
			await ext.send({ type: 'settings', patch: { plainChips: true } });
			await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('Made with AI');
			const shown = (await ext.pageState(page)).actions.find((a: { verdict: string }) => a.verdict === 'likely_slop');
			await ext.ctl.evaluate(async ([tabId, id]) => chrome.tabs.sendMessage(tabId, { type: 'show', id }), [await ext.tabId(page), shown.id] as const);
			await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toContainText('Probably low-effort AI content');
			expect.soft(await audit(page, UI), 'plain-language chips').toEqual([]);
		});
	});
}

test('radio groups: one tab stop, arrow keys, Home and End (WAI-ARIA)', async ({ ext }) => {
	await ext.setup();
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	const group = popup.getByRole('radiogroup', { name: 'Strictness' });
	await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
	await group.getByRole('radio', { name: 'Standard' }).focus();
	const strictness = () => ext.storage<{ strictness: string }>('settings').then((s) => s.strictness);
	for (const [key, name, value] of [
		['ArrowRight', 'No AI', 'no_ai'],
		['ArrowDown', 'Label', 'label'],
		['ArrowRight', 'Standard', 'standard'],
		['ArrowLeft', 'Label', 'label'],
		['ArrowLeft', 'No AI', 'no_ai'],
		['Home', 'Label', 'label'],
		['End', 'No AI', 'no_ai'],
		['ArrowUp', 'Standard', 'standard']
	] as const) {
		await popup.keyboard.press(key);
		await expect(group.getByRole('radio', { name })).toBeFocused();
		await expect(group.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
		await expect.poll(strictness).toBe(value);
	}
	await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveText('Standard');
	// Tab leaves the group in one step.
	await popup.keyboard.press('Tab');
	await expect(group.locator(':focus')).toHaveCount(0);

	const welcome = await ext.ctx.newPage();
	await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	const levels = welcome.getByRole('radiogroup', { name: 'How strict should it be?' });
	await expect(levels.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
	await levels.getByRole('radio', { name: /^Standard/ }).focus();
	await welcome.keyboard.press('ArrowDown');
	await expect(levels.getByRole('radio', { name: /^No AI/ })).toBeFocused();
	await expect(levels.getByRole('radio', { name: /^No AI/ })).toHaveAttribute('aria-checked', 'true');
	await welcome.keyboard.press('Home');
	await expect(levels.getByRole('radio', { name: /^Label/ })).toHaveAttribute('aria-checked', 'true');
});
