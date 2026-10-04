// Shared end-to-end setup: a fresh Chromium profile with the built extension, platform pages
// routed to saved fixtures on their real hostnames, and the Colander API mocked with route
// handlers that serve the signed contract fixtures.
import { test as base, chromium, expect, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Platform } from '@colander/shared/verdicts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const DIST = resolve(ROOT, 'dist/chrome-mv3-e2e');
export const EXT_ID = 'nninnogmbhfebflkcgghlmjmplmpodlc';
export const API = 'http://localhost:8787';
/** Screenshots in screenshots/ are written only by `pnpm screenshots` (SCREENSHOTS=1), never by a normal run. */
export const SHOTS = !!process.env.SCREENSHOTS;
const REPO = resolve(ROOT, '..');
const fixture = (name: string) => readFileSync(resolve(ROOT, 'tests/fixtures', name));
export const fixtureHtml = (name: string) => fixture(`${name}.html`).toString('utf8');

/** Signs payloads with the published development key, like the server does in dev. */
export function devSign(context: string, payload: Buffer): Buffer {
	const seed = Buffer.from(readFileSync(resolve(REPO, 'testdata/dev-signing.key'), 'utf8').trim(), 'base64');
	const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
	return sign(null, Buffer.concat([Buffer.from(context), Buffer.from([0]), payload]), key);
}

export function planToken(p: { trial: boolean; exp: number; sub?: string }): string {
	const payload = Buffer.from(JSON.stringify({ v: 1, sub: p.sub ?? 'acc_e2e', plan: 'plus', trial: p.trial, iat: Math.floor(Date.now() / 1000), exp: p.exp }));
	return `${payload.toString('base64url')}.${devSign('colander:plan:v1', payload).toString('base64url')}`;
}

export interface Sent {
	method: string;
	path: string;
	auth: string | undefined;
	body: unknown;
}

export class MockApi {
	sent: Sent[] = [];
	delta = false;
	offline = false;
	reports: Record<string, unknown>[] = [];
	config: unknown = null;
	/** What POST /v1/entitlement/refresh finds behind a paid token. */
	plan: 'active' | 'ended' = 'active';
	review: { queue: unknown[]; source: unknown } = { queue: [], source: null };

	async handle(route: Route) {
		const req = route.request();
		const url = new URL(req.url());
		const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
		this.sent.push({ method: req.method(), path: url.pathname + url.search, auth: req.headers()['authorization'], body });
		if (this.offline) return route.abort('internetdisconnected');
		const ok = (json: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(json) });
		const p = url.pathname;
		if (p === '/v1/list/snapshot') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fixture('../../../testdata/contract/list-snapshot.bin') });
		if (p === '/v1/list/delta') {
			if (this.delta && url.searchParams.get('since') === '42') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: fixture('../../../testdata/contract/list-delta.bin') });
			return route.fulfill({ status: 204 });
		}
		if (p === '/v1/config/adapters') return this.config ? ok(this.config) : ok({ error: { code: 'not_found', message: 'No config.' } }, 404);
		if (p === '/v1/tags') {
			const tags = (body as { tags: { client_id: string }[] }).tags;
			return ok({ accepted: tags.map((t) => t.client_id), rejected: [] });
		}
		if (p === '/v1/reports' && req.method() === 'POST') {
			const b = body as Record<string, string>;
			const report = { id: `rpt_${this.reports.length + 1}`, platform: b.platform, source_id: b.source_id, source_name: b.source_name ?? null, status: 'under_review', verdict: null, protects: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
			this.reports.unshift(report);
			return ok({ report }, 201);
		}
		if (p === '/v1/reports') return ok({ reports: this.reports });
		if (p === '/v1/entitlement/refresh') {
			if (this.plan === 'ended') return ok({ error: { code: 'no_plan', message: 'No active plan.' } }, 404);
			return ok({ token: planToken({ trial: false, exp: Math.floor(Date.now() / 1000) + 33 * 86400 }) });
		}
		if (p === '/v1/trial') return ok({ token: planToken({ trial: true, exp: Math.floor(Date.now() / 1000) + 14 * 86400 }) });
		if (p === '/v1/sync') return req.method() === 'GET' ? ok({ error: { code: 'not_found', message: 'None.' } }, 404) : ok({ version: 1 });
		if (p.startsWith('/v1/review/queue')) return ok({ items: this.review.queue, next_cursor: null });
		if (p.startsWith('/v1/review/sources/') && p.endsWith('/decision')) return ok({ ok: true });
		if (p.startsWith('/v1/review/sources/')) return ok(this.review.source);
		return ok({ error: { code: 'not_found', message: 'Not found.' } }, 404);
	}

	posted(path: string) {
		return this.sent.filter((s) => s.method === 'POST' && s.path.startsWith(path));
	}
}

type Site = [RegExp, string][];
const SITES: Record<string, Site> = {
	'www.youtube.com': [[/^\/$/, 'yt-home'], [/^\/results/, 'yt-search'], [/^\/watch/, 'yt-watch'], [/^\/shorts\//, 'yt-shorts'], [/^\/feed\/subscriptions/, 'yt-subscriptions'], [/^\/@/, 'yt-channel']],
	'www.tiktok.com': [[/^\/(foryou)?$/, 'tt-foryou'], [/^\/search/, 'tt-search'], [/^\/@[^/]+\/?$/, 'tt-profile']],
	'www.instagram.com': [[/^\/$/, 'ig-feed'], [/^\/reels?\//, 'ig-reels'], [/^\/explore/, 'ig-explore']],
	'www.facebook.com': [[/^\/$/, 'fb-feed'], [/^\/reel\//, 'fb-reels']]
};

async function serveSites(ctx: BrowserContext, extra?: (url: URL) => string | null) {
	await ctx.route(/^https:\/\/(www\.(youtube|tiktok|instagram|facebook)\.com)\//, (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.startsWith('/__fixture__/')) return route.fulfill({ contentType: 'text/css', body: fixture(`styles/${url.pathname.slice(13)}`) });
		const custom = extra?.(url);
		if (custom) return route.fulfill({ contentType: 'text/html', body: custom });
		const hit = SITES[url.hostname]?.find(([re]) => re.test(url.pathname));
		if (!hit || route.request().resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
		return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(`${hit[1]}.html`) });
	});
}

export interface Ext {
	ctx: BrowserContext;
	sw: Worker;
	api: MockApi;
	/** An extension page kept open to talk to the service worker. */
	ctl: Page;
	send<T = unknown>(m: unknown): Promise<T>;
	storage<T = unknown>(key: string): Promise<T>;
	setup(o?: { platforms?: Platform[]; strictness?: string; settings?: Record<string, unknown> }): Promise<void>;
	open(url: string, o?: { dark?: boolean; html?: string }): Promise<Page>;
	tabId(page: Page): Promise<number>;
	pageState(page: Page): Promise<any>;
}

export const test = base.extend<{ ext: Ext }>({
	ext: async ({ colorScheme, reducedMotion }, use) => {
		const ctx = await chromium.launchPersistentContext('', {
			channel: 'chromium',
			headless: true,
			colorScheme: colorScheme ?? 'light',
			reducedMotion: reducedMotion ?? 'no-preference',
			viewport: { width: 1280, height: 900 },
			// Nothing leaves the machine: routes answer for the platforms and the API, and a request they
			// do not catch (a tab the extension opens can navigate before routing attaches) fails to resolve.
			args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--host-resolver-rules=MAP * ~NOTFOUND']
		});
		const api = new MockApi();
		await ctx.route(`${API}/**`, (r) => api.handle(r));
		await serveSites(ctx);
		const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
		const ctl = await ctx.newPage();
		await ctl.goto(`chrome-extension://${EXT_ID}/options.html`);
		const ext: Ext = {
			ctx,
			sw,
			api,
			ctl,
			send: <T,>(m: unknown) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), m) as Promise<T>,
			storage: <T,>(key: string) => ctl.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>,
			async setup(o = {}) {
				for (const p of o.platforms ?? ['yt']) await ext.send({ type: 'set-platform', platform: p, on: true });
				await ext.send({ type: 'settings', patch: { onboarded: true, strictness: o.strictness ?? 'standard', ...o.settings } });
				await ext.send({ type: 'sync-now' });
				await expect.poll(() => ext.storage<{ sequence: number }>('listIndex').then((i) => i?.sequence)).toBe(42);
			},
			async open(url, o = {}) {
				const page = await ctx.newPage();
				if (o.dark || o.html) {
					const u = new URL(url);
					const name = SITES[u.hostname]?.find(([re]) => re.test(u.pathname))?.[1];
					let body = o.html ?? (name ? fixtureHtml(name) : '');
					if (o.dark) body = body.replace('<html lang="en">', '<html lang="en" dark>');
					await page.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
				}
				await page.goto(url);
				await page.waitForSelector('[data-colander-card]', { state: 'attached' });
				return page;
			},
			tabId: (page) => ctl.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, page.url()),
			pageState: (page) =>
				ctl.evaluate(async (url) => {
					const [tab] = await chrome.tabs.query({ url });
					return chrome.tabs.sendMessage(tab!.id!, { type: 'page-state' });
				}, page.url())
		};
		// First run writes the install's stats once; a test that seeds stats before that write would
		// race it (and lose under load), so tests start after it.
		await expect.poll(() => ext.storage('stats'), { timeout: 15_000 }).toBeTruthy();
		await use(ext);
		await ctx.close();
	}
});

/** A review queue entry and its source, for the side panel (contract 6.7). */
export const REVIEW_QUEUE = () => [{ id: 'q_1', kind: 'report', priority: 2, created_at: new Date(Date.now() - 3600_000).toISOString(), platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', summary: '3 reports: staged rescue narration', large: false, verdict: 'likely_slop', computed_verdict: 'slop', report_count: 3 }];

export const REVIEW_SOURCE = {
	source: {
		platform: 'yt', id: '@catrescuetales', aliases: ['UCbbbbbbbbbbbbbbbbbbbbbb', '@catrescuetales'], name: 'Cat Rescue Tales', verdict: 'likely_slop',
		signals: ['mostly_ai', 'rubric_hollow'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'], large: false, audience_known: false, imported: true, appeal_open: false,
		updated_at: '2026-08-01T00:00:00Z', rescore_at: '2026-10-30T00:00:00Z',
		evidence: { taggers: 41, tags: { slop: 35, ai_fine: 4, not_slop: 2 }, items_seen: 23, ai_item_share: 0.91, uploads_per_day: null }
	},
	layers: {
		provenance: { met: true, signals: ['platform_label'], detail: '6 installs saw the platform label on its items.' },
		behavior: { met: true, signals: ['mostly_ai', 'high_volume'], detail: '91% of 23 recent items carry AI evidence.' },
		rubric: { met: true, signals: ['rubric_hollow'], detail: 'Taggers found it hollow and mass-produced.' },
		consensus: { met: false, signals: [], detail: 'Consensus is still forming: 35 of 41 weighted tags say slop.' }
	},
	reports: [{ id: 'rpt_1', platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', reason: 'Staged rescue videos made with AI, posted every hour.', examples: ['dQw4w9WgXcQ'], slop_type: 'deceptive', tests: ['hollow'] }],
	appeals: [],
	items: [{ platform: 'yt', id: 'dQw4w9WgXcQ', verdict: null, signals: [], tags: { slop: 5, ai_fine: 0, not_slop: 0 }, platform_label_reports: 2 }],
	history: [{ id: 'log_1', at: '2026-08-01T00:00:00Z', platform: 'yt', target_type: 'source', target_id: '@catrescuetales', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', from: null, to: 'likely_slop', reason: 'Most recent items carry AI evidence, and community tags agree.', signals: ['mostly_ai'], actor: 'community', actor_name: null }]
};

export { expect };

/** Elements inside open shadow roots, by the host kind. */
export const ui = (page: Page, kind: string) => page.locator(`colander-ui[data-kind="${kind}"]`);
