// Screenshots of every surface, light and dark, saved to screenshots/ for review.
// Run with `pnpm screenshots`; skipped in the normal end-to-end run so it never rewrites them.
import type { Page } from '@playwright/test';
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, SHOTS, expect, fixtureHtml, test, type Ext } from './harness';

test.skip(!SHOTS, 'Set SCREENSHOTS=1 (pnpm screenshots) to capture screenshots.');

// Toasts run a 4-dot countdown; a screenshot that fast-forwards animations would end them, so
// pictures of a toast allow animations and hover the toast to hold it.
const shot = (page: Page, name: string, full = false, animations: 'disabled' | 'allow' = 'disabled') =>
	page.screenshot({ path: `screenshots/${name}.png`, fullPage: full, animations });
const layer = (page: Page) => page.locator('colander-ui[data-kind="layer"]');

/** Plus on a trial, with a week of history, a topic, My list entries and two reports. */
async function richState(ext: Ext) {
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
			topics: [{ id: 't1', name: 'Kids', terms: ['#kids', 'cartoon', 'nursery rhymes'], strictness: 'no_ai', hide: false }],
			perPlatform: { tt: 'strict' },
			blocks: [{ key: 'yt:s:@endlessfacts', name: 'Endless Facts', at: Date.now() }],
			allows: [{ key: 'yt:s:@handmadehistory', name: 'Handmade History', at: Date.now() - 1000 }]
		}
	});
	ext.api.reports = [
		{ id: 'rpt_2', platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' },
		{ id: 'rpt_1', platform: 'tt', source_id: '@sloppyfacts', source_name: 'Sloppy Facts', status: 'slop', verdict: 'slop', protects: 12840, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' }
	];
}

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });

		test(`popup ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			const yt = await ext.open('https://www.youtube.com/results?search_query=history');
			const popup = await ext.ctx.newPage();
			await popup.setViewportSize({ width: 360, height: 600 });
			const open = async (tab: number | null) => {
				await popup.goto(`chrome-extension://${EXT_ID}/popup.html${tab ? `?tab=${tab}` : ''}`);
				await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
				await popup.waitForTimeout(250);
			};
			const tab = await ext.tabId(yt);
			await open(tab);
			await shot(popup, `popup-${scheme}`);
			await popup.getByRole('button', { name: /Show all/ }).click().catch(() => undefined);
			await popup.waitForTimeout(150);
			await shot(popup, `popup-show-all-${scheme}`);
			await open(tab);
			await popup.getByRole('button', { name: 'Pause' }).click();
			await shot(popup, `popup-pause-menu-${scheme}`);
			await popup.getByRole('menuitem', { name: 'Pause on this site' }).click();
			await expect(popup.getByText('Paused on this site.')).toBeVisible();
			await shot(popup, `popup-paused-${scheme}`);
			await popup.getByRole('button', { name: 'Resume' }).click();
			await richState(ext);
			await open(tab);
			await shot(popup, `popup-weekly-${scheme}`);
			await open(null);
			await shot(popup, `popup-unsupported-${scheme}`);
		});

		test(`options ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			const opts = await ext.ctx.newPage();
			await opts.setViewportSize({ width: 1440, height: 900 });
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
			await opts.waitForTimeout(300);
			await shot(opts, `options-plus-gated-${scheme}`, true);
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
			await opts.waitForTimeout(300);
			await shot(opts, `options-plan-free-${scheme}`, true);
			await richState(ext);
			for (const s of ['lists', 'platforms', 'strictness', 'plus', 'appearance', 'plan', 'reports', 'data', 'privacy']) {
				await opts.goto(`chrome-extension://${EXT_ID}/options.html#${s}`);
				await opts.waitForTimeout(300);
				if (s === 'reports') await opts.locator('summary').nth(1).click();
				await shot(opts, `options-${s}-${scheme}`, true);
			}
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#data`);
			await opts.getByRole('button', { name: 'Delete local data' }).click();
			await opts.waitForTimeout(300);
			await shot(opts, `options-data-dialog-${scheme}`);
			await opts.setViewportSize({ width: 1000, height: 900 });
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#lists`);
			await opts.waitForTimeout(300);
			await shot(opts, `options-lists-1000-${scheme}`, true);
			await opts.setViewportSize({ width: 390, height: 844 });
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
			await opts.waitForTimeout(300);
			await shot(opts, `options-strictness-390-${scheme}`, true);
		});

		test(`welcome ${scheme}`, async ({ ext }) => {
			const welcome = await ext.ctx.newPage();
			await welcome.setViewportSize({ width: 1280, height: 900 });
			await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
			await welcome.waitForTimeout(400);
			await shot(welcome, `welcome-1-${scheme}`);
			await welcome.evaluate(() => scrollTo(0, document.body.scrollHeight));
			await shot(welcome, `welcome-1-end-${scheme}`);
			await welcome.getByRole('button', { name: 'Continue' }).click();
			await welcome.getByRole('checkbox', { name: /TikTok/ }).click();
			await welcome.waitForTimeout(300);
			await shot(welcome, `welcome-2-${scheme}`);
			await welcome.getByRole('button', { name: 'Continue' }).click();
			await expect(welcome.getByRole('heading', { name: 'Pin Colander' })).toBeVisible();
			await welcome.waitForTimeout(300);
			await shot(welcome, `welcome-3-${scheme}`);
		});

		test(`side panel ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			const side = await ext.ctx.newPage();
			await side.setViewportSize({ width: 400, height: 860 });
			await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
			await expect(side.getByText('Review for curators')).toBeVisible();
			await shot(side, `sidepanel-signin-${scheme}`);
			ext.api.review.queue = REVIEW_QUEUE();
			ext.api.review.source = REVIEW_SOURCE;
			await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
			await side.reload();
			await side.getByRole('button', { name: /Cat Rescue Tales/ }).waitFor();
			await shot(side, `sidepanel-queue-${scheme}`);
			await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
			await expect(side.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
			await side.waitForTimeout(200);
			await shot(side, `sidepanel-evidence-${scheme}`);
			await side.getByRole('heading', { name: 'Decision' }).scrollIntoViewIfNeeded();
			await shot(side, `sidepanel-decision-${scheme}`);
			await side.setViewportSize({ width: 480, height: 860 });
			await shot(side, `sidepanel-decision-480-${scheme}`);
			await side.keyboard.press('?');
			await side.waitForTimeout(250);
			await shot(side, `sidepanel-shortcuts-${scheme}`);
		});
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`in-page ${scheme}`, () => {
		test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });

		test(`chips, bars, menus and notices ${scheme}`, async ({ ext }) => {
			await ext.setup();
			const dark = scheme === 'dark';
			const page = await ext.open('https://www.youtube.com/results?search_query=history', { dark });
			const cards = page.locator('ytd-search ytd-video-renderer');
			await shot(page, `inpage-search-${scheme}`);
			// The chip on a thumbnail, with Why on hover.
			await cards.nth(2).locator('colander-ui[data-kind="chip"] button').hover();
			await cards.nth(2).screenshot({ path: `screenshots/inpage-chip-${scheme}.png`, animations: 'disabled' });
			// The collapsed bar.
			await page.mouse.move(0, 0);
			await cards.nth(1).screenshot({ path: `screenshots/inpage-collapsed-${scheme}.png`, animations: 'disabled' });
			// The Why popover on the collapsed bar.
			await cards.nth(1).locator('colander-ui[data-kind="bar"]').getByRole('button', { name: 'Why' }).click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-why-${scheme}`);
			await page.keyboard.press('Escape');
			// The Tag button and menu, then the confirmation and Add detail.
			await cards.nth(3).hover();
			await cards.nth(3).locator('colander-ui[data-kind="tag"] button').click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-tag-menu-${scheme}`);
			await layer(page).getByRole('menuitem', { name: /^Slop/ }).click();
			await layer(page).locator('.cl-toast').hover();
			await page.waitForTimeout(150);
			await shot(page, `inpage-tag-toast-${scheme}`, false, 'allow');
			await layer(page).getByRole('button', { name: 'Add detail' }).click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-tag-detail-${scheme}`, false, 'allow');
			await page.keyboard.press('Escape');
			await layer(page).getByRole('button', { name: 'Undo' }).click();
			// Plain-language chips.
			await ext.send({ type: 'settings', patch: { plainChips: true } });
			await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('Made with AI');
			await cards.nth(2).screenshot({ path: `screenshots/inpage-chip-plain-${scheme}.png`, animations: 'disabled' });
			await ext.send({ type: 'settings', patch: { plainChips: false } });

			// Why on a Slop source with four signals, at Label so its chip stays.
			await ext.send({ type: 'settings', patch: { strictness: 'label' } });
			await cards.nth(0).locator('colander-ui[data-kind="chip"] button').click();
			await page.waitForTimeout(150);
			await page.screenshot({ path: `screenshots/inpage-why-signals-${scheme}.png`, clip: { x: 0, y: 0, width: 760, height: 460 }, animations: 'disabled' });
			await page.keyboard.press('Escape');

			// Home grid at Strict: hidden, grid stubs and labeled cards side by side.
			await ext.send({ type: 'settings', patch: { strictness: 'strict' } });
			const home = await ext.open('https://www.youtube.com/', { dark });
			await home.locator('ytd-rich-item-renderer').nth(3).hover();
			await shot(home, `inpage-home-strict-${scheme}`);
			await ext.send({ type: 'settings', patch: { strictness: 'standard' } });

			// Report source on a channel page, both steps.
			const channel = await ext.open('https://www.youtube.com/@NASA/videos', { dark });
			await channel.locator('colander-ui[data-kind="report"] button').click();
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-${scheme}`);
			await layer(channel).getByRole('button', { name: 'Next' }).click();
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-2-${scheme}`);

			// Shorts: the skip notice, then a covered Short.
			const shorts = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			await expect(layer(shorts).locator('.cl-toast')).toBeVisible();
			await layer(shorts).locator('.cl-toast').hover();
			await shorts.waitForTimeout(600);
			await shot(shorts, `inpage-skip-notice-${scheme}`, false, 'allow');
			const covered = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark, html: fixtureHtml('yt-shorts').replaceAll('aihistorydaily', 'catrescuetales') });
			await covered.waitForTimeout(300);
			await shot(covered, `inpage-cover-${scheme}`);

			// TikTok For You: the chip beside the creator name, and the Tag button.
			await ext.send({ type: 'set-platform', platform: 'tt', on: true });
			const tt = await ext.open('https://www.tiktok.com/foryou');
			await tt.locator('article').nth(1).scrollIntoViewIfNeeded();
			await shot(tt, `inpage-tiktok-${scheme}`);
		});
	});
}
