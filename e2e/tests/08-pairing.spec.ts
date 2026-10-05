// Journey 10: a member with Plus connects the extension with a pairing code from the account page.
// The code works once, the plan token is the account's own, and settings sync starts with it.
import { CARD, SEARCH, card, expect, launch, onboard, pairWith, signIn, test, type Ext } from './harness.ts';
import { BASE_URL, LOCAL_ONLY, ORIGIN, PLUS_MEMBER, api } from './stack.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

test('a Plus code from the account page turns Plus on in the extension, once', async () => {
	const site = await ext.ctx.newPage();
	await signIn(site, PLUS_MEMBER, '/account');
	await expect(site.getByText('Signed in as pat@colander.test')).toBeVisible();
	const account = (await site.evaluate(async () => (await (await fetch('/v1/account')).json()) as { account: { id: string } })).account;

	const options = await ext.page('options.html#plan');
	await expect(options.getByRole('heading', { level: 2, name: 'Current plan: Free' })).toBeVisible();
	const connect = site.locator('section', { has: site.getByRole('heading', { name: 'Connect a browser' }) });
	const code = await pairWith(site, connect, options);
	await expect(options.getByRole('heading', { level: 2, name: 'Plus, active' })).toBeVisible();
	await expect(connect.getByText('Connected Colander 1.0.0 in a Chromium browser.')).toBeVisible();
	await expect(connect.getByText('Plus is on there.')).toBeVisible();

	// The server minted a paid token for this account, not a trial.
	const token = await ext.storage<string>('planToken');
	const claims = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { sub: string; trial: boolean; exp: number };
	expect(claims).toMatchObject({ sub: account.id, trial: false });
	expect(claims.exp).toBeGreaterThan(Date.now() / 1000 + 200 * 86_400);
	// Settings sync starts with the paired plan: the account has a copy now.
	await expect.poll(async () => (await api<{ version: number }>('/v1/sync', { auth: `Plan ${token}` })).json.version).toBeGreaterThan(0);

	// Plus applies on the page: per-platform strictness is open.
	await options.goto(options.url().replace(/#.*/, '#strictness'));
	await options.getByRole('radiogroup', { name: 'YouTube strictness' }).getByRole('radio', { name: 'No AI' }).click();
	const page = await ext.youtube(SEARCH);
	await expect(card(page, CARD.aiMade)).toHaveAttribute('data-colander', 'hide');

	// The code works once.
	const again = await api<{ error: { code: string } }>('/v1/pair/claim', { body: { code, ext_version: '1.0.0', browser: 'chromium' } });
	expect(again.status).toBe(404);
	expect(again.json.error.code).toBe('invalid_code');
});
