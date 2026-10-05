// Website handoff over externally_connectable (contract 7).
import { EXT_ID, expect, planToken, test } from './harness';

test('ping, plan token and reviewer token from the website origin', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.route('http://localhost:8787/account', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Account</title><p>Account</p>' }));
	await page.goto('http://localhost:8787/account');
	const send = (m: unknown) => page.evaluate(([id, m]) => chrome.runtime.sendMessage(id as string, m), [EXT_ID, m] as const);

	expect(await send({ type: 'colander:ping' })).toEqual({ ok: true, version: '1.0.0' });
	expect(await send({ type: 'colander:plan-token', token: 'forged.token' })).toEqual({ ok: false, error: 'invalid_token' });
	const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
	expect(await send({ type: 'colander:plan-token', token: planToken({ trial: false, exp }) })).toEqual({ ok: true });
	await expect.poll(() => ext.storage('entitlement')).toEqual({ plus: true, trial: false, exp });
	expect(await send({ type: 'colander:reviewer-token', token: 'rvw_abc123' })).toEqual({ ok: true });
	expect(await ext.storage('reviewerToken')).toBe('rvw_abc123');
	expect(await send({ type: 'colander:unknown' })).toEqual({ ok: false, error: 'unknown_message' });
});

test('the 14-day trial needs no card and unlocks Plus features', async ({ ext }) => {
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
	await opts.getByRole('button', { name: 'Start 14-day trial, no card' }).click();
	await expect(opts.getByLabel('TikTok')).toBeVisible();
	const trial = ext.api.posted('/v1/trial')[0]!;
	expect(trial.auth).toMatch(/^Install /);
	expect(trial.body).toBeUndefined();
	await opts.getByLabel('TikTok').selectOption('no_ai');
	await expect.poll(() => ext.storage<{ perPlatform: Record<string, string> }>('settings').then((s) => s.perPlatform)).toEqual({ tt: 'no_ai' });
	// Plus settings sync pushes the change with the plan token.
	await expect.poll(() => ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').length).toBeGreaterThan(0);
	const put = ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').at(-1)!;
	expect(put.auth).toMatch(/^Plan /);
	expect((put.body as { data: { perPlatform: unknown } }).data.perPlatform).toEqual({ tt: 'no_ai' });
});

test('settings sync recovers when the server has no copy of the version this browser last saw', async ({ ext }) => {
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#strictness`);
	await opts.getByRole('button', { name: 'Start 14-day trial, no card' }).click();
	await expect(opts.getByLabel('TikTok')).toBeVisible();
	// This browser last saw version 5 on a server that has since lost its copy (a reset store).
	await ext.ctl.evaluate(() => chrome.storage.local.set({ syncState: { version: 5, dirty: false } }));
	ext.api.syncBlob = null;
	await opts.getByLabel('TikTok').selectOption('no_ai');
	// The 409 carries data: null and version 0; the extension merges nothing and saves on top of 0.
	await expect.poll(() => ext.storage('syncState')).toEqual({ version: 1, dirty: false });
	const versions = ext.api.sent.filter((s) => s.path === '/v1/sync' && s.method === 'PUT').map((s) => (s.body as { version: number }).version);
	expect(versions.slice(-2)).toEqual([5, 0]);
	expect(ext.api.syncBlob).toMatchObject({ version: 1, data: { perPlatform: { tt: 'no_ai' } } });
});
