import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

test('a monthly donation with credit goes to the hosted checkout', async ({ page, baseURL }) => {
	const calls = await mockApi(page, { 'POST /v1/billing/donate': { json: { url: `${baseURL}/support/thanks` } } });
	await page.goto('/support');
	await expect(page.getByRole('radio', { name: 'Monthly' })).toHaveAttribute('aria-checked', 'true');
	await page.getByLabel('Name for the supporters page').fill('  Ana  ');
	await page.getByRole('button', { name: 'Give $5 a month' }).click();
	await expect(page).toHaveURL(/\/support\/thanks$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you for your support');
	const donate = calls.find((c) => c.path === '/v1/billing/donate')!;
	expect(donate.body).toEqual({ amount_cents: 500, recurring: true, credit_name: 'Ana' });
	expect(donate.headers['x-colander-csrf']).toBe('1');
});

test('a custom one-time amount without credit, and the limits', async ({ page }) => {
	const calls = await mockApi(page, {
		'POST /v1/billing/donate': { status: 503, json: { error: { code: 'billing_unavailable', message: 'Payments are switched off.' } } }
	});
	await page.goto('/support');
	await page.getByRole('radio', { name: 'Once' }).click();
	await page.getByText('Other', { exact: true }).click();
	await page.getByLabel('Amount in US dollars').fill('1,500');
	await page.getByRole('button', { name: 'Continue to payment' }).click();
	await expect(page.getByText('Any amount from $1 to $1,000 works.')).toBeVisible();
	expect(calls.filter((c) => c.path === '/v1/billing/donate')).toHaveLength(0);

	await page.getByLabel('Amount in US dollars').fill('12.50');
	await page.getByRole('button', { name: 'Give $12.50' }).click();
	await expect(page.getByText('Donations are not open yet')).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/billing/donate')!.body).toEqual({ amount_cents: 1250, recurring: false });
});

test('a closed payment comes back calmly', async ({ page }) => {
	await mockApi(page);
	await page.goto('/support?cancelled=1');
	await expect(page.getByText('Payment closed before it finished')).toBeVisible();
	await expect(page.getByText('Nothing was charged.', { exact: false })).toBeVisible();
});
