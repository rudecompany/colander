// Fixing a wrong call (P0-7): Why lists the signals, Show reveals once, Always allow overrides
// every list for this viewer, Not slop files a counter-tag. The popup offers the same (P0-12).
import { EXT_ID, expect, test } from './harness';

const SEARCH = 'https://www.youtube.com/results?search_query=history';

test('Why, Show, Not slop and Always allow', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	await cards.nth(1).locator('colander-ui[data-kind="bar"]').getByRole('button', { name: 'Why' }).click();
	const pop = page.locator('colander-ui[data-kind="layer"] .pop');
	await expect(pop.getByRole('heading', { name: 'Why this is hidden' })).toBeVisible();
	await expect(pop).toContainText('Most recent items are AI-made');
	await expect(pop).toContainText('Taggers found it hollow');
	await expect(pop).toContainText('Core list, updated Aug 1, 2026, imported and not yet reviewed');
	await expect(pop.getByRole('link', { name: 'Source page' })).toHaveAttribute('href', 'http://localhost:8787/s/yt/@catrescuetales');
	await expect(pop.getByRole('link', { name: 'Is this your channel? Appeal this verdict.' })).toHaveAttribute('href', 'http://localhost:8787/appeal/yt/@catrescuetales');
	await expect(pop.locator('.why-sig li')).toHaveText(['Most recent items are AI-made', 'Taggers found it hollow']);

	await pop.getByRole('button', { name: 'Show' }).click();
	await expect(cards.nth(1)).not.toHaveAttribute('data-colander', /./);
	await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');

	// Not slop from the chip's Why files a source-level counter-tag.
	await cards.nth(1).locator('colander-ui[data-kind="chip"] button').click();
	await pop.getByRole('button', { name: 'Not slop' }).click();
	await expect.poll(() => ext.api.posted('/v1/tags').length).toBe(1);
	const tag = (ext.api.posted('/v1/tags')[0]!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(tag).toMatchObject({ target_type: 'source', target_id: '@catrescuetales', verdict: 'not_slop' });
	expect(tag.source_id).toBeUndefined();
	await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);

	// Always allow from the popup's recent actions, for the hidden card.
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	const row = popup.locator('li.item', { hasText: 'AI History Daily' });
	await expect(row).toContainText('Slop');
	await row.getByRole('button', { name: 'Always allow' }).click();
	await expect(cards.nth(0)).not.toHaveAttribute('data-colander', /./);
	const settings = await ext.storage<{ allows: { key: string }[] }>('settings');
	expect(settings.allows.map((a) => a.key)).toContain('yt:s:@aihistorydaily');
	// It overrides the list after a reload too.
	await page.reload();
	await page.waitForSelector('[data-colander-card]', { state: 'attached' });
	await expect(cards.nth(0)).toBeVisible();
	await expect(cards.nth(0).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
});

test('Why lists every signal that fired, within five lines', async ({ ext }) => {
	// At Label, the Slop source's card keeps a chip, so its Why is one click away.
	await ext.setup({ strictness: 'label' });
	const page = await ext.open(SEARCH);
	await page.locator('ytd-search ytd-video-renderer').nth(0).locator('colander-ui[data-kind="chip"] button').click();
	const pop = page.locator('colander-ui[data-kind="layer"] .pop');
	await expect(pop.locator('.why-sig li')).toHaveText([
		'The platform labels it AI-generated',
		'Most recent items are AI-made',
		'Tagged as slop by the community',
		'Confirmed by staff review'
	]);
	// Five lines at most: the title, the signals on one wrapping line, the list and date, the links, the actions.
	expect(await pop.evaluate((el) => el.children.length)).toBeLessThanOrEqual(5);
	await expect(pop.getByRole('link', { name: /Appeal this verdict/ })).toBeVisible();
});

test('Appeal is offered only for list verdicts', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	const pop = page.locator('colander-ui[data-kind="layer"] .pop');
	// The platform's own AI label: nothing on the list to appeal.
	await cards.nth(4).locator('colander-ui[data-kind="chip"] button').click();
	await expect(pop.locator('.why-sig li')).toHaveText(['The platform labels it AI-generated']);
	await expect(pop.getByRole('link', { name: 'Source page' })).toBeVisible();
	await expect(pop.getByRole('link', { name: /Appeal/ })).toHaveCount(0);
	await page.keyboard.press('Escape');
	// An item on the list can be appealed through its source.
	await cards.nth(2).locator('colander-ui[data-kind="chip"] button').click();
	await expect(pop.getByRole('link', { name: 'Is this your channel? Appeal this verdict.' })).toBeVisible();
	await page.keyboard.press('Escape');
	// Your own tag: no links at all.
	await ext.send({ type: 'tag', tag: { platform: 'yt', targetType: 'item', targetId: '5lqOeaAl2Zs', verdict: 'ai_fine', platformLabel: false } });
	await cards.nth(3).locator('colander-ui[data-kind="chip"] button').click();
	await expect(pop).toContainText('You tagged it as AI-made but fine.');
	await expect(pop.getByRole('link')).toHaveCount(0);
});

test('Show from the popup reveals a hidden item once', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const first = page.locator('ytd-search ytd-video-renderer').first();
	await expect(first).toBeHidden();
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await expect(popup.getByText('Hidden on this page')).toBeVisible();
	await popup.locator('li.item', { hasText: 'AI History Daily' }).getByRole('button', { name: 'Show' }).click();
	await expect(first).toBeVisible();
	await expect(first.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await page.reload();
	await page.waitForSelector('[data-colander-card]', { state: 'attached' });
	await expect(first).toBeHidden();
});

test('empty state in the popup', async ({ ext }) => {
	await ext.setup({ settings: { pausedSites: [] } });
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	await ext.send({ type: 'settings', patch: { strictness: 'standard' } });
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	// The channel page carries one AI-made video, which is labeled; nothing is hidden.
	await expect(popup.getByText('Hidden on this page')).toBeVisible();
	await expect(popup.getByRole('button', { name: 'Report this channel' })).toBeVisible();
});
