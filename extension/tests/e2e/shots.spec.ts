// Screenshots of every surface, light and dark, saved to screenshots/ for review.
import type { Page } from '@playwright/test';
import { EXT_ID, expect, fixtureHtml, test } from './harness';

const shot = (page: Page, name: string, full = false) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: full, animations: 'disabled' });

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });

		test(`pages ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			const gated = await ext.ctx.newPage();
			await gated.setViewportSize({ width: 1200, height: 860 });
			await gated.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
			await gated.waitForTimeout(250);
			await shot(gated, `options-plus-gated-${scheme}`, true);
			await gated.close();
			// Plus on a trial, with a little history, a topic and a report, so every section has content.
			await ext.send({ type: 'start-trial' });
			const day = (n: number) => { const d = new Date(Date.now() - n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
			await ext.ctl.evaluate(
				({ days }) => chrome.storage.local.set({ stats: { firstRunAt: Date.now() - 9 * 86_400_000, days } }),
				{ days: Object.fromEntries([18, 31, 24, 40, 12, 27, 35].map((n, i) => [day(6 - i), { hidden: n, collapsed: Math.round(n / 4), labeled: n * 2 }])) }
			);
			await ext.send({ type: 'settings', patch: { topics: [{ id: 't1', name: 'Kids', terms: ['#kids', 'cartoon', 'nursery rhymes'], strictness: 'no_ai', hide: false }], perPlatform: { tt: 'strict' }, blocks: [{ key: 'yt:s:@endlessfacts', name: 'Endless Facts', at: Date.now() }], allows: [{ key: 'yt:s:@handmadehistory', name: 'Handmade History', at: Date.now() }] } });
			ext.api.reports = [
				{ id: 'rpt_2', platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' },
				{ id: 'rpt_1', platform: 'tt', source_id: '@sloppyfacts', source_name: 'Sloppy Facts', status: 'slop', verdict: 'slop', protects: 12840, created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' }
			];
			const yt = await ext.open('https://www.youtube.com/results?search_query=history');
			const tabId = await ext.ctl.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0]!.id);
			const popup = await ext.ctx.newPage();
			await popup.setViewportSize({ width: 360, height: 760 });
			await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${tabId}`);
			await expect(popup.getByRole('heading', { name: 'On this page' })).toBeVisible();
			await popup.waitForTimeout(300);
			await shot(popup, `popup-${scheme}`, true);
			void yt;

			const opts = await ext.ctx.newPage();
			await opts.setViewportSize({ width: 1200, height: 860 });
			for (const s of ['lists', 'platforms', 'strictness', 'plus', 'appearance', 'plan', 'reports', 'data', 'privacy']) {
				await opts.goto(`chrome-extension://${EXT_ID}/options.html#${s}`);
				await opts.waitForTimeout(250);
				await shot(opts, `options-${s}-${scheme}`, true);
			}

			const welcome = await ext.ctx.newPage();
			await welcome.setViewportSize({ width: 1200, height: 1000 });
			await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
			await shot(welcome, `welcome-${scheme}`, true);

			const side = await ext.ctx.newPage();
			await side.setViewportSize({ width: 400, height: 760 });
			await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
			await expect(side.getByText('Review for curators')).toBeVisible();
			await shot(side, `sidepanel-signin-${scheme}`);
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
			await page.setViewportSize({ width: 1280, height: 900 });
			const cards = page.locator('ytd-search ytd-video-renderer');
			await shot(page, `inpage-search-${scheme}`);
			// The chip on a thumbnail, with Why on hover.
			await cards.nth(2).locator('colander-ui[data-kind="chip"] button').hover();
			await cards.nth(2).screenshot({ path: `screenshots/inpage-chip-${scheme}.png`, animations: 'disabled' });
			// The collapsed bar.
			await cards.nth(1).screenshot({ path: `screenshots/inpage-collapsed-${scheme}.png`, animations: 'disabled' });
			// The Why popover on the collapsed bar.
			await cards.nth(1).locator('colander-ui[data-kind="bar"]').getByRole('button', { name: 'Why' }).click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-why-${scheme}`);
			await page.keyboard.press('Escape');
			// The Tag button and menu, then the Slop detail.
			await cards.nth(3).hover();
			await cards.nth(3).locator('colander-ui[data-kind="tag"] button').click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-tag-menu-${scheme}`);
			await page.locator('colander-ui[data-kind="layer"] .pop').getByRole('button', { name: /^Slop/ }).click();
			await page.waitForTimeout(150);
			await shot(page, `inpage-tag-detail-${scheme}`);
			await page.keyboard.press('Escape');
			// Plain-language chips.
			await ext.send({ type: 'settings', patch: { plainChips: true } });
			await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('Made with AI');
			// Plain words read neutrally (VERDICT_PLAIN), never "tagged as slop by the community".
			await expect(cards.nth(1).locator('colander-ui[data-kind="bar"]')).toContainText('Probably low-effort AI content');
			await cards.nth(2).screenshot({ path: `screenshots/inpage-chip-plain-${scheme}.png`, animations: 'disabled' });
			await ext.send({ type: 'settings', patch: { plainChips: false } });

			// Home grid at Strict: hidden, collapsed and labeled cards side by side.
			await ext.send({ type: 'settings', patch: { strictness: 'strict' } });
			const home = await ext.open('https://www.youtube.com/', { dark });
			await home.locator('ytd-rich-item-renderer').nth(3).hover();
			await shot(home, `inpage-home-strict-${scheme}`);
			await ext.send({ type: 'settings', patch: { strictness: 'standard' } });

			// Report source on a channel page.
			const channel = await ext.open('https://www.youtube.com/@NASA/videos', { dark });
			await channel.locator('colander-ui[data-kind="report"] button').click();
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-${scheme}`);

			// Shorts: the skip notice, then a covered Short.
			const shorts = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			await expect(shorts.locator('colander-ui[data-kind="layer"] .toast')).toBeVisible();
			await shorts.waitForTimeout(600);
			await shot(shorts, `inpage-skip-notice-${scheme}`);
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
