import { test, expect } from './fixtures.ts';
import { ACCOUNT, PLUS_ACCOUNT, STAFF, mockApi } from './mocks.ts';

test('sign in by emailed link, then the account page shows the account', async ({ page }) => {
	let signedIn = false;
	const calls = await mockApi(page, {
		'POST /v1/auth/email': { status: 202 },
		'POST /v1/auth/verify': (c) => {
			if (c.body.token !== 'tok_123') return { status: 400, json: { error: { code: 'invalid_token', message: 'This link is not valid.' } } };
			signedIn = true;
			return { json: { account: ACCOUNT } };
		},
		'GET /v1/account': () => (signedIn ? { json: { account: ACCOUNT } } : { status: 401, json: { error: { code: 'not_signed_in', message: 'Sign in.' } } })
	});

	await page.goto('/account');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	await page.getByLabel('Email').fill('maya@example.com');
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	// Focus follows the form: to the notice once sent, back to the field for another address.
	await expect(page.locator('.sent-note')).toBeFocused();
	await page.getByRole('button', { name: 'Use a different address' }).click();
	await expect(page.getByLabel('Email')).toBeFocused();
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	const send = calls.find((c) => c.path === '/v1/auth/email')!;
	expect(send.body).toEqual({ email: 'maya@example.com', next: '/account' });
	expect(send.headers['x-colander-csrf']).toBe('1');

	await page.goto('/auth/callback?token=tok_123&next=/account');
	await expect(page).toHaveURL(/\/account$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello, Maya');
	await expect(page.getByText('Signed in as maya@example.com')).toBeVisible();
	await expect(page.getByText('Free.', { exact: false })).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/auth/verify')!.headers['x-colander-csrf']).toBe('1');
});

test('an expired sign-in link explains what to do and never redirects off-site', async ({ page }) => {
	await mockApi(page, { 'POST /v1/auth/verify': { status: 400, json: { error: { code: 'expired', message: 'Expired.' } } } });
	await page.goto('/auth/callback?token=old&next=//evil.example');
	await expect(page.getByText('This sign-in link has expired or was already used.', { exact: false })).toBeVisible();
	await expect(page).toHaveURL(/\/auth\/callback/);
});

test('connect a browser shows a pairing code and says when the extension takes it', async ({ page }) => {
	let polls = 0;
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: PLUS_ACCOUNT } },
		'POST /v1/pair': { status: 201, json: { id: 'pair_abc', code: 'KXQ4-JP7M', expires_at: new Date(Date.now() + 600_000).toISOString() } },
		// The extension claims the code on the third check.
		'GET /v1/pair/*': () => ({ json: ++polls < 3 ? { status: 'pending', ext_version: null, browser: null } : { status: 'claimed', ext_version: '1.4.0', browser: 'firefox' } }),
		'POST /v1/billing/cancel': (c) => ({
			json: {
				account: {
					...PLUS_ACCOUNT,
					plan: c.body.refund
						? { ...PLUS_ACCOUNT.plan!, status: 'canceled', refundable: false }
						: { ...PLUS_ACCOUNT.plan!, cancel_at_period_end: true }
				}
			}
		})
	});
	await page.goto('/account');
	const connect = page.locator('section', { has: page.getByRole('heading', { name: 'Connect a browser' }) });
	await connect.getByRole('button', { name: 'Show a code' }).click();
	await expect(connect.getByText('KXQ4-JP7M')).toBeVisible();
	await expect(connect.getByText('Never share this code. Colander staff never ask for it.')).toBeVisible();
	await expect(connect.getByText(/^Works once, for (10:00|9:\d\d) more\./)).toBeVisible();
	await expect(connect.getByRole('button', { name: 'Copy' })).toBeVisible();
	const made = calls.find((c) => c.path === '/v1/pair')!;
	expect(made.body).toEqual({ kind: 'plan' });
	expect(made.headers['x-colander-csrf']).toBe('1');
	// Checked every 2 seconds: the third check finds it claimed.
	await expect(connect.getByText('Connected Colander 1.4.0 in Firefox.')).toBeVisible({ timeout: 10_000 });
	await expect(connect.getByText('Plus is on there.')).toBeVisible();
	await expect(connect.getByRole('button', { name: 'Connect another browser' })).toBeVisible();
	expect(calls.filter((c) => c.path === '/v1/pair/pair_abc')).toHaveLength(3);

	await page.getByRole('button', { name: 'Cancel Plus' }).click();
	await page.getByRole('button', { name: 'End now and refund' }).click();
	await expect(page.getByText('Plus has ended and your last charge is being refunded.')).toBeVisible();
	expect(calls.filter((c) => c.path === '/v1/billing/cancel').map((c) => c.body)).toEqual([{ refund: false }, { refund: true }]);
	await expect(page.getByText('Free.', { exact: false })).toBeVisible();
	await expect(page.getByText('Once you have Plus, connect each browser you use here with a code.')).toBeVisible();
});

test('one click cancels, keeps Plus until the period ends and still offers the refund', async ({ page }) => {
	const cancelled = { ...PLUS_ACCOUNT, plan: { ...PLUS_ACCOUNT.plan!, cancel_at_period_end: true } };
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: PLUS_ACCOUNT } },
		'POST /v1/billing/cancel': (c) =>
			c.body.refund
				? { status: 409, json: { error: { code: 'not_refundable', message: 'Your last charge is more than 30 days old, so it cannot be refunded.' } } }
				: { json: { account: cancelled } }
	});
	await page.goto('/account');
	await expect(page.getByText('Renews on 12 September 2027.')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel Plus' }).click();
	// No confirm step: the first click cancels, and the plan line says what happens next.
	await expect(page.getByText('Cancelled. Plus stays on until 12 September 2027, and you will not be charged again.')).toBeVisible();
	expect(calls.filter((c) => c.path === '/v1/billing/cancel').map((c) => c.body)).toEqual([{ refund: false }]);
	expect(calls.find((c) => c.path === '/v1/billing/cancel')!.headers['x-colander-csrf']).toBe('1');

	// Cancelled within 30 days of the charge: the same button now offers the refund, and a refusal changes nothing.
	await expect(page.getByRole('button', { name: 'Cancel Plus' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'End now and refund' })).toBeFocused();
	await page.getByRole('button', { name: 'End now and refund' }).click();
	await expect(page.getByText('Nothing was changed')).toBeVisible();
	await expect(page.getByText('more than 30 days old', { exact: false })).toBeVisible();
});

test('a reviewer code connects the side panel; an unused code ends after 10 minutes', async ({ page }) => {
	await page.clock.install();
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: STAFF } },
		'POST /v1/pair': (c) => ({ status: 201, json: { id: 'pair_rvw', code: 'RVW4-2K9P', expires_at: new Date(Date.now() + 600_000).toISOString(), kind: c.body.kind } }),
		'GET /v1/pair/*': { json: { status: 'pending', ext_version: null, browser: null } }
	});
	await page.goto('/account');
	const review = page.locator('section', { has: page.getByRole('heading', { name: 'Review', exact: true }) });
	await expect(review.getByRole('heading', { name: 'Review in the extension' })).toBeVisible();
	await review.getByRole('button', { name: 'Show a code' }).click();
	await expect(review.getByText('RVW4-2K9P')).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/pair')!.body).toEqual({ kind: 'reviewer' });
	await expect(review.getByText("In the browser you review in, open Colander's side panel, or Options and then Plan, and type this code.")).toBeVisible();
	await page.clock.runFor(10 * 60_000);
	await expect(review.getByText('This code has ended')).toBeVisible();
	await expect(review.getByRole('button', { name: 'Show a code' })).toBeVisible();
	await expect(review.getByText('Connected', { exact: false })).toHaveCount(0);
});

test('a member without a curator role, or without a plan, is not offered a code', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'POST /v1/pair': { status: 404, json: { error: { code: 'no_plan', message: 'There is no active Plus plan on this account to connect.' } } }
	});
	await page.goto('/account');
	await expect(page.getByText('Once you have Plus, connect each browser you use here with a code.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show a code' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Review', exact: true })).toHaveCount(0);
});
