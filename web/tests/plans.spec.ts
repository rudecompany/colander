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
		// The sign-in card takes a row of its own under Plus: the Free card keeps the Plus card's height.
		const [free, plus] = await page.locator('.prices article.price').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
		expect(free, `Free card height at ${width}px`).toBe(plus);
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

test('after checkout the welcome page waits for the plan, then shows a code to connect a browser', async ({ page }) => {
	let polls = 0;
	const calls = await mockApi(page, {
		// The webhook lands after the first check.
		'GET /v1/account': () => ({ json: { account: ++polls > 1 ? PLUS_ACCOUNT : ACCOUNT } }),
		'POST /v1/pair': { status: 201, json: { id: 'pair_new', code: 'KXQ4-JP7M', expires_at: new Date(Date.now() + 600_000).toISOString() } },
		'GET /v1/pair/*': { json: { status: 'claimed', ext_version: '1.0.0', browser: 'chrome' } }
	});
	await page.goto('/plans/welcome');
	await expect(page.getByText('Confirming your payment')).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you, Plus is on');
	await expect(page.getByText('Renews on 12 September 2027.', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Show a code' }).click();
	await expect(page.getByText('KXQ4-JP7M')).toBeVisible();
	await expect(page.getByText('Connected Colander 1.0.0 in Chrome.')).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/pair')!.body).toEqual({ kind: 'plan' });
});

test('the welcome page asks a signed-out buyer to sign in', async ({ page }) => {
	await mockApi(page);
	await page.goto('/plans/welcome');
	await expect(page.getByText('Sign in to finish')).toBeVisible();
	// Full width in its card, as on /account and /console.
	const button = page.getByRole('button', { name: 'Email me a sign-in link' });
	await expect(button).toBeVisible();
	const width = await page.locator('form.signin').evaluate((f) => f.getBoundingClientRect().width);
	expect((await button.boundingBox())!.width).toBe(width);
});
