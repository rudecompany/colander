// Fixing a wrong call (P0-7): Why shows the layers that agreed, Show reveals once, Always allow
// overrides every list for this viewer, Not slop files a counter-tag. The popup offers the same (P0-12).
import type { Page } from '@playwright/test';
import { EXT_ID, expect, test } from './harness';

const SEARCH = 'https://www.youtube.com/results?search_query=history';
const rows = (page: Page) => page.locator('colander-ui[data-kind="layer"] .cl-pop .cl-ev-row');

test('Why, Show, Not slop and Always allow', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	await cards.nth(1).locator('colander-ui[data-kind="bar"]').getByRole('button', { name: 'Why' }).click();
	const pop = page.locator('colander-ui[data-kind="layer"] .cl-pop');
	await expect(page.getByRole('dialog', { name: 'Why this is hidden' })).toBeVisible();
	await expect(rows(page)).toHaveText(['Source behavior: Most recent items are AI-made.', 'Content: Taggers found it hollow.', 'AI evidence: No AI label or credentials found yet.']);
	await expect(rows(page).nth(2)).toHaveAttribute('data-agreed', 'false');
	await expect(pop).toContainText('Core list, updated 1 Aug 2026, imported and not yet reviewed');
	await expect(pop.getByRole('link', { name: 'Source page' })).toHaveAttribute('href', 'http://localhost:8787/s/yt/@catrescuetales');
	await expect(pop.getByRole('link', { name: 'Is this your channel? Appeal this verdict.' })).toHaveAttribute('href', 'http://localhost:8787/appeal/yt/@catrescuetales');

	await pop.getByRole('button', { name: 'Show' }).click();
	await expect(cards.nth(1)).not.toHaveAttribute('data-colander', /./);
	await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toContainText('Shown again.');

	// Not slop from the chip's Why files a source-level counter-tag once its toast ends.
	await cards.nth(1).locator('colander-ui[data-kind="chip"] button').click();
	await pop.getByRole('button', { name: 'Not slop' }).click();
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toContainText('Tagged as not slop. Counted toward the shared list.');
	await expect(cards.nth(1).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	await expect.poll(() => ext.api.posted('/v1/tags').length, { timeout: 8000 }).toBe(1);
	const tag = (ext.api.posted('/v1/tags')[0]!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(tag).toMatchObject({ target_type: 'source', target_id: '@catrescuetales', verdict: 'not_slop' });
	expect(tag.source_id).toBeUndefined();

	// Always allow from the popup's row menu, for the hidden card.
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	const row = popup.locator('.row', { has: popup.locator('[data-v="slop"]') });
	await row.locator('.row-btn').click();
	await popup.getByRole('menuitem', { name: 'Always allow this source' }).click();
	await expect(cards.nth(0)).not.toHaveAttribute('data-colander', /./);
	const settings = await ext.storage<{ allows: { key: string }[] }>('settings');
	expect(settings.allows.map((a) => a.key)).toContain('yt:s:@aihistorydaily');
	// It overrides the list after a reload too.
	await page.reload();
	await page.waitForSelector('[data-colander-card]', { state: 'attached' });
	await expect(cards.nth(0)).toBeVisible();
	await expect(cards.nth(0).locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
});

test('Why shows the layers that agreed first, within five lines', async ({ ext }) => {
	// At Label, the Slop source's card keeps a chip, so its Why is one click away.
	await ext.setup({ strictness: 'label' });
	const page = await ext.open(SEARCH);
	await page.locator('ytd-search ytd-video-renderer').nth(0).locator('colander-ui[data-kind="chip"] button').click();
	const pop = page.locator('colander-ui[data-kind="layer"] .cl-pop');
	await expect(pop.getByRole('heading', { name: 'Why this is labeled' })).toBeVisible();
	await expect(rows(page)).toHaveText([
		'AI evidence: The platform labels it AI-generated.',
		'Source behavior: Most recent items are AI-made.',
		'Community: Tagged as slop by the community.'
	]);
	for (const r of await rows(page).all()) await expect(r).toHaveAttribute('data-agreed', 'true');
	await expect(pop.getByRole('link', { name: /Appeal this verdict/ })).toBeVisible();
});

test('Appeal is offered only for list verdicts', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const cards = page.locator('ytd-search ytd-video-renderer');
	const pop = page.locator('colander-ui[data-kind="layer"] .cl-pop');
	// The platform's own AI label: nothing on the list to appeal.
	await cards.nth(4).locator('colander-ui[data-kind="chip"] button').click();
	await expect(rows(page).first()).toHaveText('AI evidence: The platform labels it AI-generated.');
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
	await expect(rows(page)).toHaveText(['Your tag: You tagged it as AI-made but fine.']);
	await expect(pop.getByRole('link')).toHaveCount(0);
});

test('Show from the popup reveals a hidden item once', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const first = page.locator('ytd-search ytd-video-renderer').first();
	await expect(first).toBeHidden();
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await expect(popup.getByText('Hidden for you today')).toBeVisible();
	await popup.locator('.row', { has: popup.locator('[data-v="slop"]') }).getByRole('button', { name: 'Show' }).click();
	await expect(first).toBeVisible();
	await expect(first.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await page.reload();
	await page.waitForSelector('[data-colander-card]', { state: 'attached' });
	await expect(first).toBeHidden();
});

test('Why from the popup opens on the card', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await popup.locator('.row', { has: popup.locator('[data-v="likely_slop"]') }).locator('.row-btn').click();
	await popup.getByRole('menuitem', { name: 'Why' }).click();
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-pop')).toContainText('Why this is hidden');
});

test('the popup lists what Colander labeled on a channel page', async ({ ext }) => {
	await ext.setup({ settings: { pausedSites: [] } });
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	// The channel page carries one AI-made video, which is labeled; nothing is hidden.
	await expect(popup.locator('.row [data-v="ai_made"]')).toHaveCount(1);
	await expect(popup.getByRole('button', { name: 'Show', exact: true })).toHaveCount(0);
});
