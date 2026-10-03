import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

test('the decision log filters by platform and verdict and loads more', async ({ page }) => {
	const calls = await mockApi(page);
	await page.goto('/log');
	const entries = page.locator('ol.entries > li');
	await expect(entries).toHaveCount(8);

	await page.getByLabel('Platform').selectOption('yt');
	await expect(entries).toHaveCount(4);
	await expect(page).toHaveURL(/\/log\?platform=yt$/);
	await page.getByLabel('Verdict').selectOption('slop');
	await expect(entries).toHaveCount(2);
	await expect(page).toHaveURL(/\/log\?platform=yt&verdict=slop$/);
	const last = calls.filter((c) => c.path === '/v1/log').at(-1)!;
	expect(last.search.get('platform')).toBe('yt');
	expect(last.search.get('verdict')).toBe('slop');

	// Each entry is one row that opens to the signals behind the change.
	const first = entries.first();
	await expect(first.locator('summary')).toContainText('Ancient Facts Daily');
	await expect(first.locator('summary .cl-chip')).toHaveText(['Likely slop', 'Slop']);
	await expect(first).toContainText('Decided by staff member Sam');
	await first.locator('summary').click();
	await expect(first.getByText('Confirmed by staff review.')).toBeVisible();
	await expect(first.getByRole('link', { name: 'Source page' })).toHaveAttribute('href', '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ');

	await page.getByLabel('Platform').selectOption('');
	await page.getByLabel('Verdict').selectOption('');
	await expect(entries).toHaveCount(8);
	await page.getByRole('button', { name: 'Load more' }).click();
	await expect(entries).toHaveCount(10);
	expect(calls.filter((c) => c.path === '/v1/log').at(-1)!.search.get('cursor')).toBe('c_page2');
	await expect(page.getByText('That is the whole log for these filters.')).toBeVisible();
});

test('filters in the address are applied on load', async ({ page }) => {
	await mockApi(page);
	await page.goto('/log?platform=fb');
	await expect(page.getByLabel('Platform')).toHaveValue('fb');
	await expect(page.locator('ol.entries > li')).toHaveCount(1);
});

test('appeal entries name the reviewer who decided them', async ({ page }) => {
	await mockApi(page);
	await page.goto('/log');
	const entry = (name: string) => page.locator('ol.entries > li').filter({ hasText: name });
	// Verifying an appeal moves the source to Disputed on its own; a decided appeal names its reviewer.
	await expect(entry('Numis Notes').locator('.actor')).toHaveText('Changed by a verified appeal');
	await expect(entry('Coastal Science Club').locator('.actor')).toHaveText('Appeal decided by Ines');
});
