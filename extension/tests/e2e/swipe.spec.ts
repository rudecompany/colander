// Swipe feeds: a hidden video is skipped with a brief notice that offers Undo; collapse covers
// and pauses the video until Show or Skip.
import { expect, fixtureHtml, test } from './harness';

test('Shorts: slop is skipped with an Undo notice', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY');
	const scroller = page.locator('#shorts-container');
	const notice = page.locator('colander-ui[data-kind="layer"] .cl-toast');
	await expect(notice).toContainText('Skipped 1 slop video.');
	await expect(notice).toHaveAttribute('role', 'status');
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await expect(slot0.locator('colander-ui[data-kind="cover"]')).toHaveCount(1);

	await notice.getByRole('button', { name: 'Undo' }).click();
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeLessThan(100);
	await expect(slot0.locator('colander-ui[data-kind="cover"]')).toHaveCount(0);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect(notice).toHaveCount(0);
});

test('Shorts: collapse covers and pauses until Show or Skip', async ({ ext }) => {
	await ext.setup({ strictness: 'standard' });
	// Make the first Short likely slop for this test: an own AI-made-but-fine tag would label;
	// a list entry for its channel at Likely slop collapses it.
	const html = fixtureHtml('yt-shorts').replaceAll('aihistorydaily', 'catrescuetales');
	const page = await ext.open('https://www.youtube.com/shorts/_k2w1cC69qY', { html });
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	const cover = slot0.locator('colander-ui[data-kind="cover"]');
	await expect(cover).toContainText('Likely slop');
	await expect(cover.getByRole('button', { name: 'Show' })).toBeVisible();
	// A play attempt while covered is paused at once.
	const paused = await slot0.locator('video').evaluate(async (v: HTMLVideoElement) => {
		v.dispatchEvent(new Event('play'));
		return v.paused;
	});
	expect(paused).toBe(true);
	await cover.getByRole('button', { name: 'Skip' }).click();
	await expect.poll(() => page.locator('#shorts-container').evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	await slot0.scrollIntoViewIfNeeded();
	await cover.getByRole('button', { name: 'Show' }).click();
	await expect(cover).toHaveCount(0);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
});

test('TikTok: disputed shows with its mark beside the creator', async ({ ext }) => {
	await ext.setup({ platforms: ['tt'] });
	const page = await ext.open('https://www.tiktok.com/foryou');
	const article = page.locator('article[data-e2e="recommend-list-item-container"]').nth(1);
	const chip = article.locator('[class*="CreatorInfoContainer"] colander-ui[data-kind="chip"]');
	await expect(chip).toContainText('Disputed');
	await expect(article.locator('colander-ui[data-kind="tag"]')).toBeVisible();
	await expect(article.locator('colander-ui[data-kind="cover"]')).toHaveCount(0);
});
