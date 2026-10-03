import { test, expect } from './fixtures.ts';
import { APPEAL, mockApi } from './mocks.ts';

test('a creator starts an appeal, gets a code, verifies and sees the status', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	let appeal = { ...APPEAL };
	const calls = await mockApi(page, {
		'POST /v1/appeals': (c) => {
			appeal = { ...APPEAL, statement: c.body.statement };
			return { status: 201, json: { appeal, secret: 's3cret' } };
		},
		'GET /v1/appeals/apl_4k9x2m': (c) =>
			c.search.get('secret') === 's3cret' ? { json: { appeal } } : { status: 403, json: { error: { code: 'bad_secret', message: 'This link is not valid.' } } },
		'POST /v1/appeals/apl_4k9x2m/verify': () => {
			appeal = { ...appeal, status: 'pending_manual' };
			return { json: { appeal } };
		}
	});

	await page.goto('/appeal/tt/@historybites247');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Appeal the verdict for History Bites 24/7');
	await expect(page.locator('a[href="/support"], a[href="/supporters"]')).toHaveCount(0);

	await page.getByLabel('Email').fill('creator@example.com');
	await page.getByLabel('Your statement').fill('We write and film every video ourselves, and use AI only for captions.');
	await page.getByRole('button', { name: 'Start the appeal' }).click();

	await expect(page).toHaveURL(/\/appeal\/status\/apl_4k9x2m\?secret=s3cret$/);
	const create = calls.find((c) => c.method === 'POST' && c.path === '/v1/appeals')!;
	expect(create.body).toEqual({
		platform: 'tt',
		source_id: '@historybites247',
		email: 'creator@example.com',
		statement: 'We write and film every video ourselves, and use AI only for captions.'
	});

	await expect(page.getByRole('heading', { name: 'Waiting for the code' })).toBeVisible();
	await expect(page.getByText('colander-7KQ2M9XD')).toBeVisible();
	await page.getByRole('button', { name: 'Copy code' }).click();
	await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('colander-7KQ2M9XD');

	await page.getByRole('button', { name: 'Check my description' }).click();
	await expect(page.getByRole('heading', { name: 'Waiting for a manual check' })).toBeVisible();
	const verify = calls.find((c) => c.path === '/v1/appeals/apl_4k9x2m/verify')!;
	expect(verify.body).toEqual({ secret: 's3cret' });
	await expect(page.getByRole('button', { name: 'Check my description' })).toHaveCount(0);
	await expect(page.locator('a[href="/support"], a[href="/supporters"]')).toHaveCount(0);
});

test('the status page explains review and outcome', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/appeals/*': {
			json: { appeal: { ...APPEAL, status: 'denied', outcome: 'denied', reasoning: 'Most videos reuse one generated narration track.', verified_at: '2026-10-02T21:10:00Z', resolved_at: '2026-10-05T09:00:00Z' } }
		}
	});
	await page.goto('/appeal/status/apl_4k9x2m?secret=s3cret');
	await expect(page.getByRole('heading', { name: 'Denied' })).toBeVisible();
	await expect(page.getByText('Most videos reuse one generated narration track.')).toBeVisible();
	await expect(page.getByText('Your code')).toHaveCount(0);
});

test('a status link without its secret explains what to do', async ({ page }) => {
	await mockApi(page);
	await page.goto('/appeal/status/apl_4k9x2m');
	await expect(page.getByText('This link is incomplete')).toBeVisible();
});
