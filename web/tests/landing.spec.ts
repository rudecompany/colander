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

	// The recreated feed renders the extension's own components, with the evidence card open on the AI-made item.
	const frame = page.locator('.frame-desk');
	const feed = frame.locator('colander-ui');
	await expect(frame.getByRole('dialog', { name: 'Why this is labeled' })).toBeVisible();
	// Hidden items leave no trace in the feed, and the badge still counts them, as the extension's toolbar badge does.
	await expect(frame.getByText('3 hidden on this page', { exact: true })).toBeAttached();
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(1);
	await expect(feed.getByText('Ancient Rome facts you never knew, Part 46')).toHaveCount(0);
	await expect(feed.locator('.card')).toHaveCount(6);
	// The docked popup lists every hidden item with Show; Show brings it back, labeled.
	const docked = frame.locator('.docked');
	await docked.getByRole('button', { name: 'Show all 5' }).click();
	await docked.getByRole('listitem').filter({ hasText: 'Part 46' }).getByRole('button', { name: 'Show' }).click();
	await expect(feed.getByText('Ancient Rome facts you never knew, Part 46')).toHaveCount(1);
	await expect(feed.locator('[data-k="why-2"]')).toBeAttached();

	const control = page.locator('.control');
	await control.getByRole('radio', { name: 'No AI' }).click();
	await expect(frame.getByText('4 hidden on this page', { exact: true })).toBeAttached();
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(0);
	// The docked popup's control follows the one under the frame.
	await expect(frame.getByRole('radio', { name: 'No AI' })).toHaveAttribute('aria-checked', 'true');

	await control.getByRole('radio', { name: 'Label' }).click();
	await expect(frame.getByText(/^\d+ hidden on this page$/)).toHaveCount(0);
	await expect(feed.locator('.card')).toHaveCount(9);

	// Pause shows the feed without Colander: the before and after, with no slider.
	await control.getByRole('radio', { name: 'Standard' }).click();
	await frame.getByRole('button', { name: 'Pause' }).click();
	await page.getByRole('menuitem', { name: 'Pause on this site' }).click();
	await expect(frame.locator('.docked').getByText('Paused on this site.')).toBeVisible();
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
	const feed = page.locator('.frame-phone');
	await expect(feed.getByText('The popup in your toolbar')).toBeVisible();
	await expect(feed.getByRole('dialog', { name: 'Why this is labeled' })).toBeVisible();
	// The popup under the phone feed lists that feed: its one hidden item, with Show, which brings it back.
	const popup = feed.locator('.popup');
	await expect(popup.locator('.cell').filter({ hasText: 'Hidden on this page' }).locator('.value')).toHaveText('1');
	await popup.getByRole('button', { name: 'Show' }).click();
	await expect(feed.locator('colander-ui').getByText('10 sleep habits, explained in 60 seconds')).toHaveCount(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('between phone and desktop, the popup under the frame lists the frame it sits under', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 900 });
	await mockApi(page);
	await page.goto('/');
	const desk = page.locator('.frame-desk');
	await expect(desk.locator('.docked')).toBeHidden();
	const popup = desk.locator('.popup-phone .popup');
	await expect(popup).toBeVisible();
	await expect(desk.getByText('3 hidden on this page', { exact: true })).toBeAttached();
	await expect(popup.locator('.cell').filter({ hasText: 'Hidden on this page' }).locator('.value')).toHaveText('3');
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
	expect(await host.evaluate((h) => h.shadowRoot!.querySelector('#cl-pop-3')!.className)).toBe('cl-pop');
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
	const why = frame.locator('[data-k="why-3"]');
	await expect(why).toHaveAttribute('aria-expanded', 'true');
	await expect(why).toHaveAttribute('aria-controls', 'cl-pop-3');
	const active = () =>
		page.evaluate(() => {
			let a = document.activeElement;
			while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
			return a?.getAttribute('data-k') ?? a?.textContent?.trim() ?? null;
		});

	await page.mouse.click(8, 300);
	await expect(frame.getByRole('dialog', { name: 'Why this is labeled' })).toHaveCount(0);
	await expect(why).toHaveAttribute('aria-expanded', 'false');
	await why.focus();
	await page.keyboard.press('Enter');
	await expect.poll(active).toBe('pop-allow-3');
	// Tab stays inside the popover.
	for (const key of ['pop-notslop-3', 'pop-allow-3']) {
		await page.keyboard.press('Tab');
		await expect.poll(active).toBe(key);
	}
	await page.keyboard.press('Escape');
	await expect(frame.getByRole('dialog', { name: 'Why this is labeled' })).toHaveCount(0);
	await expect.poll(active).toBe('why-3');
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
		await expect(frame.locator('.docked').getByText(`Active on ${domain}`)).toBeVisible();
	}
	// TikTok's For You shows one video at a time, with its action rail, and skips hidden ones: at
	// Standard it opens on the AI-made video, at Label on the Likely slop one it skipped.
	await page.getByRole('tab', { name: 'TikTok' }).click();
	const feed = frame.locator('colander-ui');
	expect(await feed.evaluate((h) => h.shadowRoot!.querySelectorAll('.reel').length)).toBe(1);
	await expect(feed.getByText('Tide pools at low tide, a field guide')).toHaveCount(1);
	await page.locator('.control').getByRole('radio', { name: 'Label' }).click();
	await expect(feed.getByText('10 sleep habits, explained in 60 seconds')).toHaveCount(1);
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

test('popup rows, strictness cards, step rules and decision rows fit at every width, in both themes', async ({ page }) => {
	await mockApi(page);
	for (const [width, scheme] of [[1440, 'dark'], [1280, 'light'], [1024, 'dark'], [768, 'light'], [390, 'dark'], [320, 'light']] as const) {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: scheme });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const problems = await page.evaluate(() => {
			const out: string[] = [];
			const inside = (r: DOMRect, c: DOMRect) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
			// (a) Every popup row title is one line that ends in an ellipsis, with its chip and Show inside the row.
			for (const row of document.querySelectorAll<HTMLElement>('.popup .row')) {
				if (!row.offsetParent) continue;
				const t = row.querySelector<HTMLElement>('.title')!;
				if (t.getBoundingClientRect().height > 20.5 || getComputedStyle(t).whiteSpace !== 'nowrap') out.push(`popup title wraps: ${t.textContent}`);
				for (const el of row.querySelectorAll('.cl-chip, .uin-btn, .more')) if (!inside(el.getBoundingClientRect(), row.getBoundingClientRect())) out.push(`popup row part outside its row: ${t.textContent}`);
			}
			// (b) Nothing in a strictness card's rows is cut: every element of the recreated rows sits inside the card.
			for (const level of document.querySelectorAll<HTMLElement>('.level')) {
				const host = level.querySelector('colander-ui');
				if (!host || !level.offsetParent || !host.getClientRects().length) continue;
				const c = host.getBoundingClientRect();
				for (const el of host.shadowRoot!.querySelectorAll('.card, .cl-chip, .title')) {
					const r = el.getBoundingClientRect();
					if (r.width && !inside(r, c)) out.push(`strictness card row cut: ${el.textContent?.slice(0, 20)}`);
				}
			}
			// (c) Each step rule stays inside its own tile.
			for (const tile of document.querySelectorAll<HTMLElement>('.bento .tile')) {
				const after = getComputedStyle(tile, '::after');
				if (after.content === 'none' || after.display === 'none') continue;
				if (parseFloat(after.right) < 0) out.push(`step rule leaves tile ${tile.querySelector('.step')?.textContent}`);
			}
			// Each tile's picture shows whole, apart from 03's popover, which fades out by design.
			for (const vis of document.querySelectorAll<HTMLElement>('.bento .tile > .vis:not(.vis-top)')) {
				const pic = vis.querySelector('.vis-in')!;
				if (!inside(pic.getBoundingClientRect(), vis.getBoundingClientRect())) out.push(`tile picture cut: ${vis.getAttribute('aria-label')?.slice(0, 30)}`);
			}
			// (d) Latest decisions show whole source names.
			for (const src of document.querySelectorAll<HTMLElement>('.band-right .src')) {
				if (src.scrollWidth > src.clientWidth + 0.5) out.push(`source name cut: ${src.textContent}`);
			}
			return out;
		});
		expect(problems, `${width} ${scheme}`).toEqual([]);
	}
});

test('the comparison keeps its table and checked date, with no sources link', async ({ page }) => {
	await mockApi(page);
	await page.goto('/');
	const compare = page.locator('section', { has: page.getByRole('heading', { name: /Built to hide slop/ }) });
	await expect(compare.getByRole('table')).toBeVisible();
	await expect(compare.getByText(/^Based on AI content blockers on the Chrome Web Store and Firefox Add-ons, checked \d+ \w+ \d{4}\.$/)).toBeVisible();
	await expect(compare.getByRole('link', { name: 'Sources' })).toHaveCount(0);
	await page.goto('/definition');
	await expect(page.getByRole('link', { name: 'Comparison sources' })).toHaveCount(0);
	await expect(page.locator('#comparison')).toHaveCount(0);
});
