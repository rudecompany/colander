// @vitest-environment jsdom
// Adapter extraction against the saved fixtures of every surface.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { Platform } from '@colander/shared/verdicts';
import defaults from '../../src/adapters/default-config.json';
import { readBridge } from '../../src/adapters/bridge-read';
import { validateConfig, type AdapterConfig } from '../../src/adapters/schema';
import { activeSurfaces, extractCard, pageSource, platformForHost } from '../../src/adapters/extract';
import { offered } from '../../src/lib/platforms';

const config = validateConfig(defaults) as AdapterConfig;

function load(fixture: string, url: string) {
	const html = readFileSync(resolve('tests/fixtures', `${fixture}.html`), 'utf8');
	const doc = new JSDOM(html, { url }).window.document;
	const u = new URL(url);
	const platform = platformForHost(config.platforms, u.hostname) as Platform;
	const pc = config.platforms[platform]!;
	const surfaces = activeSurfaces(pc.surfaces, u.pathname);
	const cards = surfaces.flatMap((s) => [...doc.querySelectorAll(s.card)].map((el) => ({ s, el, f: extractCard(platform, s, el, doc) })));
	return { doc, platform, pc, surfaces, cards };
}

interface Case {
	fixture: string;
	url: string;
	surfaces: string[];
	min: number;
	/** Share of cards that must yield a source (grids on source pages inherit the page's). */
	sourced: number;
	expect?: { card: number; item?: string; source?: string; aiLabel?: boolean; title?: RegExp }[];
	page?: string;
}

const cases: Case[] = [
	{
		fixture: 'yt-search', url: 'https://www.youtube.com/results?search_query=history+documentary', surfaces: ['yt.search', 'yt.shelf'], min: 12, sourced: 0.66,
		expect: [{ card: 0, source: '@aihistorydaily' }, { card: 1, source: '@catrescuetales' }, { card: 2, item: 'dQw4w9WgXcQ' }, { card: 4, aiLabel: true }, { card: 3, aiLabel: false }]
	},
	{
		fixture: 'yt-watch', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', surfaces: ['yt.watch', 'yt.shelf'], min: 10, sourced: 1,
		expect: [{ card: 1, source: '@aihistorydaily' }, { card: 3, source: '@catrescuetales' }, { card: 5, item: 'dQw4w9WgXcQ' }]
	},
	{ fixture: 'yt-channel', url: 'https://www.youtube.com/@NASA/videos', surfaces: ['yt.channel', 'yt.shelf'], min: 9, sourced: 1, expect: [{ card: 1, item: 'dQw4w9WgXcQ' }], page: '@nasa' },
	{
		fixture: 'yt-home', url: 'https://www.youtube.com/', surfaces: ['yt.home', 'yt.shelf'], min: 12, sourced: 1,
		expect: [{ card: 0, source: 'UCaaaaaaaaaaaaaaaaaaaaaa' }, { card: 1, source: '@catrescuetales' }, { card: 2, item: 'dQw4w9WgXcQ' }, { card: 4, source: '@aihistorydaily' }]
	},
	{ fixture: 'yt-subscriptions', url: 'https://www.youtube.com/feed/subscriptions', surfaces: ['yt.subscriptions', 'yt.shelf'], min: 6, sourced: 1, expect: [{ card: 2, source: '@aihistorydaily' }] },
	{ fixture: 'yt-shorts', url: 'https://www.youtube.com/shorts/_k2w1cC69qY', surfaces: ['yt.shorts'], min: 6, sourced: 0.1, expect: [{ card: 0, item: '_k2w1cC69qY', source: '@aihistorydaily', title: /\S/ }] },
	{ fixture: 'tt-foryou', url: 'https://www.tiktok.com/foryou', surfaces: ['tt.feed'], min: 4, sourced: 1, expect: [{ card: 1, source: '@sloppyfacts' }, { card: 2, item: '7412345678901234567' }] },
	{ fixture: 'tt-profile', url: 'https://www.tiktok.com/@tiktok', surfaces: ['tt.profile'], min: 12, sourced: 1, page: '@tiktok' },
	{
		fixture: 'tt-search', url: 'https://www.tiktok.com/search?q=history', surfaces: ['tt.search'], min: 4, sourced: 1,
		expect: [{ card: 0, source: '@sloppyfacts', item: '7400000000000000001' }, { card: 2, aiLabel: true, item: '7412345678901234567' }, { card: 3, item: '7400000000000000004' }]
	},
	{
		fixture: 'ig-feed', url: 'https://www.instagram.com/', surfaces: ['ig.feed'], min: 4, sourced: 1,
		expect: [{ card: 0, source: 'handmadepottery', item: 'C9xYz12AbCd', title: /Glazing/ }, { card: 1, aiLabel: true, source: 'dreamy.ai.worlds' }, { card: 2, item: 'DAbC_12-xYz' }, { card: 3, aiLabel: false }]
	},
	{ fixture: 'ig-reels', url: 'https://www.instagram.com/reels/DAbC_12-xYz/', surfaces: ['ig.reels'], min: 3, sourced: 1, expect: [{ card: 0, item: 'DAbC_12-xYz', source: 'endless.wonders.daily' }, { card: 2, aiLabel: true }] },
	{ fixture: 'ig-explore', url: 'https://www.instagram.com/explore/', surfaces: ['ig.grid'], min: 6, sourced: 0, expect: [{ card: 0, item: 'C9xYz12AbCd' }, { card: 3, item: 'DAbC_12-xYz' }] },
	{
		fixture: 'fb-feed', url: 'https://www.facebook.com/', surfaces: ['fb.feed'], min: 4, sourced: 1,
		expect: [
			{ card: 0, item: 'pfbid02abcDEF', source: 'endlesswonders', title: /grandma/ },
			{ card: 2, item: 'pfbid0dreamyART999', source: '100064582345678', aiLabel: true },
			{ card: 3, item: '987654321098765', source: '100089123456789' }
		]
	},
	{ fixture: 'fb-reels', url: 'https://www.facebook.com/reel/987654321098765', surfaces: ['fb.reels'], min: 3, sourced: 1, expect: [{ card: 0, item: '987654321098765', source: 'endlesswonders' }, { card: 2, aiLabel: true, source: '100064582345678' }] }
];

describe.each(cases)('$fixture', (c) => {
	const { doc, platform, pc, surfaces, cards } = load(c.fixture, c.url);

	it('activates the right surfaces', () => {
		expect(surfaces.map((s) => s.id)).toEqual(c.surfaces);
	});

	it('finds cards with canonical item IDs', () => {
		expect(cards.length).toBeGreaterThanOrEqual(c.min);
		for (const { f } of cards) expect(f.itemId, f.title).toBeTruthy();
	});

	it('finds sources', () => {
		const page = pageSource(platform, pc.pages, doc);
		const n = cards.filter(({ s, f }) => f.sourceIds.length || (s.pageSource && page)).length;
		expect(n / cards.length).toBeGreaterThanOrEqual(c.sourced);
	});

	if (c.expect) it('reads seeded cards exactly', () => {
		for (const e of c.expect ?? []) {
			const f = cards[e.card]!.f;
			if (e.item) expect(f.itemId).toBe(e.item);
			if (e.source) expect(f.sourceIds).toContain(e.source);
			if (e.aiLabel !== undefined) expect(f.aiLabel).toBe(e.aiLabel);
			if (e.title) expect(f.title).toMatch(e.title);
		}
	});

	if (c.page) it('reads the page source', () => {
		expect(pageSource(platform, pc.pages, doc)?.sourceIds).toContain(c.page);
	});
});

describe('config validation', () => {
	it('rejects payloads that are not usable', () => {
		expect(() => validateConfig({ version: 0, schema: 1, platforms: {} })).toThrow('version');
		expect(() => validateConfig({ version: 2, schema: 99, platforms: {} })).toThrow('schema');
		expect(() => validateConfig({ version: 2, schema: 1, platforms: { xx: {} } })).toThrow('unknown platform');
		const bad = structuredClone(defaults) as AdapterConfig;
		bad.platforms.yt!.surfaces[0]!.path = '(';
		expect(() => validateConfig(bad)).toThrow('bad regular expression');
	});

	it('lets a bridge call only the getters bundled with the release, never one a remote config names', () => {
		const remote = structuredClone(defaults) as AdapterConfig;
		remote.platforms.yt!.bridges![0]!.props = ['componentProps.constructor()'];
		expect(() => validateConfig(remote)).toThrow('constructor(), which is not an allowed getter');
		remote.platforms.yt!.bridges![0]!.props = ['componentProps.data()', 'rawProps.data'];
		expect(() => validateConfig(remote)).not.toThrow();
		// The reader skips any other getter on its own, too.
		let called = false;
		const card = Object.assign(document.createElement('div'), { evil: () => ((called = true), { videoId: 'x' }), data: () => ({ videoId: 'dQw4w9WgXcQ' }) });
		const bridge = { card: 'div', props: ['evil()', 'data()'], item: [{ key: 'videoId' }] };
		expect(readBridge(card, bridge)).toEqual({ i: 'dQw4w9WgXcQ' });
		expect(called).toBe(false);
	});

	it('early access is a boolean, off in the bundled config, and needs Plus to be offered', () => {
		const odd = structuredClone(defaults) as AdapterConfig;
		(odd.platforms.ig as { early_access?: unknown }).early_access = 'yes';
		expect(() => validateConfig(odd)).toThrow('early_access');
		expect(Object.values(config.platforms).some((p) => p.early_access)).toBe(false);
		const remote = { ...structuredClone(defaults), version: 2 } as AdapterConfig;
		remote.platforms.ig!.early_access = true;
		expect(validateConfig(remote).platforms.ig!.early_access).toBe(true);
		expect(offered('ig', remote, false)).toBe(false);
		expect(offered('ig', remote, true)).toBe(true);
		expect(offered('yt', remote, false)).toBe(true);
		// A remote copy that is not newer than the bundled one does not count.
		expect(offered('ig', { ...remote, version: 1 }, false)).toBe(true);
	});
});
