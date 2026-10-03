// Live adapter checks against the real sites (pnpm test:live). They prove the bundled selectors
// still find cards, item IDs and sources on today's pages; .github/workflows/adapters-daily.yml
// runs them every day (P0-2). No login is used. Surfaces that need an account run only when a
// Playwright storage state is given: COLANDER_LIVE_STATE_YT, _TT, _IG or _FB (a JSON file path).
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Platform } from '@colander/shared/verdicts';

const DIST = resolve(import.meta.dirname, '../../.output/chrome-mv3-e2e');
const EXT_ID = 'nninnogmbhfebflkcgghlmjmplmpodlc';
const STATE: Record<Platform, string | undefined> = {
	yt: process.env.COLANDER_LIVE_STATE_YT,
	tt: process.env.COLANDER_LIVE_STATE_TT,
	ig: process.env.COLANDER_LIVE_STATE_IG,
	fb: process.env.COLANDER_LIVE_STATE_FB
};

interface Surface {
	platform: Platform;
	url: string;
	surface: string;
	/** At least this many cards of the surface must yield a canonical item ID. */
	min: number;
	/** Of those, at least this many must also yield a source (swipe feeds only know the active one). */
	sources: number;
	page?: string;
	login?: boolean;
}

const SURFACES: Surface[] = [
	{ platform: 'yt', url: 'https://www.youtube.com/results?search_query=history+documentary', surface: 'yt.search', min: 8, sources: 8 },
	{ platform: 'yt', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', surface: 'yt.watch', min: 8, sources: 8 },
	{ platform: 'yt', url: 'https://www.youtube.com/@NASA/videos', surface: 'yt.channel', min: 8, sources: 8, page: '@nasa' },
	{ platform: 'yt', url: 'https://www.youtube.com/shorts', surface: 'yt.shorts', min: 2, sources: 1 },
	{ platform: 'yt', url: 'https://www.youtube.com/', surface: 'yt.home', min: 8, sources: 8, login: true },
	{ platform: 'yt', url: 'https://www.youtube.com/feed/subscriptions', surface: 'yt.subscriptions', min: 8, sources: 8, login: true },
	{ platform: 'tt', url: 'https://www.tiktok.com/foryou', surface: 'tt.feed', min: 1, sources: 1 },
	{ platform: 'tt', url: 'https://www.tiktok.com/@tiktok', surface: 'tt.profile', min: 6, sources: 6, page: '@tiktok' },
	{ platform: 'tt', url: 'https://www.tiktok.com/search/video?q=history', surface: 'tt.search', min: 4, sources: 4, login: true },
	{ platform: 'ig', url: 'https://www.instagram.com/', surface: 'ig.feed', min: 2, sources: 2, login: true },
	{ platform: 'ig', url: 'https://www.instagram.com/reels/', surface: 'ig.reels', min: 1, sources: 1, login: true },
	{ platform: 'ig', url: 'https://www.instagram.com/explore/', surface: 'ig.grid', min: 6, sources: 0, login: true },
	{ platform: 'fb', url: 'https://www.facebook.com/', surface: 'fb.feed', min: 2, sources: 2, login: true },
	{ platform: 'fb', url: 'https://www.facebook.com/reel/', surface: 'fb.reels', min: 1, sources: 1, login: true }
];

let ctx: BrowserContext;
let ctl: import('@playwright/test').Page;

test.beforeAll(async () => {
	ctx = await chromium.launchPersistentContext('', {
		channel: 'chromium',
		headless: true,
		locale: 'en-US',
		viewport: { width: 1400, height: 1000 },
		args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--disable-blink-features=AutomationControlled']
	});
	// The API is not needed to find cards; keep the extension quiet and offline from it.
	await ctx.route('http://localhost:8787/**', (r) => r.fulfill({ status: 503, body: '' }));
	for (const [p, file] of Object.entries(STATE)) {
		if (file) await ctx.addCookies(JSON.parse(readFileSync(file, 'utf8')).cookies);
		void p;
	}
	ctl = await ctx.newPage();
	await ctl.goto(`chrome-extension://${EXT_ID}/options.html`);
	for (const p of ['yt', 'tt', 'ig', 'fb']) await ctl.evaluate((p) => chrome.runtime.sendMessage({ type: 'set-platform', platform: p, on: true }), p);
});

test.afterAll(async () => ctx?.close());

for (const s of SURFACES) {
	test(`${s.surface} on ${s.url}`, async () => {
		test.skip(!!s.login && !STATE[s.platform], `needs a signed-in storage state (COLANDER_LIVE_STATE_${s.platform.toUpperCase()})`);
		const page = await ctx.newPage();
		await page.goto(s.url, { waitUntil: 'domcontentloaded' });
		const state = async () =>
			ctl.evaluate(async (origin) => {
				const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
				return tab?.id ? chrome.tabs.sendMessage(tab.id, { type: 'page-state' }).catch(() => null) : null;
			}, new URL(s.url).origin);
		const of = async () => (await state())?.bySurface?.[s.surface] ?? { total: 0, withItem: 0, withSource: 0 };
		const blocked = async () => /Something went wrong|Please try again later|unusual traffic|verify you are human/i.test(await page.locator('body').innerText().catch(() => ''));
		try {
			await expect.poll(async () => (await of()).withItem, { timeout: 45_000, intervals: [1000] }).toBeGreaterThanOrEqual(s.min);
		} catch (e) {
			// Sites sometimes refuse automated browsers outright. That is not an adapter failure,
			// but it is reported, and a run where it happens every day needs a person to look.
			await page.screenshot({ path: test.info().outputPath('page.png') });
			test.skip((await of()).total === 0 && (await blocked()), `${new URL(s.url).hostname} served its own error page to the automated browser`);
			throw e;
		}
		await page.mouse.wheel(0, 1500);
		await page.waitForTimeout(2500);
		const st = (await state())!;
		const b = st.bySurface[s.surface]!;
		console.log(`${s.surface}: ${b.total} cards, ${b.withItem} with item IDs, ${b.withSource} with sources; page adds ${st.perf.totalMs} ms over ${st.perf.batches} batches`);
		expect(b.withItem).toBeGreaterThanOrEqual(s.min);
		// Grids on a source page take the page's source when a card shows none.
		expect(s.page ? b.withItem : b.withSource).toBeGreaterThanOrEqual(s.sources);
		if (s.page) expect(st.source?.sourceIds).toContain(s.page);
		await page.close();
	});
}
