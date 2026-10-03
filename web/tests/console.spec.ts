import { test, expect } from './fixtures.ts';
import { CURATOR, QUEUE, STAFF, mockApi, reviewSource } from './mocks.ts';

const review = (account: typeof STAFF, extra: Parameters<typeof mockApi>[1] = {}) => ({
	'GET /v1/account': { json: { account } },
	'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
	'GET /v1/review/sources/*': (c: { path: string }) => {
		const [, , , , p, id] = c.path.split('/');
		return { json: reviewSource(`${p}:${decodeURIComponent(id)}`) };
	},
	...extra
});

test('staff move through the queue by keyboard, read the evidence and write a decision', async ({ page }) => {
	const calls = await mockApi(page, review(STAFF, { 'POST /v1/review/sources/*/decision': { json: {} } }));
	await page.goto('/console');
	await expect(page.getByRole('button', { name: /Ancient Facts Daily/ })).toBeVisible();

	await page.locator('body').click({ position: { x: 5, y: 300 } });
	await page.keyboard.press('j');
	await page.keyboard.press('j');
	await expect(page.getByRole('button', { name: /History Bites 24\/7/ })).toBeFocused();
	await page.keyboard.press('k');
	await expect(page.getByRole('button', { name: /Numis Notes/ })).toBeFocused();
	await page.keyboard.press('j');
	await page.keyboard.press('Enter');

	await expect(page.getByRole('heading', { level: 2, name: 'History Bites 24/7' })).toBeVisible();
	await expect(page.getByText('6 slop tags from 9 installs, a share of 0.67. Consensus needs 0.7.')).toBeVisible();
	await expect(page.getByText('Not met')).toBeVisible();
	await expect(page.getByRole('link', { name: /7421983300112233445/ }).first()).toHaveAttribute('href', 'https://www.tiktok.com/@historybites247/video/7421983300112233445');

	await page.locator('label.verdict-option').filter({ has: page.getByRole('radio', { name: 'Slop', exact: true }) }).click();
	await page.getByLabel('Reason').fill('Twelve near-identical AI history videos a day with one caption template.');
	await page.locator('label.uin-checkbox', { hasText: 'Posts at a volume no person could sustain' }).click();
	await page.getByLabel('Type').selectOption('filler');
	await page.getByRole('button', { name: 'Review decision' }).click();

	const dialog = page.getByRole('dialog', { name: 'Write this to the public log?' });
	await expect(dialog).toContainText('Decided by staff member Sam');
	await expect(dialog.locator('.cl-chip')).toHaveText(['Likely slop', 'Slop']);
	await dialog.getByRole('button', { name: 'Write to the log' }).click();
	await expect(page.getByText('Decision written to the public log.')).toBeVisible();

	const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/review/sources/tt/%40historybites247/decision')!;
	expect(post.headers['x-colander-csrf']).toBe('1');
	expect(post.body).toEqual({
		verdict: 'slop',
		reason: 'Twelve near-identical AI history videos a day with one caption template.',
		signals: ['platform_label', 'templated', 'near_duplicates', 'high_volume'],
		slop_type: 'filler',
		tests: ['mass_produced', 'hollow'],
		large: false
	});
});

test('curators see staff-only limits before submit, and the staff_required answer after', async ({ page }) => {
	await mockApi(
		page,
		review(CURATOR, {
			'POST /v1/review/sources/*/decision': {
				status: 403,
				json: { error: { code: 'staff_required', message: 'This source now has a large audience, so a staff member must decide it.' } }
			}
		})
	);
	await page.goto('/console');

	await page.getByRole('button', { name: /Ancient Facts Daily/ }).click();
	await expect(page.getByText('Staff decision needed')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Review decision' })).toBeDisabled();

	await page.getByRole('button', { name: /History Bites 24\/7/ }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'History Bites 24/7' })).toBeVisible();
	await expect(page.getByText('Only staff can mark a source as large.')).toBeVisible();
	await page.locator('label.verdict-option').filter({ has: page.getByRole('radio', { name: 'No verdict' }) }).click();
	await page.getByLabel('Reason').fill('Reports describe a different channel with a similar name.');
	await page.getByRole('button', { name: 'Review decision' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Write to the log' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Staff decision needed' })).toContainText('a staff member must decide it');
});

test('members are told the console is for curators and staff', async ({ page }) => {
	await mockApi(page, { 'GET /v1/account': { json: { account: { ...STAFF, role: 'member' } } } });
	await page.goto('/console');
	await expect(page.getByRole('heading', { name: 'For curators and staff' })).toBeVisible();
});
