import { test, expect } from './fixtures.ts';
import { ACCOUNT, mockApi } from './mocks.ts';

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
	await page.getByRole('button', { name: 'Email me a link to continue' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/auth/email')!.body).toEqual({ email: 'maya@example.com', next: '/plans?checkout=plus_yearly' });
});

test('checkout redirects to the hosted page', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'POST /v1/billing/checkout': { json: { url: 'http://localhost:4173/terms?checkout=done' } }
	});
	await page.goto('/plans?checkout=plus_yearly');
	await page.getByRole('button', { name: 'Continue to checkout' }).click();
	await expect(page).toHaveURL(/\/terms\?checkout=done$/);
});
