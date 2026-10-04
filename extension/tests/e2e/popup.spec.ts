// The popup is 360 wide and never over 600 tall: it never scrolls in the default state, and
// every state fits, in both themes, with long titles. Its controls are 32 px targets.
import type { Page } from '@playwright/test';
import { EXT_ID, expect, fixtureHtml, test, type Ext } from './harness';

const SEARCH = 'https://www.youtube.com/results?search_query=history';
const LONG = 'A title that runs on well past forty characters to test the ellipsis';

async function popupFor(ext: Ext, tab: number | null): Promise<Page> {
	const popup = await ext.ctx.newPage();
	await popup.setViewportSize({ width: 360, height: 600 });
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html${tab ? `?tab=${tab}` : ''}`);
	await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
	return popup;
}

const height = (popup: Page) => popup.evaluate(() => document.documentElement.scrollHeight);

for (const scheme of ['light', 'dark'] as const) {
	test.describe(scheme, () => {
		test.use({ colorScheme: scheme });

		test(`every popup state fits in 600 px, ${scheme}`, async ({ ext }) => {
			await ext.setup();
			// Long titles on every card the page acts on.
			const html = fixtureHtml('yt-search').replace(/(<a[^>]*id="video-title"[^>]*>)[^<]*/g, `$1${LONG}`);
			const page = await ext.open(SEARCH, { html });
			const tab = await ext.tabId(page);
			const popup = await popupFor(ext, tab);
			const states: string[] = [];
			const check = async (state: string) => {
				states.push(state);
				expect.soft(await height(popup), state).toBeLessThanOrEqual(600);
			};

			await expect(popup.getByText('Active on youtube.com')).toBeVisible();
			await check('default');
			// Rows are 32 px targets or larger.
			for (const b of await popup.locator('.row button').all()) expect.soft((await b.boundingBox())!.height).toBeGreaterThanOrEqual(32);
			const all = popup.getByRole('button', { name: /^Show all/ });
			if (await all.count()) {
				await all.click();
				await check('show all');
			}

			await popup.getByRole('button', { name: 'Pause' }).click();
			await popup.getByRole('menuitem', { name: 'Pause on this site' }).click();
			await expect(popup.getByText('Paused on this site.')).toBeVisible();
			await check('paused');
			await popup.getByRole('button', { name: 'Resume' }).click();
			await expect(popup.getByText('Active on youtube.com')).toBeVisible();

			// Each slot item: a sync failure, a report verdict, the weekly card.
			const patchStatus = (patch: Record<string, unknown>) =>
				ext.ctl.evaluate(async (p) => {
					const { status } = (await chrome.storage.local.get('status')) as { status: Record<string, unknown> };
					await chrome.storage.local.set({ status: { ...status, ...p } });
				}, patch);
			await patchStatus({ lastError: 'offline', lastSyncAt: Date.now() - 7 * 3600_000 });
			await expect(popup.getByText('The list could not update.')).toBeVisible();
			await check('sync failure');
			await patchStatus({ lastError: null, reportsUpdated: true });
			await expect(popup.getByText('A report you sent has a verdict.')).toBeVisible();
			await check('report verdict');
			await patchStatus({ reportsUpdated: false });
			const today = await ext.ctl.evaluate(() => {
				const d = new Date();
				return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
			});
			await ext.ctl.evaluate((day) => chrome.storage.local.set({ stats: { firstRunAt: Date.now() - 9 * 86_400_000, days: { [day]: { hidden: 12, labeled: 4 } } } }), today);
			await popup.reload();
			// The page's own activity can land in today's count too, so the number is not pinned.
			await expect(popup.getByText(/^You skipped \d+ slop items this week\.$/)).toBeVisible();
			await check('weekly card');

			// A supported site with nothing to do, and a site Colander does not run on.
			const empty = await ext.open('https://www.youtube.com/watch?v=xxxxxxxxxxx', { html: '<!doctype html><html lang="en"><body><div data-colander-card></div></body></html>' });
			const quiet = await popupFor(ext, await ext.tabId(empty));
			await expect(quiet.locator('.empty')).toHaveText('Nothing hidden on this page.');
			expect.soft(await height(quiet), 'empty page').toBeLessThanOrEqual(600);
			const elsewhere = await popupFor(ext, null);
			await expect(elsewhere.getByText('Colander works on YouTube, TikTok, Instagram and Facebook.')).toBeVisible();
			expect.soft(await height(elsewhere), 'unsupported site').toBeLessThanOrEqual(600);
			expect(states.length).toBeGreaterThanOrEqual(5);
		});
	});
}

test('pause and resume from the popup, on this site and on this tab', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const first = page.locator('ytd-search ytd-video-renderer').first();
	await expect(first).toHaveAttribute('data-colander', 'hide');
	const tabId = await ext.tabId(page);
	const title = () => ext.ctl.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId);
	const popup = await popupFor(ext, tabId);

	// By keyboard, focus follows the control that replaces the one used: Resume, then Pause.
	await popup.getByRole('button', { name: 'Pause' }).focus();
	await popup.keyboard.press('Enter');
	await expect(popup.getByRole('menuitem', { name: 'Pause on this site' })).toBeFocused();
	await popup.keyboard.press('Enter');
	await expect(popup.getByText('Paused on this site.')).toBeVisible();
	await expect(popup.getByRole('button', { name: 'Resume' })).toBeFocused();
	await expect(first).not.toHaveAttribute('data-colander', /./);
	await expect(page.locator('colander-ui[data-kind="tag"]')).toHaveCount(0);
	await expect(page.locator('colander-ui[data-kind="chip"]')).toHaveCount(0);
	await expect.poll(title).toBe('Colander, paused on this site');
	await popup.keyboard.press('Enter');
	await expect(first).toHaveAttribute('data-colander', 'hide');
	await expect(popup.getByRole('button', { name: 'Pause' })).toBeFocused();

	await popup.getByRole('button', { name: 'Pause' }).click();
	await popup.getByRole('menuitem', { name: 'Pause on this tab' }).click();
	await expect(popup.getByText('Paused on this tab.')).toBeVisible();
	await expect(first).not.toHaveAttribute('data-colander', /./);
	await expect.poll(title).toBe('Colander, paused on this tab');
	// Other tabs on the same site keep blocking.
	const other = await ext.open(SEARCH);
	await expect(other.locator('ytd-search ytd-video-renderer').first()).toHaveAttribute('data-colander', 'hide');
	await popup.getByRole('button', { name: 'Resume' }).click();
	await expect(first).toHaveAttribute('data-colander', 'hide');
});
