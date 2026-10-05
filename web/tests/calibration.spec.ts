// The calibration set is labeled blind: the page shows only the platform and ID of the next source,
// with a link to it, and posts the label (seed design section 8).
import { test, expect } from './fixtures.ts';
import { CALIBRATION_ITEM, CURATOR, STAFF, mockApi } from './mocks.ts';

test('a curator labels the next source blind, and the page moves on', async ({ page }) => {
	const next = { platform: 'tt', source_id: '@quietloops', labels: 0 };
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: CURATOR } },
		'GET /v1/review/calibration/next': { json: { item: CALIBRATION_ITEM } },
		'POST /v1/review/calibration/*/label': { json: { item: next } }
	});
	await page.goto('/console/calibration');
	await expect(page.getByRole('heading', { level: 1, name: 'Calibration' })).toBeVisible();
	await expect(page.locator('main').getByRole('heading', { level: 2 })).toContainText('UCq8Lw3xN2bKp7Tz5vR1mYsA');
	await expect(page.getByRole('link', { name: 'Open on YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/channel/UCq8Lw3xN2bKp7Tz5vR1mYsA');
	// Nothing that could sway the label: no verdict, tags or lists.
	await expect(page.locator('main')).not.toContainText(/Likely slop|tagged|seed list/i);

	await page.getByRole('button', { name: 'Save and show the next' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose what you saw first.');
	await page.getByText('Slop', { exact: true }).click();
	await page.getByText('Hollow', { exact: true }).click();
	await page.getByText('The platform labels it AI-generated').click();
	await page.getByLabel('Note, if it helps').fill('Same voice over stock footage in every video');
	await page.getByRole('button', { name: 'Save and show the next' }).click();
	await expect(page.locator('main').getByRole('heading', { level: 2 })).toContainText('@quietloops');
	await expect(page.getByText('1 saved this visit')).toBeVisible();
	const post = calls.find((c) => c.method === 'POST')!;
	expect(post.path).toBe('/v1/review/calibration/yt/UCq8Lw3xN2bKp7Tz5vR1mYsA/label');
	expect(post.body).toEqual({ label: 'slop', tests: ['hollow'], evidence: ['platform_label'], note: 'Same voice over stock footage in every video' });
});

test('an empty set says so, and the console links to it', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/account': { json: { account: STAFF } },
		'GET /v1/review/calibration/next': { json: { item: null } },
		'GET /v1/review/queue': { json: { items: [], next_cursor: null } }
	});
	await page.goto('/console');
	await page.getByRole('link', { name: 'Calibration set' }).click();
	await expect(page.getByText('Nothing to label right now.')).toBeVisible();
});
