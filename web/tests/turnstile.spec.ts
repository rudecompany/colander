// Code sign-in with Turnstile on (docs/deploy.md step 6b), against the build that carries
// Turnstile's always-pass test site key. challenges.cloudflare.com is never reached: a stand-in
// script hands out numbered tokens, and fails loudly when the page resets a widget whose element
// is gone, as the real one does. Each token works once at Siteverify, so every code request
// must carry a token no other request used.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.ts';
import { ACCOUNT, mockApi } from './mocks.ts';

const err = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

/** The stand-in for api.js: render, reset and remove, with a new token shortly after each render or reset. */
const FAKE_TURNSTILE = `
(() => {
	let issued = 0;
	const widgets = new Map();
	const issue = (id) => setTimeout(() => widgets.get(id)?.callback('test-token-' + ++issued), 30);
	window.turnstile = {
		render(el, options) {
			const id = 'widget-' + widgets.size;
			widgets.set(id, { el, callback: options.callback });
			issue(id);
			return id;
		},
		reset(id) {
			const w = widgets.get(id);
			if (!w || !w.el.isConnected) throw new Error('Turnstile: reset on a widget that is no longer in the page');
			issue(id);
		},
		remove(id) {
			widgets.delete(id);
		}
	};
})();
`;

async function fakeTurnstile(page: Page): Promise<string[]> {
	const loads: string[] = [];
	await page.route('https://challenges.cloudflare.com/**', (route) => {
		loads.push(route.request().url());
		return route.fulfill({ contentType: 'text/javascript', body: FAKE_TURNSTILE });
	});
	return loads;
}

test('every code request carries its own token: the first email, a new code, another address and a step-up', async ({ page }) => {
	const loads = await fakeTurnstile(page);
	let signedIn = false;
	let fresh = false;
	const calls = await mockApi(page, {
		'POST /v1/auth/code': (c) => (c.body.turnstile ? { status: 202 } : err(400, 'turnstile_failed', 'We could not check that this request came from a person. Try again.')),
		'POST /v1/auth/code/verify': () => {
			fresh = signedIn;
			signedIn = true;
			return { json: { account: ACCOUNT } };
		},
		'GET /v1/account': () => (signedIn ? { json: { account: ACCOUNT } } : err(401, 'signed_out', 'Sign in.')),
		'GET /v1/account/export': () => (fresh ? { json: { account: { email: ACCOUNT.email } } } : err(403, 'recent_auth_required', 'Confirm it is you to do this.'))
	});

	await page.goto('/account');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	// Nothing loads from Cloudflare until the person starts on the form.
	await page.waitForLoadState('networkidle');
	expect(loads).toEqual([]);

	const email = page.getByLabel('Email');
	await email.fill('maya@example.com');
	await page.getByRole('button', { name: 'Email me a code' }).click();
	await expect(page.getByText('We emailed a 6-digit code to maya@example.com.', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Send a new code' }).click();
	await expect(page.getByText('We sent a new code to maya@example.com.', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Use a different address' }).click();
	await email.fill('maya.other@example.com');
	await page.getByRole('button', { name: 'Email me a code' }).click();
	await expect(page.getByText('We emailed a 6-digit code to maya.other@example.com.', { exact: false })).toBeVisible();
	await expect(page.getByText('Something went wrong')).toHaveCount(0);

	await page.getByLabel('Code').fill('123456');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello, Maya');

	// Ten minutes later: the step-up asks for a code with a token of its own.
	await page.getByRole('button', { name: 'Download my data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
	await dialog.getByRole('button', { name: 'Email me a code' }).click();
	await dialog.getByLabel('Code').fill('123456');
	const download = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Confirm' }).click();
	expect((await download).suggestedFilename()).toBe('colander-account.json');

	const sent = calls.filter((c) => c.path === '/v1/auth/code').map((c) => c.body as { email: string; turnstile: string });
	expect(sent.map((b) => b.email)).toEqual(['maya@example.com', 'maya@example.com', 'maya.other@example.com', 'maya@example.com']);
	const tokens = sent.map((b) => b.turnstile);
	expect(tokens.every((t) => /^test-token-\d+$/.test(t))).toBe(true);
	expect(new Set(tokens).size, `tokens ${tokens.join(', ')}`).toBe(4);
	expect(loads.length).toBeGreaterThan(0);
});
