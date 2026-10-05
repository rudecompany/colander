// Full-page screenshots of every page, desktop 1440 and mobile 390, light and dark.
// Run with `pnpm screenshots` (writes to screenshots/). Skipped in the normal test run.
import { test } from '@playwright/test';
import { mockApi, PLUS_ACCOUNT, STAFF, APPEAL, QUEUE, reviewSource } from './mocks.ts';

test.skip(!process.env.SCREENSHOTS, 'Set SCREENSHOTS=1 to capture screenshots.');

const out = process.env.SCREENSHOTS_DIR ?? 'screenshots';

type Shot = { name: string; path: string; setup?: Parameters<typeof mockApi>[1]; after?: (page: import('@playwright/test').Page) => Promise<void> };

const shots: Shot[] = [
	{ name: 'landing', path: '/' },
	{ name: 'definition', path: '/definition' },
	{ name: 'source-slop', path: '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ' },
	{ name: 'source-likely-slop', path: '/s/tt/@historybites247' },
	{ name: 'source-ai-made', path: '/s/ig/studiolumen' },
	{ name: 'source-disputed', path: '/s/yt/@numisnotes' },
	{ name: 'source-clear', path: '/s/fb/104729388112' },
	{ name: 'source-not-rated', path: '/s/yt/@someunknownchannel' },
	{ name: 'appeal-start', path: '/appeal/tt/@historybites247' },
	{
		name: 'appeal-status-awaiting',
		path: '/appeal/status/apl_4k9x2m?secret=s3cret',
		setup: { 'GET /v1/appeals/*': { json: { appeal: APPEAL } } }
	},
	{
		name: 'appeal-status-under-review',
		path: '/appeal/status/apl_4k9x2m?secret=s3cret',
		setup: { 'GET /v1/appeals/*': { json: { appeal: { ...APPEAL, status: 'under_review', verified_at: '2026-10-02T21:10:00Z' } } } }
	},
	{ name: 'log', path: '/log' },
	{ name: 'plans', path: '/plans' },
	{
		name: 'plans-welcome',
		path: '/plans/welcome',
		setup: { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } },
		after: async (page) => {
			await page.getByRole('heading', { name: 'Connect a browser' }).waitFor();
		}
	},
	{ name: 'support', path: '/support' },
	{ name: 'support-thanks', path: '/support/thanks' },
	{ name: 'supporters', path: '/supporters' },
	{ name: 'transparency', path: '/transparency' },
	{ name: 'account-signed-out', path: '/account' },
	{ name: 'account-plus', path: '/account', setup: { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } } },
	{
		name: 'account-staff',
		path: '/account',
		setup: { 'GET /v1/account': { json: { account: { ...STAFF, plan: PLUS_ACCOUNT.plan } } } }
	},
	{
		// A pairing code on screen, waiting for the extension, then a reviewer code already taken.
		name: 'account-codes',
		path: '/account',
		setup: {
			'GET /v1/account': { json: { account: { ...STAFF, plan: PLUS_ACCOUNT.plan } } },
			'POST /v1/pair': (c) => ({
				status: 201,
				json: { id: `pair_${c.body.kind}`, code: c.body.kind === 'plan' ? 'KXQ4-JP7M' : 'RVW4-2K9P', expires_at: new Date(Date.now() + 600_000).toISOString() }
			}),
			'GET /v1/pair/*': (c) => ({
				json: c.path.endsWith('pair_reviewer') ? { status: 'claimed', ext_version: '1.0.0', browser: 'firefox' } : { status: 'pending', ext_version: null, browser: null }
			})
		},
		after: async (page) => {
			await page.getByRole('button', { name: 'Show a code' }).first().click();
			await page.getByText('KXQ4-JP7M').waitFor();
			await page.getByRole('button', { name: 'Show a code' }).click();
			await page.getByText('Connected Colander 1.0.0 in Firefox.').waitFor();
			// The full-page picture starts at the top, so the sticky header sits where it belongs.
			await page.evaluate(() => scrollTo(0, 0));
		}
	},
	{
		name: 'console',
		path: '/console',
		setup: {
			'GET /v1/account': { json: { account: STAFF } },
			'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
			'GET /v1/review/sources/*': (c) => {
				const [, , , , p, id] = c.path.split('/');
				return { json: reviewSource(`${p}:${decodeURIComponent(id)}`) };
			}
		},
		after: async (page) => {
			await page.getByRole('button', { name: /History Bites/ }).click();
			await page.getByRole('heading', { name: 'History Bites 24/7', level: 2 }).waitFor();
		}
	},
	{ name: 'privacy', path: '/privacy' },
	{ name: 'terms', path: '/terms' },
	{ name: 'not-found', path: '/no-such-page' }
];

const variants = [
	{ id: 'desktop', width: 1440, height: 900 },
	{ id: 'mobile', width: 390, height: 844 }
];

for (const shot of shots) {
	for (const v of variants) {
		for (const scheme of ['light', 'dark'] as const) {
			test(`${shot.name} ${v.id} ${scheme}`, async ({ page }) => {
				await page.setViewportSize({ width: v.width, height: v.height });
				await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
				await mockApi(page, shot.setup);
				await page.goto(shot.path);
				await page.waitForLoadState('networkidle');
				await page.evaluate(() => document.fonts.ready);
				if (shot.after) await shot.after(page);
				await page.screenshot({ path: `${out}/${shot.name}-${v.id}-${scheme}.png`, fullPage: true });
			});
		}
	}
}
