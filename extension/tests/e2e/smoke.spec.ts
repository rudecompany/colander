import { expect, test, ui } from './harness';

test('hides, collapses and labels on YouTube search at Standard', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/results?search_query=history');
	const cards = page.locator('ytd-search ytd-video-renderer');
	await expect(cards.nth(0)).toHaveAttribute('data-colander', 'hide');
	await expect(cards.nth(1)).toHaveAttribute('data-colander', 'collapse');
	await expect(cards.nth(2).locator('colander-ui[data-kind="chip"]')).toHaveCount(1);
	await page.screenshot({ path: 'test-results/smoke.png', fullPage: false });
	console.log(JSON.stringify(await ext.pageState(page), null, 1).slice(0, 1500));
});
