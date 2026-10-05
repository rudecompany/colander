// Swipe feeds: a hidden video is skipped the moment it becomes active, silently unless the skip
// notice is on in Appearance, and its slot shows nothing; the popup still lists it with Show.
import type { Page } from '@playwright/test';
import { EXT_ID, expect, fixtureHtml, test } from './harness';

const SHORT = 'https://www.youtube.com/shorts/_k2w1cC69qY';

test('Shorts: slop is skipped silently, shows nothing, and the popup brings it back', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open(SHORT);
	const scroller = page.locator('#shorts-container');
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	await expect(slot0).toHaveAttribute('data-colander', 'skip');
	await expect(slot0.locator('.reel-video-in-sequence-thumbnail')).toBeHidden();
	await expect(slot0.locator('colander-ui')).toHaveCount(0);
	// No notice by default.
	await page.waitForTimeout(300);
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toHaveCount(0);
	// A play attempt in the skipped slot is paused at once.
	const paused = await slot0.locator('video').evaluate(async (v: HTMLVideoElement) => {
		v.dispatchEvent(new Event('play'));
		return v.paused;
	});
	expect(paused).toBe(true);

	// The toolbar count and the popup still have it, with Show.
	const state = await ext.pageState(page);
	expect(state.counts).toEqual({ hidden: 1, labeled: 0 });
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html?tab=${await ext.tabId(page)}`);
	await popup.getByRole('listitem').filter({ hasText: 'Slop' }).getByRole('button', { name: 'Show' }).click();
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeLessThan(100);
});

/** The id of the Short that fills most of the window. */
const inView = (page: Page) =>
	page.evaluate(() => {
		let best: Element | null = null;
		let most = 0;
		for (const c of document.querySelectorAll('#shorts-inner-container > .reel-video-in-sequence-new')) {
			const r = c.getBoundingClientRect();
			const seen = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
			if (seen > most) (most = seen), (best = c);
		}
		return best?.id ?? null;
	});

test('Shorts: swiping back to a skipped short skips it again, the way the person is going', async ({ ext }) => {
	await ext.setup();
	// A second Short from the same Slop channel, in the middle of the feed.
	const html = fixtureHtml('yt-shorts').replace(
		'<div class="reel-video-in-sequence-new" id="2">',
		'<div class="reel-video-in-sequence-new" id="2" data-colander-bridge="{&quot;i&quot;:&quot;uuitWzDCPWw&quot;,&quot;s&quot;:[&quot;/@aihistorydaily&quot;]}">'
	);
	const page = await ext.open(SHORT, { html });
	const slots = page.locator('#shorts-inner-container > .reel-video-in-sequence-new');
	const swipeTo = (n: number) => slots.nth(n).evaluate((e) => e.scrollIntoView({ block: 'start' }));
	await expect(slots.nth(2)).toHaveAttribute('data-colander', 'skip');
	// The first Short is skipped forward on load.
	await expect.poll(() => inView(page)).toBe('1');
	// Down onto the second hidden Short: on to the next one.
	await swipeTo(2);
	await expect.poll(() => inView(page)).toBe('3');
	// Back up onto it: on back to the one before it, never a blank slot.
	await swipeTo(2);
	await expect.poll(() => inView(page)).toBe('1');
	// Back up onto the first Short, with nothing before it: forward again.
	await swipeTo(0);
	await expect.poll(() => inView(page)).toBe('1');
	await page.waitForTimeout(400);
	expect(await inView(page)).toBe('1');
	await expect(slots.nth(1)).not.toHaveAttribute('data-colander', /./);
	// Silent every time, with the notice off.
	await expect(page.locator('colander-ui[data-kind="layer"] .cl-toast')).toHaveCount(0);
});

test('Shorts: with the skip notice on, a skip says so, with Undo', async ({ ext }) => {
	await ext.setup({ settings: { skipNotice: true } });
	const page = await ext.open(SHORT);
	const scroller = page.locator('#shorts-container');
	const notice = page.locator('colander-ui[data-kind="layer"] .cl-toast');
	await expect(notice).toContainText('Skipped 1 slop video.');
	await expect(notice).toHaveAttribute('role', 'status');
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	// On the player it skipped to: centered, at least 12 px inside its sides, 16 px below its top,
	// clear of the channel row and title at the bottom.
	const player = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').nth(1);
	await expect
		.poll(async () => {
			const p = (await player.boundingBox())!;
			const n = (await notice.boundingBox())!;
			return [
				Math.round(n.x + n.width / 2 - (p.x + p.width / 2)),
				n.x >= p.x + 11.5 && n.x + n.width <= p.x + p.width - 11.5,
				Math.round(n.y - Math.max(p.y, 0))
			];
		})
		.toEqual([0, true, 16]);
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await notice.getByRole('button', { name: 'Undo' }).click();
	await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeLessThan(100);
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Slop');
	await expect(notice).toHaveCount(0);
});

test('Shorts: likely slop is skipped at Standard and labeled at Label', async ({ ext }) => {
	await ext.setup();
	// The first Short's channel is at Likely slop on the list for this test.
	const html = fixtureHtml('yt-shorts').replaceAll('aihistorydaily', 'catrescuetales');
	const page = await ext.open(SHORT, { html });
	const slot0 = page.locator('#shorts-inner-container > .reel-video-in-sequence-new').first();
	await expect(slot0).toHaveAttribute('data-colander', 'skip');
	await expect.poll(() => page.locator('#shorts-container').evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
	await ext.send({ type: 'settings', patch: { strictness: 'label' } });
	await expect(slot0).not.toHaveAttribute('data-colander', /./);
	await expect(slot0.locator('colander-ui[data-kind="chip"]')).toContainText('Likely slop');
});

test('TikTok: disputed shows with its mark beside the creator', async ({ ext }) => {
	await ext.setup({ platforms: ['tt'] });
	const page = await ext.open('https://www.tiktok.com/foryou');
	const article = page.locator('article[data-e2e="recommend-list-item-container"]').nth(1);
	const chip = article.locator('[class*="CreatorInfoContainer"] colander-ui[data-kind="chip"]');
	await expect(chip).toContainText('Disputed');
	await expect(article.locator('colander-ui[data-kind="tag"]')).toBeVisible();
	await expect(article).not.toHaveAttribute('data-colander', /./);
});
