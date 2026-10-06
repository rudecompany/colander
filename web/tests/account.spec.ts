import { test, expect } from './fixtures.ts';
import { ACCOUNT, PLUS_ACCOUNT, mockApi } from './mocks.ts';

test('sign in by emailed code, then the account page shows the account', async ({ page }) => {
	let signedIn = false;
	const calls = await mockApi(page, {
		'POST /v1/auth/code': { status: 202 },
		'POST /v1/auth/code/verify': (c) => {
			if (c.body.code !== '123456') return { status: 400, json: { error: { code: 'code_invalid', message: 'That code is not right. Check the latest email from Colander and try again.' } } };
			signedIn = true;
			return { json: { account: ACCOUNT } };
		},
		'GET /v1/account': () => (signedIn ? { json: { account: ACCOUNT } } : { status: 401, json: { error: { code: 'signed_out', message: 'Sign in.' } } })
	});

	await page.goto('/account');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username webauthn');
	await page.getByLabel('Email').fill('maya@example.com');
	await page.getByRole('button', { name: 'Email me a code' }).click();
	await expect(page.getByText('We emailed a 6-digit code to maya@example.com.', { exact: false })).toBeVisible();
	// Focus follows the form: to the code field once sent, back to the email for another address.
	const code = page.getByLabel('Code');
	await expect(code).toBeFocused();
	await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
	await expect(code).toHaveAttribute('inputmode', 'numeric');
	await page.getByRole('button', { name: 'Use a different address' }).click();
	await expect(page.getByLabel('Email')).toBeFocused();
	await page.getByRole('button', { name: 'Email me a code' }).click();
	const send = calls.find((c) => c.path === '/v1/auth/code')!;
	expect(send.body).toEqual({ email: 'maya@example.com', next: '/account' });
	expect(send.headers['x-colander-csrf']).toBe('1');

	await code.fill('654321');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toContainText('That code is not right.');
	await code.fill('123 456');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello, Maya');
	await expect(page.getByText('Signed in as maya@example.com')).toBeVisible();
	await expect(page.getByText('Free.', { exact: false })).toBeVisible();
	const verify = calls.filter((c) => c.path === '/v1/auth/code/verify');
	expect(verify.map((c) => c.body)).toEqual([{ code: '654321' }, { code: '123456' }]);
	expect(verify[0]!.headers['x-colander-csrf']).toBe('1');
});

test('a sign-in form asks the server for nothing until the person starts on it', async ({ page }) => {
	const calls = await mockApi(page);
	await page.goto('/account');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	await page.waitForLoadState('networkidle');
	// No passkey challenge yet, so no cookie and nothing counted against the network's hourly passkey budget.
	expect(calls.filter((c) => c.path.startsWith('/v1/auth/'))).toEqual([]);
	await page.getByLabel('Email').focus();
	if (await page.evaluate(async () => !!(await PublicKeyCredential.isConditionalMediationAvailable?.()))) {
		await expect.poll(() => calls.filter((c) => c.path === '/v1/auth/passkey/options').length).toBe(1);
	}
});

test('a used-up code offers a new one', async ({ page }) => {
	let sent = 0;
	await mockApi(page, {
		'POST /v1/auth/code': () => (sent++, { status: 202 }),
		'POST /v1/auth/code/verify': { status: 400, json: { error: { code: 'code_expired', message: 'This code has expired or was used up. Ask for a new one.' } } }
	});
	await page.goto('/account');
	await page.getByLabel('Email').fill('maya@example.com');
	await page.getByRole('button', { name: 'Email me a code' }).click();
	await page.getByLabel('Code').fill('123456');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toHaveText('This code no longer works. Send a new one and use the newest email.');
	await page.getByRole('button', { name: 'Send a new code' }).click();
	await expect(page.getByText('We sent a new code to maya@example.com.', { exact: false })).toBeVisible();
	expect(sent).toBe(2);
});

test('an old sign-in link explains the change and never redirects off-site', async ({ page }) => {
	await mockApi(page, { 'POST /v1/auth/verify': { status: 400, json: { error: { code: 'link_invalid', message: 'Expired.' } } } });
	await page.goto('/auth/callback?token=old&next=//evil.example');
	await expect(page.getByText('Colander now signs you in with a 6-digit code instead.', { exact: false })).toBeVisible();
	await expect(page).toHaveURL(/\/auth\/callback/);
	await expect(page.getByRole('link', { name: 'Sign in with a code' })).toHaveAttribute('href', '/account');
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

test('a token the extension refuses is an error, never Connected', async ({ page }) => {
	await page.addInitScript(() => {
		(window as unknown as { chrome: unknown }).chrome = {
			runtime: {
				sendMessage(_id: string, message: { type: string }, reply: (r: unknown) => void) {
					setTimeout(() => reply(message.type === 'colander:ping' ? { ok: true, version: '1.0.0' } : { ok: false, error: 'invalid_token' }), 0);
				}
			}
		};
	});
	await mockApi(page, {
		'GET /v1/account': { json: { account: { ...PLUS_ACCOUNT, role: 'staff' } } },
		'POST /v1/entitlement': { json: { token: 'plan.token' } },
		'POST /v1/account/reviewer-token': { json: { token: 'reviewer.token' } }
	});
	await page.goto('/account');
	await page.getByRole('button', { name: 'Connect this browser' }).click();
	await expect(page.getByText('Colander could not verify this plan. Update Colander, then try again.')).toBeVisible();
	await page.getByRole('button', { name: 'Connect side panel' }).click();
	await expect(page.getByText('Colander could not accept the reviewer token. Update Colander, then try again.')).toBeVisible();
	await expect(page.getByText('Connected.', { exact: false })).toHaveCount(0);
});

test('without the extension the account page says so plainly', async ({ page }) => {
	await page.addInitScript(() => ((window as unknown as { chrome: unknown }).chrome = {}));
	await mockApi(page, { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } });
	await page.goto('/account');
	await expect(page.getByText('Colander is not installed in this browser')).toBeVisible();
});
