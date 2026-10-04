import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

test('the strictness table fits the reading measure, and stacks by level on phones', async ({ page }) => {
	await mockApi(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/definition#strictness');
	const box = page.locator('#strictness .st');
	await expect(box.locator('table')).toBeVisible();
	expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth), 'sideways overflow at 1440').toBeLessThanOrEqual(0);
	await expect(box.locator('tbody tr').last().locator('td').last()).toHaveText('Shown');

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(box.locator('table')).toBeHidden();
	await expect(box.getByRole('list', { name: 'What each strictness level does' }).getByRole('listitem')).toHaveCount(3);
	expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth), 'sideways overflow at 390').toBeLessThanOrEqual(0);
});

test('figures are numbered in reading order, each with the drawing its caption names', async ({ page }) => {
	await mockApi(page);
	await page.goto('/definition');
	const figures = page.locator('figure');
	await expect(figures.locator('figcaption')).toHaveText([
		'Fig. 1 Two layers must agree.',
		'Fig. 2 AI evidence is a gate.',
		'Fig. 3 Tags alone never make anything Slop.',
		'Fig. 4 The signed list, your device, your feed.'
	]);
	await expect(figures.nth(0).getByRole('img')).toHaveAttribute('aria-label', /^Four rings for the four evidence layers/);
	await expect(figures.nth(1).getByRole('img')).toHaveAttribute('aria-label', /^Items with AI evidence pass through the rim/);
});
