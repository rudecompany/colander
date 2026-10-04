import { test, expect } from './fixtures.ts';
import { ACCOUNT, PLUS_ACCOUNT, mockApi } from './mocks.ts';

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

test('connect this browser sends the plan token to the extension', async ({ page }) => {
	await page.addInitScript(() => {
		const sent: unknown[] = [];
		(window as unknown as { __sent: unknown[] }).__sent = sent;
		(window as unknown as { chrome: unknown }).chrome = {
			runtime: {
				sendMessage(_id: string, message: { type: string }, reply: (r: unknown) => void) {
					sent.push(message);
					setTimeout(() => reply(message.type === 'colander:ping' ? { ok: true, version: '1.0.0' } : { ok: true }), 0);
				}
			}
		};
	});
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: PLUS_ACCOUNT } },
		'POST /v1/entitlement': { json: { token: 'plan.token' } },
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
	await expect(page.getByText('Colander 1.0.0 is installed here.')).toBeVisible();
	await page.getByRole('button', { name: 'Connect this browser' }).click();
	await expect(page.getByText('Connected. Plus features are on in this browser.')).toBeVisible();
	const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
	expect(sent).toContainEqual({ type: 'colander:plan-token', token: 'plan.token' });
	expect(calls.find((c) => c.path === '/v1/entitlement')!.headers['x-colander-csrf']).toBe('1');

	await page.getByRole('button', { name: 'Cancel Plus' }).click();
	await page.getByRole('button', { name: 'End now and refund' }).click();
	await expect(page.getByText('Plus has ended and your last charge is being refunded.')).toBeVisible();
	expect(calls.filter((c) => c.path === '/v1/billing/cancel').map((c) => c.body)).toEqual([{ refund: false }, { refund: true }]);
	await expect(page.getByText('Free.', { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Connect this browser' })).toHaveCount(0);
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

test('without the extension the account page says so plainly', async ({ page }) => {
	await page.addInitScript(() => ((window as unknown as { chrome: unknown }).chrome = {}));
	await mockApi(page, { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } });
	await page.goto('/account');
	await expect(page.getByText('Colander is not installed in this browser')).toBeVisible();
});
