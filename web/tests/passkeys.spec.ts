// Passkeys, step-up and account data in the browser (docs/contracts.md 6.6), with a Chromium
// virtual authenticator answering the WebAuthn prompts against mocked Worker answers.
import { test, expect, virtualAuthenticator } from './fixtures.ts';
import { ACCOUNT, CREATION_OPTIONS, CURATOR, CURATOR_NEW, ME, PASSKEYS, PLUS_ACCOUNT, QUEUE, REQUEST_OPTIONS, STAFF, mockApi, reviewSource } from './mocks.ts';

const err = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });
const WITH_PASSKEY = { ...ACCOUNT, passkey_count: 1 };

test('adds a passkey with the browser, then signs in with it', async ({ page }) => {
	const authenticator = await virtualAuthenticator(page);
	let signedIn = true;
	let list: typeof PASSKEYS = [];
	const calls = await mockApi(page, {
		'GET /v1/account': () => (signedIn ? { json: { account: list.length ? WITH_PASSKEY : ACCOUNT } } : err(401, 'signed_out', 'Sign in.')),
		'GET /v1/account/passkeys': () => ({ json: { passkeys: list, current: null } }),
		'POST /v1/account/passkeys/options': { json: { options: CREATION_OPTIONS } },
		'POST /v1/account/passkeys': (c) => {
			list = [{ id: 'pk_new', name: c.body.name, created_at: '2026-10-05T10:00:00Z', last_used_at: null, synced: false }];
			return { status: 201, json: { passkey: list[0] } };
		},
		'POST /v1/auth/logout': () => ((signedIn = false), { status: 204 }),
		'POST /v1/auth/passkey/verify': () => ((signedIn = true), { json: { account: { ...WITH_PASSKEY, session: { method: 'passkey', authenticated_at: new Date().toISOString() } } } })
	});
	await page.goto('/account');
	await expect(page.getByText('No passkeys yet.')).toBeVisible();
	await page.getByLabel('Name for the new passkey').fill('Work laptop');
	await page.getByRole('button', { name: 'Add a passkey' }).click();
	await expect(page.getByText('Passkey added.', { exact: false })).toBeVisible();
	await expect(page.getByText('Work laptop', { exact: true })).toBeVisible();
	const created = calls.find((c) => c.method === 'POST' && c.path === '/v1/account/passkeys')!;
	expect(created.body).toMatchObject({ name: 'Work laptop', credential: { type: 'public-key', response: { attestationObject: expect.any(String) } } });
	// The browser made a discoverable credential, the kind that signs in without an email.
	expect((await authenticator.credentials()).map((c) => c.isResidentCredential)).toEqual([true]);

	// Until someone touches the authenticator, the email field's passkey autofill waits.
	await authenticator.presence(false);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	await authenticator.presence(true);
	await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello, Maya');
	await expect(page.getByText('You signed in with a passkey.')).toBeVisible();
	const verify = calls.find((c) => c.path === '/v1/auth/passkey/verify')!;
	expect(verify.body.credential).toMatchObject({ id: expect.any(String), response: { authenticatorData: expect.any(String), signature: expect.any(String) } });
	expect(verify.headers['x-colander-csrf']).toBe('1');
});

test('asks for the passkey before removing one, and offers the 72-hour wait without it', async ({ page }) => {
	await virtualAuthenticator(page, { withPasskey: true });
	let stepped = false;
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: { ...ACCOUNT, passkey_count: 2 } } },
		'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS, current: null } },
		'DELETE /v1/account/passkeys/*': () => (stepped ? { status: 204 } : err(403, 'passkey_required', 'Confirm it is you with a passkey to do this.')),
		'POST /v1/auth/passkey/options': { json: { options: REQUEST_OPTIONS } },
		'POST /v1/auth/passkey/verify': () => ((stepped = true), { json: { account: { ...ACCOUNT, passkey_count: 2, session: { method: 'passkey', authenticated_at: new Date().toISOString() } } } }),
		'POST /v1/account/requests': { status: 201, json: { request: { id: 'req_1', kind: 'remove_passkey', created_at: '2026-10-05T10:00:00Z', due_at: '2026-10-08T10:00:00Z', done_at: null } } }
	});
	await page.goto('/account');
	await page.getByRole('button', { name: 'Remove Security key' }).click();
	const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
	await expect(dialog).toBeVisible();
	// Closing the prompt gives up: the passkey stays, and the wait is offered instead.
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByText('This needs your passkey')).toBeVisible();
	await page.getByRole('button', { name: 'Remove it in 72 hours' }).click();
	await expect(page.getByText('We will remove it in 72 hours', { exact: false })).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/account/requests')!.body).toEqual({ kind: 'remove_passkey', passkey_id: 'pk_key' });

	// With the passkey at hand, one touch and the removal goes through.
	await page.getByRole('button', { name: 'Remove Security key' }).click();
	await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Use my passkey' }).click();
	await expect(page.getByText('Security key no longer signs in to your account.')).toBeVisible();
	expect(calls.filter((c) => c.method === 'DELETE').length).toBe(3);
});

test('confirms by emailed code when the account has no passkey, then downloads the data', async ({ page }) => {
	let fresh = false;
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: ACCOUNT } },
		'GET /v1/account/export': () => (fresh ? { json: { account: { email: ACCOUNT.email } } } : err(403, 'recent_auth_required', 'Confirm it is you to do this.')),
		'POST /v1/auth/code': { status: 202 },
		'POST /v1/auth/code/verify': () => ((fresh = true), { json: { account: ACCOUNT } })
	});
	await page.goto('/account');
	await page.getByRole('button', { name: 'Download my data' }).click();
	const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
	await dialog.getByRole('button', { name: 'Email me a code' }).click();
	await dialog.getByLabel('Code').fill('123456');
	const download = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Confirm' }).click();
	expect((await download).suggestedFilename()).toBe('colander-account.json');
	await expect(page.getByText('Your data is downloading as colander-account.json.')).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/auth/code')!.body).toEqual({ email: 'maya@example.com', next: '/account' });
});

test('deletes the account behind a confirmation that says what happens to Plus', async ({ page }) => {
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: PLUS_ACCOUNT } },
		'DELETE /v1/account': { status: 204 }
	});
	await page.goto('/account');
	await page.getByRole('button', { name: 'Delete account' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete your Colander account?' });
	await expect(dialog).toContainText('Plus ends now, and your last charge is refunded.');
	await dialog.getByRole('button', { name: 'Keep my account' }).click();
	await expect(dialog).toBeHidden();
	expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
	await page.getByRole('button', { name: 'Delete account' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Delete my account' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	expect(calls.find((c) => c.method === 'DELETE')!.headers['x-colander-csrf']).toBe('1');
});

test('tells a reviewer that the account holds their decisions and labels, and what deleting does to each', async ({ page }) => {
	await mockApi(page, { 'GET /v1/account': { json: { account: CURATOR } } });
	await page.goto('/account');
	const data = page.getByRole('region', { name: 'Your data' });
	await expect(data).toContainText('Your account holds your email, display name, sign-ins, passkeys, plan, synced settings, decisions and calibration labels.');
	await page.getByRole('button', { name: 'Delete account' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete your Colander account?' });
	await expect(dialog).toContainText('We erase the labels you gave in the calibration set.');
	await expect(dialog).toContainText('Your decisions stay in the public decision log without your name.');
});

test('tells a member nothing about reviewing', async ({ page }) => {
	await mockApi(page, { 'GET /v1/account': { json: { account: ACCOUNT } } });
	await page.goto('/account');
	await expect(page.getByRole('region', { name: 'Your data' })).toContainText('Your account holds your email, display name, sign-ins, passkeys, plan and synced settings.');
	await page.getByRole('button', { name: 'Delete account' }).click();
	await expect(page.getByRole('dialog', { name: 'Delete your Colander account?' })).not.toContainText('calibration');
});

test('signs out everywhere', async ({ page }) => {
	const calls = await mockApi(page, { 'GET /v1/account': { json: { account: ACCOUNT } }, 'POST /v1/auth/logout': { status: 204 } });
	await page.goto('/account');
	await page.getByRole('button', { name: 'Sign out everywhere' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
	expect(calls.find((c) => c.path === '/v1/auth/logout')!.body).toEqual({ everywhere: true });
});

test('an invite adds a reviewer passkey after an email sign-in, and keeps the secret out of the address bar', async ({ page }) => {
	await virtualAuthenticator(page);
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: CURATOR_NEW } },
		'POST /v1/auth/invite/options': { json: { options: CREATION_OPTIONS } },
		'POST /v1/auth/invite/verify': { json: { account: { ...CURATOR_NEW, passkey_count: 1, session: { method: 'passkey', authenticated_at: new Date().toISOString() } } } }
	});
	await page.goto('/account/invite#invite=inv_abc');
	await expect(page).toHaveURL(/\/account\/invite$/);
	await expect(page.getByText('Signed in as lee@example.com.', { exact: false })).toBeVisible();
	await page.getByLabel('Name for this passkey').fill('Desk');
	await page.getByRole('button', { name: 'Add my passkey' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your passkey is ready');
	expect(calls.find((c) => c.path === '/v1/auth/invite/options')!.body).toEqual({ invite: 'inv_abc' });
	expect(calls.find((c) => c.path === '/v1/auth/invite/verify')!.body).toMatchObject({ invite: 'inv_abc', name: 'Desk', credential: { type: 'public-key' } });
	await expect(page.getByRole('link', { name: 'Open the review console' })).toHaveAttribute('href', '/console');
});

test('an invite that does not fit the account says why', async ({ page }) => {
	await virtualAuthenticator(page);
	await mockApi(page, {
		'GET /v1/account': { json: { account: CURATOR_NEW } },
		'POST /v1/auth/invite/options': err(400, 'invite_invalid', 'This invite does not work.')
	});
	await page.goto('/account/invite#invite=inv_abc');
	await page.getByRole('button', { name: 'Add my passkey' }).click();
	await expect(page.getByRole('alert')).toContainText('it expired, was used, or was sent for another address');
});

test('the cancel link cancels only when asked, so a mail scanner opening it changes nothing', async ({ page }) => {
	const calls = await mockApi(page, { 'POST /v1/auth/cancel': { json: { cancelled: 'delete' } } });
	await page.goto('/account/cancel#s3cr3t');
	await expect(page).toHaveURL(/\/account\/cancel$/);
	expect(calls.filter((c) => c.path === '/v1/auth/cancel')).toEqual([]);
	await page.getByRole('button', { name: 'Cancel the request' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cancelled');
	await expect(page.getByText('We stopped deleting the account.', { exact: false })).toBeVisible();
	expect(calls.find((c) => c.path === '/v1/auth/cancel')!.body).toEqual({ secret: 's3cr3t' });
});

test('a reviewer who signed in with a code confirms with their passkey before adding one, and a device that holds one already hears so plainly', async ({ page }) => {
	const device = await virtualAuthenticator(page, { withPasskey: true });
	const held = Buffer.from((await device.credentials())[0]!.credentialId, 'base64').toString('base64url');
	const reviewer = { ...CURATOR, passkey_count: 1, session: { method: 'email' as const, authenticated_at: new Date().toISOString() } };
	let stepped = false;
	await mockApi(page, {
		'GET /v1/account': { json: { account: reviewer } },
		'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS.slice(0, 1), current: null } },
		// The server asks for the passkey (not an invite), and then excludes the one this device holds.
		'POST /v1/account/passkeys/options': () =>
			stepped
				? { json: { options: { ...CREATION_OPTIONS, excludeCredentials: [{ type: 'public-key', id: held }] } } }
				: err(403, 'passkey_required', 'Confirm it is you with a passkey to do this.'),
		'POST /v1/auth/passkey/verify': () => ((stepped = true), { json: { account: { ...reviewer, session: { method: 'passkey', authenticated_at: new Date().toISOString() } } } })
	});
	await page.goto('/account');
	await page.getByLabel('Name for the new passkey').fill('Phone');
	await page.getByRole('button', { name: 'Add a passkey' }).click();
	await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Use my passkey' }).click();
	await expect(page.getByText('This device already holds a passkey for your account.', { exact: false })).toBeVisible();
	await expect(page.getByText('Something went wrong')).toHaveCount(0);
	await expect(page.getByText('with an invite from an admin')).toHaveCount(0);
});

test('the console asks curators for a passkey sign-in first, and shows staff the way to the admin console', async ({ page, baseURL }) => {
	await virtualAuthenticator(page, { withPasskey: true });
	const review = {
		'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
		'GET /v1/review/sources/*': { json: reviewSource('tt:@historybites247') }
	};
	await mockApi(page, {
		'GET /v1/account': { json: { account: { ...CURATOR, session: { method: 'email', authenticated_at: new Date().toISOString() } } } },
		'POST /v1/auth/passkey/verify': { json: { account: CURATOR } },
		...review
	});
	await page.goto('/console');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Confirm with your passkey');
	await page.getByRole('button', { name: 'Use my passkey' }).click();
	await expect(page.getByRole('button', { name: /Ancient Facts Daily/ })).toBeVisible();

	const fresh = await page.context().newPage();
	await mockApi(fresh, { 'GET /v1/account': { json: { account: { ...CURATOR_NEW } } } });
	await fresh.goto('/console');
	await expect(fresh.getByText('Your account has no passkey yet')).toBeVisible();

	const staff = await page.context().newPage();
	await mockApi(staff, { 'GET /v1/account': { json: { account: STAFF } }, 'GET /v1/admin/me': { json: ME }, ...review });
	await staff.goto('/console');
	await expect(staff.getByText('You review as a curator here')).toBeVisible();
	// Which seed lists name a lead is staff authority, which only the admin host gives.
	await expect(staff.getByText('Large sources, appeals, the seed lists behind a lead, and people are in the', { exact: false })).toBeVisible();
	await expect(staff.getByText('Curator, Sam')).toBeVisible();
	// The link leaves the site's router for the admin host, where Access signs staff in.
	const admin = `${baseURL!.replace('//localhost', '//admin.localhost')}/admin`;
	await expect(staff.getByRole('link', { name: 'admin console' })).toHaveAttribute('href', admin);
	await staff.getByRole('link', { name: 'admin console' }).click();
	await expect(staff).toHaveURL(admin);
	await expect(staff.getByRole('navigation', { name: 'Admin console' })).toBeVisible();
	// So does the account page's button. A staff account stays open, so the page offers no deletion.
	await staff.goto(`${baseURL}/account`);
	await expect(staff.getByText('Staff and admin accounts stay open until an admin lowers the role on the admin host.', { exact: false })).toBeVisible();
	await expect(staff.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
	await staff.getByRole('link', { name: 'Open the admin console' }).click();
	await expect(staff).toHaveURL(admin);
});
