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
