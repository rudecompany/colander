import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

test('landing explains the product and the demo follows the strictness table', async ({ page }) => {
	await mockApi(page);
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Drain the slop. Keep the substance.');
	await expect(page.getByRole('link', { name: 'Add to Chrome, free' }).first()).toHaveAttribute('href', /chromewebstore/);
	await expect(page.getByText('Source: Kapwing, The TikTok AI Slop Report')).toBeVisible();

	const demo = page.getByRole('group', { name: /Example results list/ });
	await expect(demo.getByText('1 item hidden for you')).toBeVisible();
	await page.getByRole('radio', { name: 'No AI' }).click();
	await expect(demo.getByText('3 items hidden for you')).toBeVisible();
	await expect(demo.getByText('Watercolor coastline, painted with an AI brush')).toHaveCount(0);
	await page.getByRole('radio', { name: 'Label' }).click();
	await expect(demo.getByText('hidden for you')).toHaveCount(0);

	// Live decision log preview from the API.
	await expect(page.getByRole('link', { name: 'Ancient Facts Daily' }).first()).toHaveAttribute('href', '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ');
});
