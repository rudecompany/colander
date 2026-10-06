// Screenshots of every surface, light and dark, saved to screenshots/ for review.
// Run with `pnpm screenshots`; skipped in the normal end-to-end run so it never rewrites them.
import type { Page } from '@playwright/test';
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, SHOTS, expect, planToken, test, type Ext } from './harness';

test.skip(!SHOTS, 'Set SCREENSHOTS=1 (pnpm screenshots) to capture screenshots.');

// Toasts run a 4-dot countdown; a screenshot that fast-forwards animations would end them, so
// pictures of a toast allow animations and hover the toast to hold it.
const shot = (page: Page, name: string, full = false, animations: 'disabled' | 'allow' = 'disabled') =>
	page.screenshot({ path: `screenshots/${name}.png`, fullPage: full, animations });
const layer = (page: Page) => page.locator('colander-ui[data-kind="layer"]');

/**
 * The signed contract fixtures carry list sequence 42; the Worker publishes unix-second sequences
 * (api/src/store/list.ts), so the pictures show a version as long as the real one.
 */
const workerSequence = (ext: Ext) =>
	ext.ctl.evaluate(async () => {
		const { status } = await chrome.storage.local.get('status');
		await chrome.storage.local.set({ status: { ...(status as object), listSequence: 1791070723 } });
	});

/** Plus on a trial, with a week of history, a topic, My list entries and two reports. */
async function richState(ext: Ext) {
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
			topics: [{ id: 't1', name: 'Kids', terms: ['#kids', 'cartoon', 'nursery rhymes'], strictness: 'no_ai', hide: false }],
			perPlatform: { tt: 'no_ai' },
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
				await workerSequence(ext);
				await popup.goto(`chrome-extension://${EXT_ID}/popup.html${tab ? `?tab=${tab}` : ''}`);
				await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
				await popup.waitForTimeout(250);
			};
			const tab = await ext.tabId(yt);
			// Today's count is written after the page reports its counts; picture the settled popup.
			await expect
				.poll(() => ext.ctl.evaluate(async () => Object.values(((await chrome.storage.local.get('stats')).stats as { days: Record<string, { hidden: number }> } | undefined)?.days ?? {}).reduce((n, d) => n + d.hidden, 0)))
				.toBeGreaterThan(0);
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
			// 125% zoom: Chrome's 600 px popup is 480 CSS px, and only the list scrolls.
			await popup.setViewportSize({ width: 360, height: 480 });
			await open(tab);
			await shot(popup, `popup-zoom-125-${scheme}`);
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
			await workerSequence(ext);
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
			await opts.setViewportSize({ width: 320, height: 800 });
			for (const s of ['plus', 'lists']) {
				await opts.goto(`chrome-extension://${EXT_ID}/options.html#${s}`);
				await opts.waitForTimeout(300);
				await shot(opts, `options-${s}-320-${scheme}`, true);
			}
			// A paid plan, connected with a pairing code from the website: first a code that is not valid.
			const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
			await opts.setViewportSize({ width: 1440, height: 900 });
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
			await opts.getByLabel('Code from the website').fill('KXQ4-JP7M');
			await opts.getByRole('button', { name: 'Connect' }).click();
			await expect(opts.getByRole('alert')).toBeVisible();
			await opts.waitForTimeout(200);
			await shot(opts, `options-plan-code-error-${scheme}`, true);
			ext.api.pair = { kind: 'plan', token: planToken({ trial: false, exp }) };
			await opts.getByRole('button', { name: 'Connect' }).click();
			await expect.poll(() => ext.storage('entitlement')).toEqual({ plus: true, trial: false, exp, account: 'p***@colander.test' });
			await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
			await opts.waitForTimeout(300);
			await shot(opts, `options-plan-paid-${scheme}`, true);
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
			const opened = ext.ctx.waitForEvent('page');
			await welcome.getByRole('button', { name: 'Done' }).click();
			await (await opened).close();
			await expect(welcome.getByRole('heading', { name: 'You are set' })).toBeVisible();
			await welcome.waitForTimeout(300);
			await shot(welcome, `welcome-done-${scheme}`);
			await welcome.setViewportSize({ width: 390, height: 844 });
			await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
			await welcome.waitForTimeout(400);
			await shot(welcome, `welcome-1-390-${scheme}`, true);
		});

		test(`side panel ${scheme}`, async ({ ext }) => {
			await ext.setup({ platforms: ['yt'] });
			await workerSequence(ext);
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
			// Connected curators get Review in the popup, beside Options.
			const popup = await ext.ctx.newPage();
			await popup.setViewportSize({ width: 360, height: 600 });
			await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
			await expect(popup.getByRole('button', { name: 'Review' })).toBeVisible();
			await popup.waitForTimeout(200);
			await shot(popup, `popup-review-${scheme}`);
			await popup.close();
			await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
			await expect(side.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
			await side.waitForTimeout(200);
			await shot(side, `sidepanel-evidence-${scheme}`);
			// The evidence by layer, and a layer not met yet with its question beside its name.
			await side.getByRole('heading', { name: 'Evidence by layer' }).evaluate((h) => h.scrollIntoView({ block: 'center' }));
			await side.waitForTimeout(200);
			await shot(side, `sidepanel-layers-${scheme}`);
			await side.getByRole('heading', { name: 'Decision' }).scrollIntoViewIfNeeded();
			await shot(side, `sidepanel-decision-${scheme}`);
			await side.setViewportSize({ width: 360, height: 860 });
			await shot(side, `sidepanel-decision-360-${scheme}`);
			await side.setViewportSize({ width: 480, height: 860 });
			await shot(side, `sidepanel-decision-480-${scheme}`);
			await side.keyboard.press('?');
			await side.waitForTimeout(250);
			await shot(side, `sidepanel-shortcuts-${scheme}`);
			await side.keyboard.press('Escape');
			// A large source with an appeal: the panel's token carries curator authority only.
			const appeal = { id: 'apl_1', platform: 'yt', source_id: '@catrescuetales', status: 'under_review', code: 'CLN-7Q4K', statement: 'We film every rescue ourselves.', created_at: '2026-10-02T10:00:00Z' };
			ext.api.review.source = { ...REVIEW_SOURCE, source: { ...REVIEW_SOURCE.source, large: true }, appeals: [appeal] };
			await side.setViewportSize({ width: 400, height: 860 });
			await side.getByRole('button', { name: 'Queue' }).click();
			await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
			await expect(side.getByText('has a large audience', { exact: false })).toBeVisible();
			await side.getByRole('heading', { name: 'Decision' }).scrollIntoViewIfNeeded();
			await side.waitForTimeout(200);
			await shot(side, `sidepanel-staff-${scheme}`);
		});
	});
}

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`in-page ${scheme}`, () => {
		test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });

		test(`chips, menus, notices and closed-up feeds ${scheme}`, async ({ ext }) => {
			await ext.setup();
			const dark = scheme === 'dark';
			const page = await ext.open('https://www.youtube.com/results?search_query=history', { dark });
			const cards = page.locator('ytd-search ytd-video-renderer');
			await shot(page, `inpage-search-${scheme}`);
			// The chip on a thumbnail, with Why on hover.
			await cards.nth(2).locator('colander-ui[data-kind="chip"] button').hover();
			await cards.nth(2).screenshot({ path: `screenshots/inpage-chip-${scheme}.png`, animations: 'disabled' });
			// The Why popover on the AI-made chip.
			await cards.nth(2).locator('colander-ui[data-kind="chip"] button').click();
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

			// Home and subscriptions at Standard: hidden cards leave no gap, and the grid reflows so
			// the rows before the Shorts shelf stay full.
			await ext.send({ type: 'settings', patch: { strictness: 'standard' } });
			const home = await ext.open('https://www.youtube.com/', { dark });
			await expect(home.locator('[data-colander-reflow]')).toHaveCount(1);
			await home.locator('ytd-rich-item-renderer:not([data-colander])').nth(3).hover();
			await shot(home, `inpage-home-${scheme}`, true);
			const subs = await ext.open('https://www.youtube.com/feed/subscriptions', { dark });
			await expect(subs.locator('[data-colander-reflow]')).toHaveCount(1);
			await shot(subs, `inpage-subscriptions-${scheme}`, true);

			// Report source on a channel page, both steps.
			const channel = await ext.open('https://www.youtube.com/@NASA/videos', { dark });
			await channel.locator('colander-ui[data-kind="report"] button').click();
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-${scheme}`);
			await layer(channel).getByRole('button', { name: 'Next' }).click();
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-2-${scheme}`);
			// A narrow window, or 400% zoom: the sheet keeps 16 px from both edges.
			await channel.setViewportSize({ width: 390, height: 844 });
			await channel.waitForTimeout(150);
			await shot(channel, `inpage-report-390-${scheme}`);

			// Shorts: the skip notice, with it switched on in Appearance (off by default, skips are silent).
			await ext.send({ type: 'settings', patch: { skipNotice: true } });
			const shorts = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			await expect(layer(shorts).locator('.cl-toast')).toBeVisible();
			await layer(shorts).locator('.cl-toast').hover();
			await shorts.waitForTimeout(600);
			await shot(shorts, `inpage-skip-notice-${scheme}`, false, 'allow');
			await ext.send({ type: 'settings', patch: { skipNotice: false } });

			// Shorts, swiped back up to the skipped first Short: skipped again, never a blank slot.
			const back = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { dark });
			const scroller = back.locator('#shorts-container');
			await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
			await back.waitForTimeout(600);
			await back.locator('#shorts-inner-container > .reel-video-in-sequence-new').first().evaluate((e) => e.scrollIntoView({ block: 'start' }));
			await back.waitForTimeout(900);
			await shot(back, `inpage-shorts-back-${scheme}`);

			// TikTok For You: the chip beside the creator name, and the Tag button.
			await ext.send({ type: 'set-platform', platform: 'tt', on: true });
			const tt = await ext.open('https://www.tiktok.com/foryou', { dark });
			await tt.locator('article').nth(1).scrollIntoViewIfNeeded();
			await shot(tt, `inpage-tiktok-${scheme}`);
		});

		test(`the other platforms and surfaces ${scheme}`, async ({ ext }) => {
			// One item each in the TikTok profile and Explore grids is on My list: its cell closes up.
			await ext.setup({ platforms: ['yt', 'tt', 'ig', 'fb'], settings: { blocks: ['tt:i:7691450773619625247', 'ig:i:C9aiWorld01'].map((key) => ({ key, at: 1 })) } });
			const dark = scheme === 'dark';
			const at = async (url: string, name: string, hover?: string) => {
				const page = await ext.open(url, { dark });
				if (hover) await page.locator(hover).hover();
				await page.waitForTimeout(250);
				await shot(page, `inpage-${name}-${scheme}`);
				await page.close();
			};
			// YouTube Up next, pointing at one item: the Tag button rides on its thumbnail, under the chip.
			await at('https://www.youtube.com/watch?v=xxxxxxxxxxx', 'yt-watch', 'ytd-watch-next-secondary-results-renderer yt-lockup-view-model:not([data-colander]) >> nth=3');
			await at('https://www.tiktok.com/@tiktok', 'tt-profile', '[data-e2e="user-post-item"]:not([data-colander]) >> nth=1');
			await at('https://www.tiktok.com/search?q=history', 'tt-search', 'div:has(> [data-e2e="search_video-item"]):not([data-colander]) >> nth=1');
			await at('https://www.instagram.com/', 'ig-feed', 'main article:not([data-colander]) >> nth=1');
			await at('https://www.instagram.com/explore/', 'ig-explore', 'main a[href*="/p/"]:not([data-colander]) >> nth=1');
			await at('https://www.instagram.com/reels/DAbC_12-xYz/', 'ig-reels');
			await at('https://www.facebook.com/', 'fb-feed', '[role="feed"] [aria-posinset="3"]');
			await at('https://www.facebook.com/reel/987654321098765', 'fb-reels');
		});
	});
}
