// Plus delivered in full: the 14-day trial and settings sync, early access to new platforms, the
// weekly summary in the popup, and a plan token checked every day so a cancel or refund turns Plus
// off within a day.
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
	await welcome.getByRole('button', { name: 'Continue' }).click();
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

test('the popup shows the week once: every 30 days with Get Plus, weekly with Plus', async ({ ext }) => {
	const day = (n: number) => {
		const d = new Date(Date.now() - n * DAY);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};
	const days = { [day(0)]: { hidden: 4, labeled: 2 }, [day(3)]: { hidden: 10, labeled: 5 }, [day(9)]: { hidden: 99, labeled: 0 } };
	await ext.ctl.evaluate((days) => chrome.storage.local.set({ stats: { firstRunAt: Date.now() - 10 * 86_400_000, days } }), days);
	const popup = await ext.ctx.newPage();
	const card = popup.getByText('Colander hid 14 items for you this week.');

	// Free: the person's own numbers with Get Plus, at most once in 30 days.
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	await expect(card).toBeVisible();
	await expect(popup.getByRole('button', { name: 'Get Plus' })).toBeVisible();
	await popup.getByRole('button', { name: 'Dismiss' }).click();
	await expect(card).toHaveCount(0);
	await popup.reload();
	await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
	await expect(card).toHaveCount(0);

	// Plus: the weekly summary, with Support our work instead of Get Plus.
	await ext.send({ type: 'start-trial' });
	await popup.reload();
	await expect(card).toBeVisible();
	await expect(popup.getByRole('button', { name: 'Get Plus' })).toHaveCount(0);
	// It stays for the day it showed, until dismissed.
	await popup.reload();
	await expect(card).toBeVisible();
	await popup.getByRole('button', { name: 'Dismiss' }).click();
	await expect(card).toHaveCount(0);
	await popup.reload();
	await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
	await expect(card).toHaveCount(0);
	// A week later it is back.
	await ext.ctl.evaluate(() => chrome.storage.local.set({ weeklyCard: { shownAt: Date.now() - 8 * 86_400_000, dismissedAt: Date.now() - 8 * 86_400_000 } }));
	await popup.reload();
	await expect(card).toBeVisible();
});

test('a paid plan is checked daily, and a cancel or refund turns Plus off within a day', async ({ ext }) => {
	// A yearly plan, connected with a code: months away from its end, so a refresh only near the end would miss a refund.
	const exp = Math.floor(Date.now() / 1000) + 300 * 86400;
	ext.api.pair = { kind: 'plan', token: planToken({ trial: false, exp }) };
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
	await opts.getByLabel('Code from the website').fill('KXQ4-JP7M');
	await opts.getByRole('button', { name: 'Connect' }).click();
	await expect.poll(() => ext.storage('entitlement')).toEqual({ plus: true, trial: false, exp, account: 'p***@colander.test' });

	// Options names the account it came from, and leaves the renewal date to the website: the token
	// runs a few days past the paid period.
	await expect(opts.getByText('Plus is on in this browser, connected to the account p***@colander.test. Renewal and billing are on the website.', { exact: true })).toBeVisible();

	const refreshes = () => ext.api.posted('/v1/entitlement/refresh');
	// The paired token is fresh from the server, so it counts as checked now.
	await ext.send({ type: 'sync-now' });
	expect(refreshes()).toHaveLength(0);
	// A day later the hourly sync checks it once, with only the token and no install ID.
	await ext.ctl.evaluate(() => chrome.storage.local.set({ planCheckedAt: Date.now() - 25 * 3600_000 }));
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
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
	await expect(opts.getByRole('heading', { name: 'Current plan: Free' })).toBeVisible();
});

test('the 14-day trial needs no card and unlocks Plus features', async ({ ext }) => {
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
	// Per-platform levels are part of Plus: in view, inert, until the trial starts.
	await expect(opts.getByText('Part of Plus.')).toBeVisible();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
	await opts.getByRole('button', { name: 'Start 14 days free' }).click();
	await expect(opts.getByRole('heading', { name: 'Plus adds control' })).toHaveCount(0);
	const trial = ext.api.posted('/v1/trial')[0]!;
	expect(trial.auth).toMatch(/^Install /);
	expect(trial.body).toBeUndefined();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
	await expect(opts.getByText('Part of Plus.')).toHaveCount(0);
	await opts.getByRole('radiogroup', { name: 'TikTok strictness' }).getByRole('radio', { name: 'No AI' }).click();
	await expect.poll(() => ext.storage<{ perPlatform: Record<string, string> }>('settings').then((s) => s.perPlatform)).toEqual({ tt: 'no_ai' });
	// Plus settings sync pushes the change with the plan token.
	await expect.poll(() => ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').length).toBeGreaterThan(0);
	const put = ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').at(-1)!;
	expect(put.auth).toMatch(/^Plan /);
	expect((put.body as { data: { perPlatform: unknown } }).data.perPlatform).toEqual({ tt: 'no_ai' });
});

test('settings sync recovers when the server has no copy of the version this browser last saw', async ({ ext }) => {
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plus`);
	await opts.getByRole('button', { name: 'Start 14 days free' }).click();
	await expect(opts.getByRole('heading', { name: 'Plus adds control' })).toHaveCount(0);
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
	await expect(opts.getByText('Part of Plus.')).toHaveCount(0);
	// This browser last saw version 5 on a server that has since lost its copy (a reset store).
	await ext.ctl.evaluate(() => chrome.storage.local.set({ syncState: { version: 5, dirty: false, sub: 'trl_e2e' } }));
	ext.api.syncBlob = null;
	await opts.getByRole('radiogroup', { name: 'TikTok strictness' }).getByRole('radio', { name: 'No AI' }).click();
	// The 409 carries data: null and version 0; the extension merges nothing and saves on top of 0.
	await expect.poll(() => ext.storage('syncState')).toEqual({ version: 1, dirty: false, sub: 'trl_e2e' });
	const versions = ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').map((s) => (s.body as { version: number }).version);
	expect(versions.slice(-2)).toEqual([5, 0]);
	expect(ext.api.syncBlob).toMatchObject({ version: 1, data: { perPlatform: { tt: 'no_ai' } } });
});
