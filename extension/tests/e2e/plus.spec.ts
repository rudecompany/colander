// Plus delivered in full: early access to new platforms, the weekly summary in the popup, and a
// plan token checked every day so a cancel or refund turns Plus off within a day.
import { EXT_ID, devSign, expect, planToken, test, type Ext } from './harness';
import defaults from '../../src/adapters/default-config.json' with { type: 'json' };

const DAY = 86_400_000;
const registered = (ext: Ext) => ext.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort());

test('early access platforms are offered and run only with Plus', async ({ ext }) => {
	// No platform is early access in the bundled config; a signed fixture config marks TikTok.
	const cfg = structuredClone(defaults) as typeof defaults & { platforms: { tt: { early_access?: boolean } } };
	cfg.version = 2;
	cfg.platforms.tt.early_access = true;
	const payload = Buffer.from(JSON.stringify(cfg));
	ext.api.config = { kid: '941afaf31a9c228e', payload: payload.toString('base64'), sig: devSign('colander:config:v1', payload).toString('base64') };
	await ext.send({ type: 'sync-now' });
	await expect.poll(() => ext.storage<{ version: number }>('adapterConfig').then((c) => c?.version)).toBe(2);

	const welcome = await ext.ctx.newPage();
	await welcome.goto(`chrome-extension://${EXT_ID}/welcome.html`);
	await expect(welcome.getByRole('checkbox', { name: /YouTube/ })).toBeVisible();
	await expect(welcome.getByRole('checkbox', { name: /TikTok/ })).toHaveCount(0);
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#platforms`);
	await expect(opts.getByRole('switch', { name: 'YouTube' })).toBeVisible();
	await expect(opts.getByRole('switch', { name: 'TikTok' })).toHaveCount(0);
	await expect(opts.getByText('Early access to new platforms is part of Plus.')).toBeVisible();
	// Switched on some other way, it still does not run.
	await ext.send({ type: 'set-platform', platform: 'tt', on: true });
	await ext.send({ type: 'set-platform', platform: 'yt', on: true });
	await expect.poll(() => registered(ext)).toEqual(['cl-yt', 'cl-yt-bridge']);

	// With Plus it is offered everywhere and runs.
	await ext.send({ type: 'start-trial' });
	await expect.poll(() => registered(ext)).toEqual(['cl-tt', 'cl-tt-bridge', 'cl-yt', 'cl-yt-bridge']);
	await expect(welcome.getByRole('checkbox', { name: /TikTok/ })).toBeVisible();
	await expect(opts.getByRole('switch', { name: 'TikTok' })).toHaveAttribute('aria-checked', 'true');
	await expect(opts.getByText('Early access', { exact: true })).toBeVisible();

	// When Plus ends, it stops running.
	await ext.ctl.evaluate(() => chrome.storage.local.set({ entitlement: { plus: false, trial: true, exp: 0 } }));
	await expect.poll(() => registered(ext)).toEqual(['cl-yt', 'cl-yt-bridge']);
});

test('the popup shows a weekly summary to Plus users, once a week', async ({ ext }) => {
	const day = (n: number) => {
		const d = new Date(Date.now() - n * DAY);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};
	const days = { [day(0)]: { hidden: 3, collapsed: 1, labeled: 2 }, [day(3)]: { hidden: 10, collapsed: 0, labeled: 5 }, [day(9)]: { hidden: 99, collapsed: 0, labeled: 0 } };
	await ext.ctl.evaluate((days) => chrome.storage.local.set({ stats: { firstRunAt: Date.now() - 10 * 86_400_000, days } }), days);
	const popup = await ext.ctx.newPage();
	const card = popup.locator('section', { has: popup.getByRole('heading', { name: 'Your week' }) });

	// Free: the support card, no weekly summary.
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	await expect(popup.getByText('Colander runs on support from people like you.', { exact: false })).toBeVisible();
	await expect(card).toHaveCount(0);

	await ext.send({ type: 'start-trial' });
	await popup.reload();
	await expect(card).toContainText('In the last 7 days Colander hid or collapsed 14 items and labeled 7.');
	await expect(popup.getByText('Colander runs on support', { exact: false })).toHaveCount(0);
	// It stays for the day it showed, until dismissed.
	await popup.reload();
	await expect(card).toBeVisible();
	await card.getByRole('button', { name: 'Dismiss the weekly summary' }).click();
	await expect(card).toHaveCount(0);
	await popup.reload();
	await expect(popup.getByRole('heading', { name: 'On this page' })).toBeVisible();
	await expect(card).toHaveCount(0);
	// A week later it is back.
	await ext.ctl.evaluate(() => chrome.storage.local.set({ weeklyCard: { shownAt: Date.now() - 8 * 86_400_000, dismissedAt: Date.now() - 8 * 86_400_000 } }));
	await popup.reload();
	await expect(card).toBeVisible();
});

test('a paid plan is checked daily, and a cancel or refund turns Plus off within a day', async ({ ext }) => {
	const site = await ext.ctx.newPage();
	await site.route('http://localhost:8787/account', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account</title>' }));
	await site.goto('http://localhost:8787/account');
	// A yearly plan: months away from its end, so a refresh only near the end would miss a refund.
	const exp = Math.floor(Date.now() / 1000) + 300 * 86400;
	await site.evaluate(([id, token]) => chrome.runtime.sendMessage(id, { type: 'colander:plan-token', token }), [EXT_ID, planToken({ trial: false, exp })] as const);
	await expect.poll(() => ext.storage('entitlement')).toEqual({ plus: true, trial: false, exp });

	const refreshes = () => ext.api.posted('/v1/entitlement/refresh');
	await ext.send({ type: 'sync-now' });
	expect(refreshes()).toHaveLength(1);
	expect(refreshes()[0]!.auth).toBeUndefined();
	expect(Object.keys(refreshes()[0]!.body as object)).toEqual(['token']);
	// Once a day, not on every hourly sync.
	await ext.send({ type: 'sync-now' });
	expect(refreshes()).toHaveLength(1);

	// The plan was refunded; a day later the check finds no plan and Plus turns off.
	ext.api.plan = 'ended';
	await ext.ctl.evaluate(() => chrome.storage.local.set({ planCheckedAt: Date.now() - 25 * 3600_000 }));
	await ext.send({ type: 'sync-now' });
	expect(refreshes()).toHaveLength(2);
	expect(await ext.storage<{ plus: boolean }>('entitlement')).toMatchObject({ plus: false });
	expect(await ext.storage('planToken')).toBeUndefined();
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
	await expect(opts.getByRole('heading', { name: 'Free', level: 3 })).toBeVisible();
});
