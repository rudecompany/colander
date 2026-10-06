// Journey 10: a member with Plus connects the extension with a pairing code from the account page.
// The code works once, the plan token is the account's own, and settings sync starts with it.
import { CARD, SEARCH, card, expect, launch, onboard, pairWith, signIn, test, type Ext } from './harness.ts';
import { BASE_URL, LOCAL_ONLY, ORIGIN, PLUS_MEMBER, api, type Reply } from './stack.ts';

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
	// Whose account it is, so a code someone else handed over would show.
	await expect(options.getByText('Plus is on in this browser, connected to the account p***@colander.test. Renewal and billing are on the website.')).toBeVisible();
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

// Settings versions count per account: a trial that counted further than the account's copy must
// not keep that copy from arriving, nor overwrite it on the next change.
test("pairing after a trial takes the account's settings, however far the trial counted", async () => {
	// The first journey left YouTube at No AI on Pat's account.
	const auth = `Plan ${await ext.storage<string>('planToken')}`;
	let account!: Reply<{ version: number; data: { strictness: string; perPlatform: Record<string, string> } }>;
	await expect.poll(async () => (account = await api('/v1/sync', { auth })).json.data?.perPlatform?.yt).toBe('no_ai');

	const other = await launch();
	try {
		await onboard(other);
		const options = await other.page('options.html#plan');
		await options.getByRole('button', { name: 'Start 14 days free' }).click();
		await expect(options.getByRole('heading', { level: 2, name: 'Plus trial, active' })).toBeVisible();
		// The trial syncs its own copy past the account's version, ending on Label.
		const version = () => other.storage<{ version: number } | undefined>('syncState').then((s) => s?.version ?? 0);
		const set = async (strictness: string) => {
			const before = await version();
			await options.evaluate(async (strictness) => {
				const { settings } = (await chrome.storage.local.get('settings')) as { settings: Record<string, unknown> };
				await chrome.storage.local.set({ settings: { ...settings, strictness } });
			}, strictness);
			await expect.poll(version).toBeGreaterThan(before);
		};
		for (let next = 'no_ai'; (await version()) < account.json.version; next = next === 'no_ai' ? 'standard' : 'no_ai') await set(next);
		await set('label');
		expect(await version()).toBeGreaterThan(account.json.version);

		const site = await other.ctx.newPage();
		await signIn(site, PLUS_MEMBER, '/account');
		await pairWith(site, site.locator('section', { has: site.getByRole('heading', { name: 'Connect a browser' }) }), options);
		await expect(options.getByRole('heading', { level: 2, name: 'Plus, active' })).toBeVisible();
		// The account's copy arrives: its strictness and its YouTube level, not the trial's.
		await expect.poll(() => other.storage<{ strictness: string; perPlatform: Record<string, string> }>('settings')).toMatchObject({ strictness: account.json.data.strictness, perPlatform: { yt: 'no_ai' } });
		const after = await api<{ data: { strictness: string } }>('/v1/sync', { auth: `Plan ${await other.storage<string>('planToken')}` });
		expect(after.json.data.strictness).toBe(account.json.data.strictness);
	} finally {
		await other.close();
	}
});
