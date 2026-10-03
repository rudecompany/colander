// Screenshots of every surface, light and dark, saved to screenshots/ for review.
import type { Page } from '@playwright/test';
import { EXT_ID, expect, planToken, test, ui } from './harness';

const shot = (page: Page, name: string, full = false) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: full, animations: 'disabled' });

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });

		test(`pages ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			await ext.ctl.evaluate((t) => chrome.storage.local.set({ planToken: t }), planToken({ trial: true, exp: Math.floor(Date.now() / 1000) + 10 * 86400 }));
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
