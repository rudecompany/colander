import { test, expect, layoutSpills } from './fixtures.ts';
import { ACCOUNT, PLUS_ACCOUNT, mockApi } from './mocks.ts';

test('yearly is preselected and checkout handles billing being unavailable', async ({ page }) => {
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'POST /v1/billing/checkout': { status: 503, json: { error: { code: 'billing_unavailable', message: 'Billing is not configured.' } } }
	});
	await page.goto('/plans');
	await expect(page.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('button', { name: 'Get Plus, $30 a year' }).click();
	await expect(page.getByText('Checkout is not open yet')).toBeVisible();
	const checkout = calls.find((c) => c.path === '/v1/billing/checkout')!;
	expect(checkout.body).toEqual({ price: 'plus_yearly' });
	expect(checkout.headers['x-colander-csrf']).toBe('1');

	await page.getByRole('radio', { name: 'Monthly' }).click();
	await page.getByRole('button', { name: 'Get Plus, $3 a month' }).click();
	expect(calls.filter((c) => c.path === '/v1/billing/checkout').at(-1)!.body).toEqual({ price: 'plus_monthly' });
});

test('signed out, Get Plus asks for a sign-in that returns to checkout', async ({ page }) => {
	const calls = await mockApi(page, { 'POST /v1/auth/email': { status: 202 } });
	await page.goto('/plans');
	await page.getByRole('button', { name: 'Get Plus, $30 a year' }).click();
	await page.getByLabel('Email').fill('maya@example.com');
	// The sign-in form sits in a narrow card in the four-column layout and must stay inside it.
	for (const width of [1280, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await layoutSpills(page), `layout spills at ${width}px`).toEqual([]);
	}
	await page.getByRole('button', { name: 'Email me a link' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	expect(await layoutSpills(page), 'layout spills after sending').toEqual([]);
	expect(calls.find((c) => c.path === '/v1/auth/email')!.body).toEqual({ email: 'maya@example.com', next: '/plans?checkout=plus_yearly' });
});

test('checkout redirects to the hosted page', async ({ page, baseURL }) => {
	await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'POST /v1/billing/checkout': { json: { url: `${baseURL}/terms?checkout=done` } }
	});
	await page.goto('/plans?checkout=plus_yearly');
	await page.getByRole('button', { name: 'Continue to checkout' }).click();
	await expect(page).toHaveURL(/\/terms\?checkout=done$/);
});

test('a cancelled checkout comes back calmly and can continue', async ({ page, baseURL }) => {
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'POST /v1/billing/checkout': { json: { url: `${baseURL}/terms?checkout=again` } }
	});
	await page.goto('/plans?checkout=plus_monthly&cancelled=1');
	await expect(page.getByText('Checkout closed before payment')).toBeVisible();
	await expect(page.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');
	await page.getByRole('button', { name: 'Continue to checkout' }).click();
	await expect(page).toHaveURL(/\/terms\?checkout=again$/);
	expect(calls.find((c) => c.path === '/v1/billing/checkout')!.body).toEqual({ price: 'plus_monthly' });
});

test('an account that already has Plus is sent to manage it', async ({ page }) => {
	let subscribed = false;
	await mockApi(page, {
		'GET /v1/account': () => ({ json: { account: subscribed ? PLUS_ACCOUNT : ACCOUNT } }),
		'POST /v1/billing/checkout': () => {
			subscribed = true;
			return { status: 409, json: { error: { code: 'already_subscribed', message: 'This account already has Plus.' } } };
		}
	});
	await page.goto('/plans');
	await page.getByRole('button', { name: 'Get Plus, $30 a year' }).click();
	await expect(page.getByText('You have Plus.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Manage it on your account page' })).toHaveAttribute('href', '/account');
});

test('after checkout the welcome page waits for the plan, then connects the browser', async ({ page }) => {
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
	let polls = 0;
	await mockApi(page, {
		// The webhook lands after the first check.
		'GET /v1/account': () => ({ json: { account: ++polls > 1 ? PLUS_ACCOUNT : ACCOUNT } }),
		'POST /v1/entitlement': { json: { token: 'paid.token' } }
	});
	await page.goto('/plans/welcome');
	await expect(page.getByText('Confirming your payment')).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you, Plus is on');
	await expect(page.getByText('Renews on 12 September 2027.', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Connect this browser' }).click();
	await expect(page.getByText('Connected. Plus features are on in this browser.')).toBeVisible();
	const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
	expect(sent).toContainEqual({ type: 'colander:plan-token', token: 'paid.token' });
});

test('the welcome page asks a signed-out buyer to sign in', async ({ page }) => {
	await mockApi(page);
	await page.goto('/plans/welcome');
	await expect(page.getByText('Sign in to finish')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
});
