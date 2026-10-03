// Journey 9: without Stripe keys, Get Plus explains calmly that checkout is not open, after a
// real sign-in, and no page breaks along the way.
import { ORIGIN, logMark, signInLink } from './stack.ts';
import { expect, test } from './harness.ts';

test('Get Plus without Stripe shows the billing-unavailable message, and nothing crashes', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => /Content Security Policy/i.test(m.text()) && errors.push(m.text()));
	const email = 'new.reader@example.test';

	await page.goto(`${ORIGIN}/plans`);
	await page.getByRole('button', { name: 'Get Plus, $30 a year' }).click();
	await page.getByLabel('Email').fill(email);
	const mark = logMark();
	await page.getByRole('button', { name: 'Email me a link to continue' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	await page.goto(await signInLink(email, mark));
	await expect(page).toHaveURL(`${ORIGIN}/plans?checkout=plus_yearly`);

	const checkout = page.waitForResponse((r) => r.url() === `${ORIGIN}/v1/billing/checkout`);
	await page.getByRole('button', { name: 'Continue to checkout' }).click();
	const res = await checkout;
	expect(res.status()).toBe(503);
	expect((await res.json()).error.code).toBe('billing_unavailable');
	const notice = page.getByRole('status').filter({ hasText: 'Checkout is not open yet' });
	await expect(notice).toContainText('nothing was charged');
	await expect(page).toHaveURL(`${ORIGIN}/plans?checkout=plus_yearly`);
	await expect(page.getByRole('button', { name: 'Get Plus, $30 a year' })).toBeEnabled();
	await notice.scrollIntoViewIfNeeded();
	await page.screenshot({ path: 'screenshots/plans-billing-unavailable.png' });
	// No script error and no Content Security Policy violation under the real server's headers.
	expect(errors).toEqual([]);
});
