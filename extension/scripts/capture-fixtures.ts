// Captures sanitized HTML fixtures of live YouTube and TikTok surfaces (no login), for the
// adapter unit tests and the end-to-end suite. Instagram and Facebook need an account to show
// feeds, so their fixtures are written by hand (tests/fixtures/ig-*.html, fb-*.html).
//
// Usage: node scripts/capture-fixtures.ts [name ...]
// Each fixture keeps the real element structure from <body> down to a handful of cards, drops
// scripts, styles, media sources and attributes the adapters never read, bakes in what the
// main-world bridge would read from page data, then seeds a few cards with IDs from the
// contract list (testdata/contract) so the end-to-end tests have known verdicts to act on.
import { chromium, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readBridge } from '../src/adapters/bridge-read.ts';
import config from '../src/adapters/default-config.json' with { type: 'json' };

type Seed = { card: number; source?: string; item?: string; name?: string; aiLabel?: boolean };
interface Capture {
	name: string;
	url: string;
	platform: 'yt' | 'tt';
	/** Card selector and how many to keep. */
	cards: [string, number][];
	/** Extra subtrees to keep whole (page headers). */
	keep?: string[];
	seeds?: Seed[];
	/** Rewrites applied to the captured DOM before saving. */
	retarget?: { pageSubtype?: string; drop?: string[]; path: string; owner?: string };
	title: string;
}

const CAPTURES: Capture[] = [
	{
		name: 'yt-search',
		url: 'https://www.youtube.com/results?search_query=history+documentary',
		platform: 'yt',
		cards: [['ytd-search ytd-video-renderer', 8], ['ytm-shorts-lockup-view-model', 4]],
		seeds: [
			{ card: 0, source: '@aihistorydaily', name: 'AI History Daily' },
			{ card: 1, source: '@catrescuetales', name: 'Cat Rescue Tales' },
			{ card: 2, item: 'dQw4w9WgXcQ' },
			{ card: 4, aiLabel: true }
		],
		title: 'history documentary - YouTube'
	},
	{
		name: 'yt-watch',
		url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
		platform: 'yt',
		cards: [['ytd-watch-next-secondary-results-renderer yt-lockup-view-model', 10]],
		seeds: [
			{ card: 1, source: '@aihistorydaily', name: 'AI History Daily' },
			{ card: 3, source: '@catrescuetales', name: 'Cat Rescue Tales' },
			{ card: 5, item: 'dQw4w9WgXcQ' }
		],
		title: 'Me at the zoo - YouTube'
	},
	{
		name: 'yt-channel',
		url: 'https://www.youtube.com/@NASA/videos',
		platform: 'yt',
		cards: [['ytd-browse[page-subtype="channels"] ytd-rich-item-renderer', 9]],
		keep: ['yt-page-header-view-model'],
		seeds: [{ card: 1, item: 'dQw4w9WgXcQ' }],
		title: 'NASA - YouTube'
	},
	{
		name: 'yt-home',
		url: 'https://www.youtube.com/@NASA/videos',
		platform: 'yt',
		cards: [['ytd-browse[page-subtype="channels"] ytd-rich-item-renderer', 12]],
		retarget: { pageSubtype: 'home', drop: ['#page-header-container', 'ytd-tabbed-page-header', '#tabs-container'], path: '/', owner: '/@NASA' },
		seeds: [
			{ card: 0, source: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'Endless Facts' },
			{ card: 1, source: '@catrescuetales', name: 'Cat Rescue Tales' },
			{ card: 2, item: 'dQw4w9WgXcQ' },
			{ card: 4, source: '@aihistorydaily', name: 'AI History Daily' }
		],
		title: 'YouTube'
	},
	{
		name: 'yt-subscriptions',
		url: 'https://www.youtube.com/@NASA/videos',
		platform: 'yt',
		cards: [['ytd-browse[page-subtype="channels"] ytd-rich-item-renderer', 6]],
		retarget: { pageSubtype: 'subscriptions', drop: ['#page-header-container', 'ytd-tabbed-page-header', '#tabs-container'], path: '/feed/subscriptions', owner: '/@NASA' },
		seeds: [{ card: 2, source: '@aihistorydaily', name: 'AI History Daily' }],
		title: 'Subscriptions - YouTube'
	},
	{
		name: 'yt-shorts',
		url: 'https://www.youtube.com/shorts',
		platform: 'yt',
		cards: [['#shorts-inner-container > .reel-video-in-sequence-new', 6]],
		seeds: [{ card: 0, source: '@aihistorydaily', name: '@aihistorydaily' }],
		title: 'YouTube Shorts'
	},
	{
		name: 'tt-foryou',
		url: 'https://www.tiktok.com/foryou',
		platform: 'tt',
		cards: [['article[data-e2e="recommend-list-item-container"]', 4]],
		seeds: [
			{ card: 1, source: '@sloppyfacts', name: 'Sloppy Facts' },
			{ card: 2, item: '7412345678901234567' }
		],
		title: 'TikTok - Make Your Day'
	},
	{
		name: 'tt-profile',
		url: 'https://www.tiktok.com/@tiktok',
		platform: 'tt',
		cards: [['[data-e2e="user-post-item"]', 12]],
		keep: ['[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', '[data-e2e="user-more"]', '[data-e2e="user-avatar"]'],
		title: 'TikTok (@tiktok) | TikTok'
	}
];

const DROP =
	'script, style, link, noscript, iframe, template, dom-repeat, dom-if, svg, canvas, yt-icon, tp-yt-paper-tooltip, ' +
	'yt-touch-feedback-shape, yt-interaction, ytd-player, #player-container, yt-light-shape, ytd-expandable-metadata-renderer, ' +
	'source, picture source, tt-vod-sr-wrap';
const KEEP_ATTR = /^(id|class|href|role|aria-label|aria-posinset|title|alt|dir|page-subtype|data-e2e|data-more-menu-item-id|data-scroll-index|data-colander-bridge|lockup|is-active|tabindex)$/;

async function sanitize(page: Page, c: Capture) {
	const bridges = (config.platforms[c.platform] as { bridges?: unknown[] }).bridges ?? [];
	// A string evaluation goes through the DevTools protocol, so the page's CSP and Trusted Types do not apply.
	await page.evaluate(`window.__colanderReadBridge = ${readBridge.toString()}`);
	return page.evaluate(
		({ c, DROP, KEEP_ATTR, bridges }) => {
			const readBridge = (window as any).__colanderReadBridge;
			// Bake in what the main-world bridge reads from page data.
			for (const b of bridges) {
				for (const card of document.querySelectorAll(b.card)) {
					const r = readBridge(card, b);
					if (r) card.setAttribute('data-colander-bridge', JSON.stringify(r));
				}
			}
			// Work on a detached copy: removing nodes from the live page runs the app's own teardown,
			// which deletes the very cards being kept (YouTube's dom-repeat removes its stamped slots).
			const body = document.body.cloneNode(true) as HTMLElement;
			const keepRoots: Element[] = [];
			for (const [sel, n] of c.cards) keepRoots.push(...[...body.querySelectorAll(sel)].slice(0, n));
			for (const sel of c.keep ?? []) {
				const el = body.querySelector(sel);
				if (el) keepRoots.push(el);
			}
			const keep = new Set<Element>();
			for (const r of keepRoots) for (let e: Element | null = r; e; e = e.parentElement) keep.add(e);
			const inside = (e: Element) => keepRoots.some((r) => r.contains(e));
			const walk = (e: Element) => {
				for (const child of [...e.children]) {
					if (keep.has(child)) walk(child);
					else if (!inside(child)) child.remove();
				}
			};
			walk(body);
			for (const r of keepRoots) r.querySelectorAll(DROP).forEach((e) => e.remove());
			const keepAttr = new RegExp(KEEP_ATTR);
			for (const e of [body, ...body.querySelectorAll('*')]) {
				for (const a of [...e.attributes]) {
					const thumbStyle = a.name === 'style' && a.value.includes('/vi/');
					if (!keepAttr.test(a.name) && !thumbStyle) e.removeAttribute(a.name);
					else if (a.name === 'class') {
						const cls = a.value.split(/\s+/).filter((t) => t && t !== 'style-scope' && !/^(ytd|yt)-[a-z-]+$/.test(t) );
						if (cls.length) e.setAttribute('class', cls.join(' '));
						else e.removeAttribute('class');
					} else if (a.name === 'href' && a.value.startsWith('https://www.youtube.com')) {
						e.setAttribute('href', a.value.slice('https://www.youtube.com'.length));
					}
				}
				if (e.tagName === 'IMG') e.removeAttribute('src');
			}
			// Drop comments and whitespace-only text nodes.
			const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
			const empty: Node[] = [];
			while (tw.nextNode()) if (tw.currentNode.nodeType === 8 || !tw.currentNode.textContent?.trim()) empty.push(tw.currentNode);
			empty.forEach((n) => n.parentNode?.removeChild(n));
			return body.innerHTML;
		},
		{ c, DROP, KEEP_ATTR: KEEP_ATTR.source, bridges: bridges as any[] }
	);
}

/** Rewrites cards so they carry contract-list IDs. Runs on the sanitized markup in a blank page. */
async function seed(page: Page, c: Capture, body: string) {
	await page.setContent(`<body>${body}</body>`);
	return page.evaluate(
		({ c }) => {
			const cards: Element[] = [];
			for (const [sel] of c.cards) cards.push(...document.querySelectorAll(sel));
			if (c.retarget?.pageSubtype) {
				document.querySelectorAll('ytd-browse[page-subtype]').forEach((e) => e.setAttribute('page-subtype', c.retarget!.pageSubtype!));
				for (const d of c.retarget.drop ?? []) document.querySelectorAll(d).forEach((e) => e.remove());
			}
			// Cards captured from a channel's own grid carry no channel; in a feed every card does.
			if (c.retarget?.owner) {
				for (const card of cards) {
					const b = JSON.parse(card.getAttribute('data-colander-bridge') || '{}');
					if (!b.s) card.setAttribute('data-colander-bridge', JSON.stringify({ ...b, s: [c.retarget.owner] }));
				}
			}
			// Feeds virtualize: cards far from the viewport are empty shells until scrolled near.
			// Fill them from the first rendered card with fresh IDs so every card has content.
			const template = cards.find((card) => card.children.length);
			cards.forEach((card, n) => {
				if (card.children.length || !template) return;
				const id = `76000000000000000${n}`;
				card.innerHTML = template.innerHTML
					.replace(/(data-more-menu-item-id=")\d+/g, `$1${id}`)
					.replace(/(xgwrapper-\d+-)\d+/g, `$1${id}`)
					.replace(/href="\/@[^"]+"/g, `href="/@creator${n}"`);
			});
			for (const s of c.seeds ?? []) {
				const card = cards[s.card];
				if (!card) continue;
				const hasBridge = card.hasAttribute('data-colander-bridge');
				const bridge = JSON.parse(card.getAttribute('data-colander-bridge') || '{}');
				if (s.source) {
					const handle = s.source.startsWith('@');
					card.querySelectorAll('a[href]').forEach((a) => {
						const h = a.getAttribute('href')!;
						if (/^\/(@|channel\/)/.test(h)) a.setAttribute('href', handle ? `/${s.source}` : `/channel/${s.source}`);
						if (/\/@[^/]+\/video\//.test(h)) a.setAttribute('href', h.replace(/\/@[^/]+\//, `/${s.source}/`));
						if (/^\/@[^/]+$/.test(h) && c.platform === 'tt') a.setAttribute('href', `/${s.source}`);
					});
					if (hasBridge) bridge.s = [handle ? `/${s.source}` : s.source];
				}
				if (s.item) {
					card.querySelectorAll('a[href]').forEach((a) => {
						const h = a.getAttribute('href')!;
						a.setAttribute('href', h.replace(/([?&]v=|\/shorts\/|\/video\/)[\w-]+/, `$1${s.item}`));
					});
					card.querySelectorAll('[data-more-menu-item-id]').forEach((e) => e.setAttribute('data-more-menu-item-id', s.item!));
					card.querySelectorAll('[id^="xgwrapper-"]').forEach((e) => e.setAttribute('id', e.id.replace(/\d+$/, s.item!)));
					if (bridge.i) bridge.i = s.item;
				}
				if (s.name) {
					card.querySelectorAll('ytd-channel-name a, [class*="CreatorInfoContainer"] a p, yt-reel-channel-bar-view-model a').forEach((e) => (e.textContent = s.name!));
					card.querySelectorAll('[aria-label^="Go to channel "]').forEach((e) => e.setAttribute('aria-label', `Go to channel ${s.name}`));
				}
				if (s.aiLabel) {
					const host = card.querySelector('#badges, .badges, #meta') ?? card;
					const badge = document.createElement('badge-shape');
					badge.className = 'fixture-ai-badge';
					badge.textContent = 'Altered or synthetic content';
					host.appendChild(badge);
				}
				if (hasBridge) card.setAttribute('data-colander-bridge', JSON.stringify(bridge));
			}
			// Swipe slots get a stand-in video so the end-to-end tests can check pausing.
			document.querySelectorAll('#shorts-inner-container > .reel-video-in-sequence-new').forEach((slot) => {
				if (!slot.querySelector('video')) slot.appendChild(document.createElement('video'));
			});
			return document.body.innerHTML;
		},
		{ c }
	);
}

function wrap(c: Capture, body: string) {
	return `<!doctype html>
<!-- Captured from ${c.url} on ${new Date().toISOString().slice(0, 10)} by scripts/capture-fixtures.ts, sanitized and seeded. -->
<html lang="en"><head><meta charset="utf-8"><title>${c.title}</title>
<link rel="stylesheet" href="/__fixture__/${c.platform}.css"></head>
<body>
${body.replace(/></g, '>\n<')}
</body></html>
`;
}

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
	locale: 'en-US',
	viewport: { width: 1400, height: 1000 },
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
});
mkdirSync(new URL('../tests/fixtures/', import.meta.url), { recursive: true });
for (const c of CAPTURES) {
	if (only.length && !only.includes(c.name)) continue;
	const page = await ctx.newPage();
	await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	await page.waitForTimeout(8000);
	await page.mouse.wheel(0, 1200);
	await page.waitForTimeout(2000);
	const raw = await sanitize(page, c);
	const blank = await ctx.newPage();
	const seeded = await seed(blank, c, raw);
	writeFileSync(new URL(`../tests/fixtures/${c.name}.html`, import.meta.url), wrap(c, seeded));
	console.log(c.name, seeded.length, 'chars');
	await page.close();
	await blank.close();
}
await browser.close();
