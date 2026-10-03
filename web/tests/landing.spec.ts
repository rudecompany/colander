import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

test('landing explains the product and the hero demo follows the strictness table', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Drain the slop. Keep the substance.');
	await expect(page.getByRole('link', { name: 'Add to Chrome, free' }).first()).toHaveAttribute('href', /chromewebstore/);
	await expect(page.getByRole('link', { name: /1,284 verdict changes published this week/ })).toHaveAttribute('href', '/log');
	await expect(page.getByText('Source: Kapwing, The TikTok AI Slop Report')).toBeVisible();
	await expect(page.getByRole('img', { name: /^295 of 500 dots filled/ })).toBeVisible();

	// The recreated feed renders the extension's own components, with the evidence card open on the grid stub.
	const frame = page.locator('.frame-desk');
	const feed = frame.locator('colander-ui');
	await expect(frame.getByRole('dialog', { name: 'Why this is hidden' })).toBeVisible();
	await expect(frame.getByText('2 hidden on this page')).toBeAttached();
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(1);

	const control = page.locator('.control');
	await control.getByRole('radio', { name: 'No AI' }).click();
	await expect(frame.getByText('4 hidden on this page')).toBeAttached();
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(0);
	// The docked popup's control follows the one under the frame.
	await expect(frame.getByRole('radio', { name: 'No AI' })).toHaveAttribute('aria-checked', 'true');

	await control.getByRole('radio', { name: 'Label' }).click();
	await expect(frame.getByText(/^\d+ hidden on this page$/)).toHaveCount(0);
	await expect(feed.getByText('Hidden for you')).toHaveCount(0);

	// Pause shows the feed without Colander: the before and after, with no slider.
	await control.getByRole('radio', { name: 'Standard' }).click();
	await frame.getByRole('button', { name: 'Pause' }).click();
	await page.getByRole('menuitem', { name: 'Pause on this site' }).click();
	await expect(frame.getByText('Paused on this site.')).toBeVisible();
	await expect(feed.getByText('Ancient Rome facts you never knew, Part 46')).toHaveCount(1);
	await expect(frame.getByText(/^\d+ hidden on this page$/)).toHaveCount(0);

	// Live decision log preview from the API.
	await expect(page.getByRole('link', { name: 'Ancient Facts Daily' }).first()).toHaveAttribute('href', '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ');
});

test('on a phone the hero sends the link to a computer and shows the popup under the feed', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Send to my computer' }).first()).toBeVisible();
	await expect(page.getByText('The popup in your toolbar')).toBeVisible();
	const feed = page.locator('.frame-phone');
	await expect(feed.getByRole('dialog', { name: 'Why this is hidden' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('the header menu traps focus, closes on Escape and returns focus to Menu', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page);
	await page.goto('/');
	const menu = page.getByRole('button', { name: 'Menu' });
	await menu.click();
	const sheet = page.getByRole('dialog', { name: 'Menu' });
	await expect(sheet.getByRole('link', { name: 'Decision log' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(menu).toBeFocused();
});
