// Pairing codes, the one website-to-extension handoff (contract 7): a code from the website
// becomes a plan token in Options or a reviewer token in the side panel.
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, expect, planToken, test } from './harness';

test('a plan code typed in Options turns Plus on, and the claim carries only the code', async ({ ext }) => {
	const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
	ext.api.pair = { kind: 'plan', token: planToken({ trial: false, exp }) };
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
	const card = opts.locator('.uin-card', { has: opts.getByRole('heading', { name: 'Connect Plus with a code' }) });
	await expect(card.getByText('On the Colander website, open your account and choose Show a code. It works once, for 10 minutes.')).toBeVisible();

	// A code that cannot be one is caught here; nothing is sent.
	await card.getByLabel('Code from the website').fill('KXQ4-JP7');
	await card.getByRole('button', { name: 'Connect' }).click();
	await expect(card.getByRole('alert')).toHaveText('Enter the 8 characters of the code, for example KXQ4-JP7M.');
	expect(ext.api.posted('/v1/pair/claim')).toHaveLength(0);

	// Typed loosely: lowercase, a space for the dash.
	await card.getByLabel('Code from the website').fill('kxq4 jp7m');
	await card.getByRole('button', { name: 'Connect' }).click();
	await expect(opts.getByRole('heading', { level: 2, name: 'Plus, active' })).toBeVisible();
	await expect.poll(() => ext.storage('entitlement')).toEqual({ plus: true, trial: false, exp });
	const claim = ext.api.posted('/v1/pair/claim')[0]!;
	expect(claim.body).toEqual({ code: 'KXQ4JP7M', ext_version: '1.0.0', browser: 'chromium' });
	expect(claim.auth).toBeUndefined();
	// Paid Plus is connected, so the card is gone.
	await expect(opts.getByRole('heading', { name: 'Connect Plus with a code' })).toHaveCount(0);
});

test('a wrong, used or limited code says so, and a plan that does not verify is refused', async ({ ext }) => {
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#plan`);
	const input = opts.getByLabel('Code from the website');
	const connect = opts.getByRole('button', { name: 'Connect' });

	ext.api.pair = { status: 404, code: 'invalid_code', message: 'This code is not valid. It may have expired or been used already. Make a new one on the website.' };
	await input.fill('KXQ4-JP7M');
	await connect.click();
	await expect(opts.getByRole('alert')).toHaveText('This code is not valid. It may have expired or been used already. Make a new one on the website.');

	ext.api.pair = { status: 429, code: 'rate_limited', message: 'Too many requests. Please wait a moment and try again.' };
	await connect.click();
	await expect(opts.getByRole('alert')).toHaveText('Too many requests. Please wait a moment and try again.');

	// A token the trusted keys do not sign is never stored.
	ext.api.pair = { kind: 'plan', token: 'unsigned.plan' };
	await connect.click();
	await expect(opts.getByRole('alert')).toHaveText('Colander could not verify this plan. Update Colander, then make a new code.');
	expect(await ext.storage('planToken')).toBeUndefined();
	expect(await ext.storage('entitlement')).toBeUndefined();
	await expect(opts.getByRole('heading', { level: 2, name: 'Current plan: Free' })).toBeVisible();
});

test('a reviewer code in the side panel connects it to the review queue', async ({ ext }) => {
	ext.api.review.queue = REVIEW_QUEUE();
	ext.api.review.source = REVIEW_SOURCE;
	ext.api.pair = { kind: 'reviewer', token: 'rvw_paired' };
	const side = await ext.ctx.newPage();
	await side.setViewportSize({ width: 400, height: 900 });
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();
	await side.getByLabel('Code from the website').fill('RVW4-2K9P');
	await side.getByRole('button', { name: 'Connect' }).click();
	await expect(side.getByRole('button', { name: /Cat Rescue Tales/ })).toBeVisible();
	expect(await ext.storage('reviewerToken')).toBe('rvw_paired');
	expect(ext.api.sent.find((s) => s.path.startsWith('/v1/review/queue'))!.auth).toBe('Bearer rvw_paired');

	// With a reviewer token the popup offers Review, which opens this panel.
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	await expect(popup.getByRole('button', { name: 'Review' })).toBeVisible();

	// A token the server no longer accepts asks for a new code.
	ext.api.review.unauthorized = true;
	await side.reload();
	await expect(side.getByRole('alert')).toHaveText('This connection has ended. Connect again with a new code from your account page.');
	await expect(side.getByLabel('Code from the website')).toBeVisible();
});
