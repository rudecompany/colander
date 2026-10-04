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
	// The badge counts hidden and collapsed items, as the extension's toolbar badge does.
	await expect(frame.getByText('3 hidden on this page', { exact: true })).toBeAttached();
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(1);

	const control = page.locator('.control');
	await control.getByRole('radio', { name: 'No AI' }).click();
	await expect(frame.getByText('4 hidden on this page', { exact: true })).toBeAttached();
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

test('the open popover is drawn in its final state on load, and motion is only for changes', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const host = page.locator('.frame-desk colander-ui');
	const running = () => host.evaluate((h) => h.shadowRoot!.getAnimations().length);
	expect(await host.evaluate((h) => h.shadowRoot!.querySelector('#cl-pop-6')!.className)).toBe('cl-pop');
	expect(await running()).toBe(0);
	// A resize that hides and shows the frame does not replay anything.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.setViewportSize({ width: 1440, height: 900 });
	expect(await running()).toBe(0);
});

test('the hero Why popover takes focus, keeps it and hands it back on Escape', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');
	const frame = page.locator('.frame-desk');
	const why = frame.locator('[data-k="why-6"]');
	await expect(why).toHaveAttribute('aria-expanded', 'true');
	await expect(why).toHaveAttribute('aria-controls', 'cl-pop-6');
	const active = () =>
		page.evaluate(() => {
			let a = document.activeElement;
			while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
			return a?.getAttribute('data-k') ?? a?.textContent?.trim() ?? null;
		});

	await page.mouse.click(8, 300);
	await expect(frame.getByRole('dialog', { name: 'Why this is hidden' })).toHaveCount(0);
	await expect(why).toHaveAttribute('aria-expanded', 'false');
	await why.focus();
	await page.keyboard.press('Enter');
	await expect.poll(active).toBe('pop-show-6');
	// Tab stays inside the popover.
	for (const key of ['pop-allow-6', 'pop-notslop-6', 'pop-show-6']) {
		await page.keyboard.press('Tab');
		await expect.poll(active).toBe(key);
	}
	await page.keyboard.press('Escape');
	await expect(frame.getByRole('dialog', { name: 'Why this is hidden' })).toHaveCount(0);
	await expect.poll(active).toBe('why-6');
});

test('pausing from the popup with the keyboard moves focus to Resume, and back', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');
	const frame = page.locator('.frame-desk');
	await frame.getByRole('button', { name: 'Pause' }).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('menuitem', { name: 'Pause on this site' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(frame.getByRole('button', { name: 'Resume' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(frame.getByRole('button', { name: 'Pause' })).toBeFocused();
});

test('each platform tab recreates its own feed', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');
	const frame = page.locator('.frame-desk');
	const layout = () => frame.locator('colander-ui').evaluate((h) => h.shadowRoot!.querySelector('.feed')!.className);
	for (const [tab, cls, domain] of [
		['TikTok', 'feed-swipe', 'tiktok.com'],
		['Instagram', 'feed-square', 'instagram.com'],
		['Facebook', 'feed-post', 'facebook.com'],
		['YouTube', 'feed-grid', 'youtube.com']
	]) {
		await page.getByRole('tab', { name: tab }).click();
		await expect.poll(layout).toContain(cls);
		await expect(frame.getByText(`Active on ${domain}`)).toBeVisible();
	}
	// TikTok's For You shows one video at a time, with its action rail.
	await page.getByRole('tab', { name: 'TikTok' }).click();
	expect(await frame.locator('colander-ui').evaluate((h) => h.shadowRoot!.querySelectorAll('.reel').length)).toBe(1);
});

test('the landing page stays within its length budget', async ({ page }) => {
	await mockApi(page);
	for (const [width, cap] of [
		[1440, 8200],
		[390, 12500]
	]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		expect(await page.evaluate(() => document.documentElement.scrollHeight), `height at ${width}`).toBeLessThanOrEqual(cap);
	}
});

test('every picture of the demo feed says its thumbnails are AI-generated', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockApi(page);
	await page.goto('/');
	for (const where of ['.caption', '.after', '.bento-note']) {
		await expect(page.locator(where)).toContainText('Thumbnails are AI-generated illustrations.');
	}
});
