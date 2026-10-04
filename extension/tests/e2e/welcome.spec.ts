// First run: Chrome is asked for site access only for the chosen platforms.
import { EXT_ID, expect, test } from './harness';

async function recordRequests(page: import('@playwright/test').Page, grant: boolean) {
	await page.evaluate((grant) => {
		const w = window as unknown as { requested: unknown[] };
		w.requested = [];
		const real = chrome.permissions.request.bind(chrome.permissions);
		chrome.permissions.request = ((p: chrome.permissions.Permissions) => {
			w.requested.push(p);
			// The end-to-end build already holds the permission, so the real call answers at once.
			return grant ? real(p) : Promise.resolve(false);
		}) as typeof chrome.permissions.request;
	}, grant);
}

test('the welcome tab opens on install', async ({ ext }) => {
	await expect.poll(() => ext.ctx.pages().map((p) => p.url())).toContain(`chrome-extension://${EXT_ID}/welcome.html`);
});

test('choose strictness and platforms, then Chrome asks for those sites only', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	await expect(page.getByRole('heading', { name: 'Set up Colander in 3 steps.' })).toBeVisible();
	await expect(page.getByText('Step 1 of 3')).toBeVisible();
	const levels = page.getByRole('radiogroup', { name: 'How strict should it be?' });
	await expect(levels.getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
	// The step's one control comes before the recreated feed, and the feed says its thumbnails are generated.
	const demo = page.locator('colander-ui[data-kind="demo"]');
	expect((await levels.boundingBox())!.y).toBeLessThan((await demo.boundingBox())!.y);
	await expect(page.getByText('Thumbnails are AI-generated illustrations.')).toBeVisible();
	await recordRequests(page, true);
	await expect(levels.getByRole('radio')).toHaveText(['Label', 'Standard', 'No AI']);
	// The recreated feed follows the level: at No AI the AI-made item leaves the page too, without a gap.
	await expect(demo.getByText('Tide pools at low tide, a field guide')).toHaveCount(1);
	await levels.getByRole('radio', { name: 'No AI' }).click();
	await expect(demo.getByText('Tide pools at low tide, a field guide')).toHaveCount(0);
	await expect(demo.getByText('Ancient Rome facts you never knew, Part 46')).toHaveCount(0);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByText('Step 2 of 3')).toBeVisible();
	await page.getByRole('checkbox', { name: /TikTok/ }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	const requested = await page.evaluate(() => (window as unknown as { requested: { origins: string[] }[] }).requested);
	expect(requested).toEqual([{ origins: ['*://www.youtube.com/*', '*://m.youtube.com/*', '*://www.tiktok.com/*', '*://m.tiktok.com/*'] }]);
	await expect(page.getByRole('heading', { name: 'Pin Colander' })).toBeVisible();
	await expect(page.getByRole('list', { name: 'The toolbar icon' }).getByRole('listitem')).toHaveText(['Active', 'Paused', 'Needs attention']);
	// YouTube opens in a new tab. Its first navigation can start before routes attach, and nothing
	// leaves the machine, so check where Chrome sent the tab rather than what loaded in it.
	const opened = ext.ctx.waitForEvent('page');
	await page.getByRole('button', { name: 'Done' }).click();
	await opened;
	await expect.poll(() => ext.ctl.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl ?? t.url))).toContain('https://www.youtube.com/');
	await expect(page.getByRole('heading', { name: 'You are set' })).toBeVisible();
	const s = await ext.storage<{ platforms: Record<string, boolean>; strictness: string; onboarded: boolean }>('settings');
	expect(s.platforms).toEqual({ yt: true, tt: true, ig: false, fb: false });
	expect(s.strictness).toBe('no_ai');
	expect(s.onboarded).toBe(true);
	await expect
		.poll(() => ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort()))
		.toEqual(['cl-tt', 'cl-tt-bridge', 'cl-yt', 'cl-yt-bridge']);
});

test('if site access is refused, nothing is switched on', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	await recordRequests(page, false);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('Chrome did not grant site access');
	await expect(page.getByText('Step 2 of 3')).toBeVisible();
	const scripts = await ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
	expect(scripts).toBe(0);
});

test('platform switches in Options register and unregister content scripts', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.goto(`chrome-extension://${EXT_ID}/options.html#platforms`);
	await recordRequests(page, true);
	await page.getByRole('switch', { name: 'Facebook' }).click();
	await expect(page.getByRole('switch', { name: 'Facebook' })).toHaveAttribute('aria-checked', 'true');
	await expect.poll(() => ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort())).toEqual(['cl-fb', 'cl-fb-bridge']);
	const reg = await ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['cl-fb', 'cl-fb-bridge'] })).map((s) => [s.runAt, s.world ?? 'ISOLATED']));
	expect(reg).toEqual([['document_start', 'ISOLATED'], ['document_start', 'MAIN']]);
	await page.getByRole('switch', { name: 'Facebook' }).click();
	await expect.poll(() => ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(0);
});
