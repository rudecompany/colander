// The browser side: a fresh Chromium profile with the built extension pointed at the real
// server, YouTube served from the extension's saved fixtures on its real hostname, and a record
// of every request the browser makes.
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXT_DIR, EXT_ID, ORIGIN, REPO, logMark, signInLink } from './stack.ts';

export { expect };
export { test } from '@playwright/test';

const fixture = (name: string) => readFileSync(resolve(REPO, 'extension/tests/fixtures', name), 'utf8');

/** A fictional channel nobody has rated yet: the subject of the report and appeal journeys. */
export const REPORTED = { handle: '@cosmicfactsdaily', name: 'Cosmic Facts Daily' };

/** Cards on the search page, by what the seeded server says about each card's channel. */
export const CARD = { slop: 0, likely: 1, aiMade: 2, disputed: 3, platformLabel: 4, unlisted: 5, clear: 6, reported: 7 } as const;
export const UNLISTED = { item: 'dkSiqD03zVg', channelId: 'UC9MAhZQQd9egwWCxrwSIsJQ', handle: '@history' };

// Cards 0 and 1 already point at @aihistorydaily (Slop) and @catrescuetales (Likely slop), and
// card 4 carries YouTube's own AI label; the rest are moved to seeded channels.
const REWRITES: Record<number, { handle: string; channelId?: string; name: string }> = {
	[CARD.aiMade]: { handle: '@biblestoriesanimated', name: 'Bible Stories AI Animated' },
	[CARD.disputed]: { handle: '@oceanmysteriesunveiled', channelId: 'UCdemo000000000000000007', name: 'Ocean Mysteries Unveiled' },
	[CARD.clear]: { handle: '@grandpasworkshop', channelId: 'UCdemo000000000000000005', name: "Grandpa's Workshop" },
	[CARD.reported]: REPORTED
};

/** The saved search page with its channel links, names and baked bridge data rewritten per card. */
function searchPage(): string {
	const parts = fixture('yt-search.html').split('<ytd-video-renderer ');
	return parts
		.map((part, i) => {
			const to = REWRITES[i - 1];
			if (!to) return part;
			const bridge = /data-colander-bridge="([^"]*)"/.exec(part)!;
			const data = JSON.parse(bridge[1]!.replaceAll('&quot;', '"')) as { i: string; s: string[] };
			const from = data.s.find((s) => s.startsWith('/@'))!;
			const name = new RegExp(`<a href="${from}">([^<]+)</a>`).exec(part)![1]!;
			data.s = [...(to.channelId ? [to.channelId] : []), `/${to.handle}`];
			return part
				.replace(bridge[0], `data-colander-bridge="${JSON.stringify(data).replaceAll('"', '&quot;')}"`)
				.replaceAll(`href="${from}"`, `href="/${to.handle}"`)
				.replaceAll(`>${name}<`, `>${to.name}<`)
				.replaceAll(`channel ${name}"`, `channel ${to.name}"`)
				.replaceAll(`title="${name}"`, `title="${to.name}"`);
		})
		.join('<ytd-video-renderer ');
}

const PAGES: [RegExp, () => string][] = [
	[/^\/results$/, searchPage],
	[new RegExp(`^/${REPORTED.handle}(/|$)`), () => fixture('yt-channel.html').replaceAll('@NASA', REPORTED.handle).replaceAll('NASA', REPORTED.name)],
	[/^\/$/, () => fixture('yt-home.html')]
];

export const SEARCH = 'https://www.youtube.com/results?search_query=history+documentary';
export const CHANNEL = `https://www.youtube.com/${REPORTED.handle}/videos`;

export interface Seen {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
	/** The service worker, an extension page, or a web page (with any content scripts in it). */
	by: 'worker' | 'extension' | 'page';
	frame: string;
}

export interface Ext {
	ctx: BrowserContext;
	/** Every request this browser made, in order. */
	seen: Seen[];
	storage<T = unknown>(key: string): Promise<T>;
	/** Opens a YouTube page and waits until the content script has looked at its cards. */
	youtube(url: string): Promise<Page>;
	/** Opens chrome-extension://<id>/<path>. */
	page(path: string): Promise<Page>;
	/** The toolbar popup for a tab, opened as a page. */
	popup(page: Page): Promise<Page>;
	close(): Promise<void>;
}

export async function launch(): Promise<Ext> {
	const ctx = await chromium.launchPersistentContext('', {
		channel: 'chromium',
		headless: true,
		viewport: { width: 1280, height: 900 },
		args: [
			`--disable-extensions-except=${EXT_DIR}`,
			`--load-extension=${EXT_DIR}`,
			// Nothing leaves the machine: routes below answer for YouTube, and any request they do not
			// catch (a tab the extension opens can navigate before routing attaches) fails to resolve.
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
		]
	});
	const seen: Seen[] = [];
	ctx.on('request', (req) => {
		const sw = req.serviceWorker();
		let frame = sw?.url() ?? '';
		if (!sw) {
			try {
				frame = req.frame().url();
			} catch {
				frame = '';
			}
		}
		const entry: Seen = { url: req.url(), method: req.method(), headers: req.headers(), body: req.postData(), by: sw ? 'worker' : frame.startsWith('chrome-extension://') ? 'extension' : 'page', frame };
		seen.push(entry);
		// Every header as sent on the wire, cookies included, once Chromium reports them.
		req.allHeaders().then((h) => (entry.headers = h), () => undefined);
	});
	await ctx.route(/^https:\/\/www\.youtube\.com\//, (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (url.pathname.startsWith('/__fixture__/')) return route.fulfill({ contentType: 'text/css', body: fixture(`styles/${url.pathname.slice(13)}`) });
		const html = req.resourceType() === 'document' ? PAGES.find(([re]) => re.test(url.pathname))?.[1]() : undefined;
		return html ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.fulfill({ status: 404, body: '' });
	});
	// The extension is installed once its service worker runs.
	if (!ctx.serviceWorkers().some((w) => w.url().startsWith(`chrome-extension://${EXT_ID}/`))) await ctx.waitForEvent('serviceworker');
	// An extension page kept open to read storage and find tabs; it lives as long as the browser.
	const ctl = await ctx.newPage();
	await ctl.goto(`chrome-extension://${EXT_ID}/options.html`);
	const ext: Ext = {
		ctx,
		seen,
		storage: <T,>(key: string) => ctl.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>,
		async youtube(url) {
			const page = await ctx.newPage();
			await page.goto(url);
			await page.waitForSelector('[data-colander-card]', { state: 'attached' });
			return page;
		},
		async page(path) {
			const page = await ctx.newPage();
			await page.goto(`chrome-extension://${EXT_ID}/${path}`);
			return page;
		},
		async popup(page) {
			const tab = await ctl.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, page.url());
			return ext.page(`popup.html?tab=${tab}`);
		},
		close: () => ctx.close()
	};
	return ext;
}

/** First run as a person does it: the welcome tab that opened on install, in its 3 steps: Standard, YouTube on, pin. */
export async function onboard(ext: Ext): Promise<void> {
	await expect.poll(() => ext.ctx.pages().some((p) => p.url() === `chrome-extension://${EXT_ID}/welcome.html`)).toBe(true);
	const welcome = ext.ctx.pages().find((p) => p.url() === `chrome-extension://${EXT_ID}/welcome.html`)!;
	await expect(welcome.getByRole('radio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
	await welcome.getByRole('button', { name: 'Continue' }).click();
	await expect(welcome.getByRole('checkbox', { name: /YouTube/ })).toBeChecked();
	await welcome.getByRole('button', { name: 'Continue' }).click();
	await expect(welcome.getByRole('heading', { name: 'Pin Colander' })).toBeVisible();
	const opened = ext.ctx.waitForEvent('page');
	await welcome.getByRole('button', { name: 'Done' }).click();
	await expect(welcome.getByRole('heading', { name: 'You are set' })).toBeVisible();
	await (await opened).close();
	await welcome.close();
}

/** Signs in on the website through the emailed link the dev server prints. */
export async function signIn(page: Page, email: string, path: '/account' | '/console'): Promise<void> {
	await page.goto(`${ORIGIN}${path}`);
	await page.getByLabel('Email').fill(email);
	const mark = logMark();
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByText('Check your inbox')).toBeVisible();
	await page.goto(await signInLink(email, mark));
	await expect(page).toHaveURL(`${ORIGIN}${path}`);
}

/** The options page's Lists section, synced now with its own button. */
export async function syncNow(ext: Ext): Promise<Page> {
	const options = await ext.page('options.html#lists');
	const before = await ext.storage<{ lastSyncAt: number }>('status').then((s) => s?.lastSyncAt ?? 0);
	await options.getByRole('button', { name: 'Sync now' }).click();
	await expect.poll(() => ext.storage<{ lastSyncAt: number }>('status').then((s) => s?.lastSyncAt ?? 0)).toBeGreaterThan(before);
	return options;
}

/** A card on the search page. */
export const card = (page: Page, n: number): Locator => page.locator('ytd-search ytd-video-renderer').nth(n);
export const chip = (c: Locator) => c.locator('colander-ui[data-kind="chip"]');
