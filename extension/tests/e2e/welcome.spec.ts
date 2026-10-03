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
	await expect(page.getByRole('heading', { name: 'Welcome to Colander' })).toBeVisible();
	await expect(page.getByRole('radio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
	await recordRequests(page, true);
	await page.getByRole('radio', { name: /Strict Hides slop and likely slop/ }).click();
	await page.getByRole('checkbox', { name: /TikTok/ }).click();
	const opened = ext.ctx.waitForEvent('page');
	await page.getByRole('button', { name: 'Start using Colander' }).click();
	const requested = await page.evaluate(() => (window as unknown as { requested: { origins: string[] }[] }).requested);
	expect(requested).toEqual([{ origins: ['*://www.youtube.com/*', '*://m.youtube.com/*', '*://www.tiktok.com/*', '*://m.tiktok.com/*'] }]);
	// YouTube opens in a new tab. Its first navigation can start before routes attach, and nothing
	// leaves the machine, so check where Chrome sent the tab rather than what loaded in it.
	await opened;
	await expect.poll(() => ext.ctl.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.pendingUrl ?? t.url))).toContain('https://www.youtube.com/');
	await expect(page.getByRole('heading', { name: 'You are set' })).toBeVisible();
	const s = await ext.storage<{ platforms: Record<string, boolean>; strictness: string; onboarded: boolean }>('settings');
	expect(s.platforms).toEqual({ yt: true, tt: true, ig: false, fb: false });
	expect(s.strictness).toBe('strict');
	expect(s.onboarded).toBe(true);
	await expect
		.poll(() => ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort()))
		.toEqual(['cl-tt', 'cl-tt-bridge', 'cl-yt', 'cl-yt-bridge']);
});

test('if site access is refused, nothing is switched on', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	await recordRequests(page, false);
	await page.getByRole('button', { name: 'Start using Colander' }).click();
	await expect(page.getByRole('alert')).toContainText('Chrome did not grant site access');
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
