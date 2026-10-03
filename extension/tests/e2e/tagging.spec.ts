// Tagging in two clicks (P0-5), what a tag contains, the offline queue, and keyboard-only use.
import type { Page } from '@playwright/test';
import { expect, test } from './harness';

const SEARCH = 'https://www.youtube.com/results?search_query=history';
const ALLOWED = ['client_id', 'platform', 'target_type', 'target_id', 'source_id', 'verdict', 'slop_type', 'tests', 'platform_label', 'created_at', 'ext_version'];

async function openTag(page: Page, card: number) {
	const c = page.locator('ytd-search ytd-video-renderer').nth(card);
	await c.hover();
	await c.locator('colander-ui[data-kind="tag"] button').click();
	return c;
}

test('tag Slop in two clicks: applies at once and sends only the allowed fields', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const card = await openTag(page, 3);
	const menu = page.locator('colander-ui[data-kind="layer"] .pop');
	await expect(menu.getByRole('heading', { name: 'Tag this video' })).toBeVisible();
	await menu.getByRole('button', { name: /^Slop/ }).click();
	await expect(card).toHaveAttribute('data-colander', 'hide');
	await expect(menu).toContainText('Tagged. Hidden for you now, and counted toward the shared list.');

	await expect.poll(() => ext.api.posted('/v1/tags').length).toBe(1);
	const [sent] = ext.api.posted('/v1/tags');
	expect(sent!.auth).toMatch(/^Install [A-Za-z0-9_-]{22}$/);
	const tag = (sent!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(Object.keys(tag).every((k) => ALLOWED.includes(k))).toBe(true);
	// The channel ID is preferred over the handle: it never changes.
	expect(tag).toMatchObject({ platform: 'yt', target_type: 'item', source_id: 'UC9MAhZQQd9egwWCxrwSIsJQ', verdict: 'slop', platform_label: false, ext_version: '1.0.0' });
	expect(tag.target_id).toMatch(/^[\w-]{11}$/);
	expect(tag.client_id).toMatch(/^[0-9a-f-]{36}$/);
	expect(tag.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	expect(JSON.stringify(sent)).not.toMatch(/youtube\.com|results|search_query|history documentary/);

	// Optional detail replaces the tag with a type and tests.
	await menu.getByRole('button', { name: 'Filler' }).click();
	await menu.getByLabel(/Low effort/).check();
	await expect.poll(() => ext.api.posted('/v1/tags').length).toBe(3);
	const last = (ext.api.posted('/v1/tags').at(-1)!.body as { tags: Record<string, unknown>[] }).tags[0]!;
	expect(last).toMatchObject({ verdict: 'slop', slop_type: 'filler', tests: ['low_effort'], target_id: tag.target_id });
	await menu.getByRole('button', { name: 'Done' }).click();
	await expect(menu).toHaveCount(0);
});

test('Not slop and AI-made but fine confirm with a notice', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	await openTag(page, 3);
	await page.locator('colander-ui[data-kind="layer"] .pop').getByRole('button', { name: /^AI-made but fine/ }).click();
	const notice = page.locator('colander-ui[data-kind="layer"] .toast');
	await expect(notice).toHaveText('Tagged as AI-made but fine. Counted toward the shared list.');
	await expect(notice).toHaveAttribute('aria-live', 'polite');
	await expect(page.locator('ytd-search ytd-video-renderer').nth(3).locator('colander-ui[data-kind="chip"]')).toContainText('AI-made');
	await expect(notice).toHaveCount(0, { timeout: 6000 });
});

test('tags queue while offline and are sent when the connection returns', async ({ ext }) => {
	await ext.setup();
	ext.api.offline = true;
	const page = await ext.open(SEARCH);
	const card = await openTag(page, 5);
	await page.locator('colander-ui[data-kind="layer"] .pop').getByRole('button', { name: /^Slop/ }).click();
	// The tag applies on the device at once.
	await expect(card).toHaveAttribute('data-colander', 'hide');
	const queued = () =>
		ext.ctl.evaluate(
			() =>
				new Promise<{ attempts: number; nextAt: number }[]>((resolve) => {
					const req = indexedDB.open('colander');
					req.onsuccess = () => {
						const all = req.result.transaction('tags').objectStore('tags').getAll();
						all.onsuccess = () => resolve(all.result);
					};
				})
		);
	await expect.poll(async () => (await queued())[0]?.attempts).toBe(1);
	const [q] = await queued();
	expect(q!.nextAt).toBeGreaterThan(Date.now() + 25_000);
	const alarm = await ext.ctl.evaluate(() => chrome.alarms.get('tags'));
	expect(alarm?.scheduledTime).toBeGreaterThan(Date.now());

	// Back online; pretend the retry alarm fired by making the tag due now.
	ext.api.offline = false;
	await ext.ctl.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const req = indexedDB.open('colander');
				req.onsuccess = () => {
					const store = req.result.transaction('tags', 'readwrite').objectStore('tags');
					const all = store.getAll();
					all.onsuccess = () => {
						for (const t of all.result) store.put({ ...t, nextAt: Date.now() - 1 });
						store.transaction.oncomplete = () => resolve();
					};
				};
			})
	);
	await ext.send({ type: 'sync-now' });
	await expect.poll(async () => (await queued()).length).toBe(0);
	expect(ext.api.sent.filter((s) => s.path === '/v1/tags' && s.method === 'POST').length).toBeGreaterThanOrEqual(2);
});

test('keyboard only: tag menu and collapsed bar', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SEARCH);
	const isTagFocused = () => page.evaluate(() => {
		const a = document.activeElement;
		return a?.tagName === 'COLANDER-UI' && a.getAttribute('data-kind') === 'tag' && a.shadowRoot?.activeElement?.tagName === 'BUTTON';
	});
	// From the card's title link, Tab reaches its Tag button.
	await page.locator('ytd-search ytd-video-renderer').nth(3).locator('a#video-title').focus();
	for (let i = 0; i < 12 && !(await isTagFocused()); i++) await page.keyboard.press('Tab');
	expect(await isTagFocused()).toBe(true);
	const tagHost = page.locator('ytd-search ytd-video-renderer').nth(3).locator('colander-ui[data-kind="tag"]');
	await expect(tagHost).toHaveCSS('opacity', '1');

	await page.keyboard.press('Enter');
	const menu = page.locator('colander-ui[data-kind="layer"] .pop');
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('button', { name: 'Close' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(menu.getByRole('button', { name: /^Slop/ })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	expect(await isTagFocused()).toBe(true);

	await page.keyboard.press('Enter');
	await page.keyboard.press('Tab');
	await page.keyboard.press('Enter');
	await expect(page.locator('ytd-search ytd-video-renderer').nth(3)).toHaveAttribute('data-colander', 'hide');
	await expect(menu.getByRole('button', { name: 'Filler' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);

	// The collapsed bar takes focus and Enter shows the item.
	const bar = page.locator('ytd-search ytd-video-renderer').nth(1).locator('colander-ui[data-kind="bar"] .bar');
	await bar.focus();
	await expect(bar).toBeFocused();
	await expect(bar).toHaveAttribute('aria-label', 'Likely slop, collapsed for you: Mostly AI, Hollow. Press Enter to show.');
	await page.keyboard.press('Enter');
	await expect(page.locator('ytd-search ytd-video-renderer').nth(1)).not.toHaveAttribute('data-colander', /./);
	await expect(page.locator('ytd-search ytd-video-renderer').nth(1).locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
});
