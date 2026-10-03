// Accessibility (P0-14, WCAG 2.2 AA): axe-core over every extension page and every element the
// extension adds to a platform page, in light and dark. Platform fixtures are not ours, so the
// in-page checks cover only the colander-ui hosts and their shadow roots.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, expect, fixtureHtml, test, type Ext } from './harness';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SECTIONS = ['lists', 'platforms', 'strictness', 'plus', 'appearance', 'plan', 'reports', 'data', 'privacy'];

/** Violations as readable lines, so a failure says what and where. */
async function audit(page: Page, include?: string): Promise<string[]> {
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
		{ days: Object.fromEntries([18, 31, 24, 40, 12, 27, 35].map((n, i) => [day(6 - i), { hidden: n, collapsed: Math.round(n / 4), labeled: n * 2 }])) }
	);
	await ext.send({
		type: 'settings',
		patch: {
			topics: [{ id: 't1', name: 'Kids', terms: ['#kids', 'cartoon'], strictness: 'no_ai', hide: false }],
			perPlatform: { tt: 'strict' },
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

		test(`extension pages pass axe, ${scheme}`, async ({ ext }) => {
			const page = await ext.ctx.newPage();
			await page.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
			await expect(page.getByRole('button', { name: 'Start 14-day trial, no card' }).first()).toBeVisible();
			expect.soft(await audit(page), 'options #plus, free').toEqual([]);

			await richState(ext);
			const yt = await ext.open('https://www.youtube.com/results?search_query=history');
			await page.setViewportSize({ width: 360, height: 760 });
			await page.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(yt)}`);
			await expect(page.getByRole('heading', { name: 'Your week' })).toBeVisible();
			expect.soft(await audit(page), 'popup').toEqual([]);

			await page.setViewportSize({ width: 1200, height: 860 });
			for (const s of SECTIONS) {
				await page.goto(`chrome-extension://${EXT_ID}/options.html#${s}`);
				await expect(page.locator('main h1, main h2').first()).toBeVisible();
				await page.waitForTimeout(150);
				expect.soft(await audit(page), `options #${s}`).toEqual([]);
			}

			await page.goto(`chrome-extension://${EXT_ID}/welcome.html`);
			await expect(page.getByRole('heading', { name: 'Welcome to Colander' })).toBeVisible();
			expect.soft(await audit(page), 'welcome').toEqual([]);

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
		});

		test(`in-page elements pass axe, ${scheme}`, async ({ ext }) => {
			await ext.setup();
			const dark = scheme === 'dark';
			const UI = 'colander-ui';
			const page = await ext.open('https://www.youtube.com/results?search_query=history', { dark });
			const cards = page.locator('ytd-search ytd-video-renderer');
			const layer = page.locator('colander-ui[data-kind="layer"]');
			// Chips, the collapsed bar and the Tag button (shown on hover).
			await cards.nth(3).hover();
			await expect(cards.nth(3).locator('colander-ui[data-kind="tag"]')).toHaveCSS('opacity', '1');
			expect.soft(await audit(page, UI), 'chips, collapsed bar, Tag button').toEqual([]);
			// The tag menu, then the Slop detail.
			await cards.nth(3).locator('colander-ui[data-kind="tag"] button').click();
			await expect(layer.locator('.pop')).toBeVisible();
			expect.soft(await audit(page, UI), 'tag menu').toEqual([]);
			await layer.getByRole('button', { name: /^Slop/ }).click();
			await expect(layer.getByRole('button', { name: 'Done' })).toBeVisible();
			expect.soft(await audit(page, UI), 'tag menu, Slop detail').toEqual([]);
			await page.keyboard.press('Escape');
			// The Why popover.
			await cards.nth(1).locator('colander-ui[data-kind="bar"]').getByRole('button', { name: 'Why' }).click();
			await expect(layer.locator('.pop')).toBeVisible();
			expect.soft(await audit(page, UI), 'Why popover').toEqual([]);
			await page.keyboard.press('Escape');

			// The report form, and its sent state.
			const channel = await ext.open('https://www.youtube.com/@NASA/videos', { dark });
			await channel.locator('colander-ui[data-kind="report"] button').click();
			const dialog = channel.locator('colander-ui[data-kind="layer"] .dialog');
			await expect(dialog).toBeVisible();
			expect.soft(await audit(channel, UI), 'report form').toEqual([]);
			await dialog.getByRole('button', { name: 'Send report' }).click();
			await expect(dialog.getByRole('alert')).toBeVisible();
			expect.soft(await audit(channel, UI), 'report form with an error').toEqual([]);

			// Swipe feeds: the skip notice, then a cover.
			const shorts = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			await expect(shorts.locator('colander-ui[data-kind="layer"] .toast')).toBeVisible();
			expect.soft(await audit(shorts, UI), 'skip notice').toEqual([]);
			const covered = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark, html: fixtureHtml('yt-shorts').replaceAll('aihistorydaily', 'catrescuetales') });
			await expect(covered.locator('colander-ui[data-kind="cover"]').first()).toBeVisible();
			expect.soft(await audit(covered, UI), 'swipe cover').toEqual([]);

			// Plain-language chips.
			await ext.send({ type: 'settings', patch: { plainChips: true } });
			await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('Made with AI');
			// Plain words read neutrally (VERDICT_PLAIN).
			await expect(cards.nth(1).locator('colander-ui[data-kind="bar"]')).toContainText('Probably low-effort AI content');
			expect.soft(await audit(page, UI), 'plain-language chips and bar').toEqual([]);
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
		['ArrowRight', 'Strict', 'strict'],
		['ArrowDown', 'No AI', 'no_ai'],
		['ArrowRight', 'Label', 'label'],
		['ArrowLeft', 'No AI', 'no_ai'],
		['Home', 'Label', 'label'],
		['End', 'No AI', 'no_ai'],
		['ArrowUp', 'Strict', 'strict']
	] as const) {
		await popup.keyboard.press(key);
		await expect(group.getByRole('radio', { name })).toBeFocused();
		await expect(group.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
		await expect.poll(strictness).toBe(value);
	}
	await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveText('Strict');
	// Tab leaves the group in one step.
	await popup.keyboard.press('Tab');
	await expect(group.locator(':focus')).toHaveCount(0);

	const welcome = await ext.ctx.newPage();
	await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	const levels = welcome.getByRole('radiogroup', { name: 'How strict should it be?' });
	await expect(levels.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
	await levels.getByRole('radio', { name: /^Standard/ }).focus();
	await welcome.keyboard.press('ArrowDown');
	await expect(levels.getByRole('radio', { name: /^Strict/ })).toBeFocused();
	await expect(levels.getByRole('radio', { name: /^Strict/ })).toHaveAttribute('aria-checked', 'true');
	await welcome.keyboard.press('Home');
	await expect(levels.getByRole('radio', { name: /^Label/ })).toHaveAttribute('aria-checked', 'true');
});

test('popup pause rows are whole 32 px targets, and switches keep 3:1 when off', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/results?search_query=history');
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	const row = popup.locator('label', { hasText: 'Pause on this site' });
	expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(32);
	const sw = popup.getByRole('switch', { name: 'Pause on this site' });
	// Off: the track against the popup surface and against its thumb.
	const ratios = await sw.evaluate((el) => {
		const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
		const lum = (c: string) => {
			const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
			return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
		};
		const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
		const track = getComputedStyle(el.querySelector('.uin-switch-track')!).backgroundColor;
		const thumb = getComputedStyle(el.querySelector('.uin-switch-thumb')!).backgroundColor;
		const surface = getComputedStyle(document.querySelector('.popup')!).backgroundColor;
		return [ratio(track, surface), ratio(track, thumb)];
	});
	for (const r of ratios) expect(r).toBeGreaterThanOrEqual(3);
	// A click anywhere on the row, here on its words, flips the switch.
	await row.getByText('Pause on this site').click();
	await expect(sw).toHaveAttribute('aria-checked', 'true');
	await row.click({ position: { x: 150, y: 4 } });
	await expect(sw).toHaveAttribute('aria-checked', 'false');
});
