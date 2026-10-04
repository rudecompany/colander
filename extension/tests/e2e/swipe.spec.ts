// Swipe feeds: a hidden video is skipped the moment it becomes active, silently unless the skip
// notice is on in Appearance, and its slot shows nothing; the popup still lists it with Show.
import { EXT_ID, expect, fixtureHtml, test } from './harness';

const SHORT = 'https://www.youtube.com/shorts/_k2w1cC69qY';

test('Shorts: slop is skipped silently, shows nothing, and the popup brings it back', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SHORT);
	const scroller = page.locator('#shorts-container');
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	await expect(slot0).toHaveAttribute('data-colander', 'skip');
	await expect(slot0.locator('.reel-video-in-sequence-thumbnail')).toBeHidden();
	await expect(slot0.locator('colander-ui')).toHaveCount(0);
	// No notice by default.
	await page.waitForTimeout(300);
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toHaveCount(0);
	// A play attempt in the skipped slot is paused at once.
	const paused = await slot0.locator('video').evaluate(async (v: HTMLVideoElement) => {
		v.dispatchEvent(new Event('play'));
		return v.paused;
	});
	expect(paused).toBe(true);

	// The toolbar count and the popup still have it, with Show.
	const state = await ext.pageState(page);
	expect(state.counts).toEqual({ hidden: 1, labeled: 0 });
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await popup.getByRole('listitem').filter({ hasText: 'Slop' }).getByRole('button', { name: 'Show' }).click();
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeLessThan(100);
});

test('Shorts: with the skip notice on, a skip says so, with Undo', async ({ ext }) => {
	await ext.setup({ settings: { skipNotice: true } });
	const page = await ext.open(SHORT);
	const scroller = page.locator('#shorts-container');
	const notice = page.locator('colander-ui[data-kind="layer"] .cl-toast');
	await expect(notice).toContainText('Skipped 1 slop video.');
	await expect(notice).toHaveAttribute('role', 'status');
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await notice.getByRole('button', { name: 'Undo' }).click();
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeLessThan(100);
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect(notice).toHaveCount(0);
});

test('Shorts: likely slop is skipped at Standard and labeled at Label', async ({ ext }) => {
	await ext.setup();
	// The first Short's channel is at Likely slop on the list for this test.
	const html = fixtureHtml('yt-shorts').replaceAll('aihistorydaily', 'catrescuetales');
	const page = await ext.open(SHORT, { html });
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await expect(slot0).toHaveAttribute('data-colander', 'skip');
	await expect.poll(() => page.locator('#shorts-container').evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	await ext.send({ type: 'settings', patch: { strictness: 'label' } });
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
});

test('TikTok: disputed shows with its mark beside the creator', async ({ ext }) => {
	await ext.setup({ platforms: ['tt'] });
	const page = await ext.open('https://www.tiktok.com/foryou');
	const article = page.locator('article[data-e2e="recommend-list-item-container"]').nth(1);
	const chip = article.locator('[class*="CreatorInfoContainer"] colander-ui[data-kind="chip"]');
	await expect(chip).toContainText('Disputed');
	await expect(article.locator('colander-ui[data-kind="tag"]')).toBeVisible();
	await expect(article).not.toHaveAttribute('data-colander', /./);
});
