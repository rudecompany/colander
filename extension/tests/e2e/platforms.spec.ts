// Instagram, Facebook and TikTok search on their fixtures (hand-written for the signed-in surfaces).
import { expect, test } from './harness';

test('Instagram feed: Clear stays, the platform label gives AI-made, tags work', async ({ ext }) => {
	await ext.setup({ platforms: ['ig'] });
	const page = await ext.open('https://www.instagram.com/');
	const posts = page.locator('main article');
	await expect(posts.nth(0).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	await expect(posts.nth(0)).not.toHaveAttribute('data-colander', /./);
	await expect(posts.nth(1).locator('header colander-ui[data-kind="chip"]')).toContainText('AI-made');
	await posts.nth(2).hover();
	await posts.nth(2).locator('colander-ui[data-kind="tag"] button').click();
	const layer = page.locator('colander-ui[data-kind="layer"]');
	await layer.getByRole('menuitem', { name: /^Slop/ }).click();
	await expect(posts.nth(2)).toHaveAttribute('data-colander', 'hide');
	await layer.locator('.cl-toast').getByRole('button', { name: 'Close' }).click();
	await expect.poll(() => ext.api.posted('/v1/tags').length).toBe(1);
	const tag = (ext.api.posted('/v1/tags')[0]!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(tag).toMatchObject({ platform: 'ig', target_type: 'item', target_id: 'DAbC_12-xYz', source_id: 'endless.wonders.daily' });
});

test('Instagram Explore: tiles without a visible source can be tagged too', async ({ ext }) => {
	await ext.setup({ platforms: ['ig'] });
	const page = await ext.open('https://www.instagram.com/explore/');
	const tiles = page.locator('main a[href*="/p/"], main a[href*="/reel/"]');
	await expect(tiles).toHaveCount(6);
	await expect(page.locator('main colander-ui[data-kind="tag"]')).toHaveCount(6);
	await tiles.nth(4).hover();
	await tiles.nth(4).locator('colander-ui[data-kind="tag"] button').click();
	const layer = page.locator('colander-ui[data-kind="layer"]');
	await layer.getByRole('menuitem', { name: /^Slop/ }).click();
	await expect(tiles.nth(4)).toHaveAttribute('data-colander', 'hide');
	await expect(page).toHaveURL('https://www.instagram.com/explore/');
	await layer.locator('.cl-toast').getByRole('button', { name: 'Close' }).click();
	await expect.poll(() => ext.api.posted('/v1/tags').length).toBe(1);
	const tag = (ext.api.posted('/v1/tags')[0]!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(tag).toMatchObject({ platform: 'ig', target_type: 'item', target_id: 'C9tile00005', verdict: 'slop' });
	expect('source_id' in tag).toBe(false);
});

test('Facebook feed: a listed post is hidden, suggested or not; AI info labels', async ({ ext }) => {
	await ext.setup({ platforms: ['fb'] });
	const page = await ext.open('https://www.facebook.com/');
	const posts = page.locator('[role="feed"] [aria-posinset]');
	await expect(posts.nth(0)).toHaveAttribute('data-colander', 'hide');
	await expect(posts.nth(2).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	expect((await ext.pageState(page)).counts).toEqual({ hidden: 1, collapsed: 0, labeled: 1 });
});

test('Facebook Reels: a hidden reel is skipped', async ({ ext }) => {
	await ext.setup({ platforms: ['fb'], settings: { blocks: [{ key: 'fb:i:987654321098765', at: 1 }] } });
	const page = await ext.open('https://www.facebook.com/reel/987654321098765');
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toContainText('Skipped 1 slop reel.');
});

test('TikTok search: the platform label and a listed creator', async ({ ext }) => {
	await ext.setup({ platforms: ['tt'] });
	ext.api.delta = true;
	await ext.send({ type: 'sync-now' });
	const page = await ext.open('https://www.tiktok.com/search?q=history');
	const cards = page.locator('div:has(> [data-e2e="search_video-item"])');
	// @sloppyfacts is Disputed: shown with its mark.
	await expect(cards.nth(0).locator('colander-ui[data-kind="chip"]')).toContainText('Disputed');
	// tt:i:7412345678901234567 is Likely slop after the delta: collapsed.
	await expect(cards.nth(2)).toHaveAttribute('data-colander', 'collapse');
});
