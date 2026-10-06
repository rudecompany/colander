// Full-page screenshots of every page, desktop 1440 and mobile 390, light and dark.
// Run with `pnpm screenshots` (writes to screenshots/). Skipped in the normal test run.
import { test } from '@playwright/test';
import { mockApi, PLUS_ACCOUNT, STAFF, CURATOR, CURATOR_NEW, PASSKEYS, ME, PEOPLE, AUDIT, APPEAL, QUEUE, reviewSource } from './mocks.ts';

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
	{
		name: 'account-code',
		path: '/account',
		setup: { 'POST /v1/auth/code': { status: 204 } },
		after: async (page) => {
			await page.getByLabel('Email', { exact: true }).fill('maya@example.com');
			await page.getByRole('button', { name: 'Email me a code' }).click();
			await page.getByLabel('Code', { exact: true }).waitFor();
		}
	},
	{
		name: 'account-plus',
		path: '/account',
		setup: {
			'GET /v1/account': { json: { account: { ...PLUS_ACCOUNT, passkey_count: 2 } } },
			// This session signed in with an email code, so no passkey is this sign-in's.
			'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS, current: null } }
		}
	},
	{
		name: 'account-staff',
		path: '/account',
		setup: {
			'GET /v1/account': { json: { account: { ...STAFF, plan: PLUS_ACCOUNT.plan } } },
			'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS.slice(0, 1), current: 'pk_laptop' } }
		}
	},
	{ name: 'account-invite', path: '/account/invite#invite=inv_test', setup: { 'GET /v1/account': { json: { account: CURATOR_NEW } } } },
	{ name: 'account-cancel', path: '/account/cancel#cancel-secret' },
	{ name: 'console-passkey-needed', path: '/console', setup: { 'GET /v1/account': { json: { account: CURATOR_NEW } } } },
	{
		// A pairing code on screen, waiting for the extension, then a reviewer code already taken.
		name: 'account-codes',
		path: '/account',
		setup: {
			// The side panel's connection that the reviewer code just made.
			'GET /v1/account': { json: { account: { ...STAFF, plan: PLUS_ACCOUNT.plan, reviewer_token: { expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), last_used_at: null } } } },
			'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS.slice(0, 1), current: 'pk_laptop' } },
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
			'GET /v1/account': { json: { account: CURATOR } },
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
	{
		name: 'admin',
		path: '/admin',
		setup: {
			'GET /v1/admin/me': { json: ME },
			'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
			'GET /v1/review/sources/*': (c) => {
				const [, , , , p, id] = c.path.split('/');
				return { json: reviewSource(`${p}:${decodeURIComponent(id)}`) };
			}
		},
		after: async (page) => {
			await page.getByRole('button', { name: /Ancient Facts Daily/ }).click();
			await page.getByRole('heading', { name: 'Ancient Facts Daily', level: 2 }).waitFor();
		}
	},
	{ name: 'admin-people', path: '/admin/people', setup: { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/people': { json: { people: PEOPLE } } } },
	{ name: 'admin-audit', path: '/admin/audit', setup: { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/audit': { json: { entries: AUDIT, next_cursor: null } } } },
	{
		name: 'admin-not-staff',
		path: '/admin',
		setup: { 'GET /v1/admin/me': { status: 403, json: { error: { code: 'not_staff', message: 'This Access identity is not a Colander staff account.' } } } }
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
