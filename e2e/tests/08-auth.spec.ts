// Journey 10: signing in (docs/contracts.md 6.6 and 6.9). A member signs in with an emailed code,
// adds a passkey and signs in with it; a new curator gets member rights from a code until an invite
// adds a passkey; staff work on the admin host behind dev mode's stand-in for Cloudflare Access,
// whose token opens nothing on the main host.
import { ADMIN, BASE_URL, LOCAL_ONLY, ORIGIN, STAFF, adminHttp, adminOrigin, api, apiSignIn, devAccess, logMark, mailsSince } from './stack.ts';
import { adminSignIn, enrollReviewer, expect, launch, passkeyDevice, signIn, test, type Ext } from './harness.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
});
test.afterAll(async () => {
	await ext?.close();
});

test('a member signs in with an emailed code, adds a passkey, and signs in with it', async () => {
	const email = `member.${Date.now()}@example.test`;
	const page = await ext.ctx.newPage();
	const device = await passkeyDevice(page);
	await signIn(page, email, '/account');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your account');
	await expect(page.getByText('You signed in with an email code.')).toBeVisible();
	const cookies = await ext.ctx.cookies(ORIGIN);
	// Dev mode on http://localhost: the plain cookie name, HttpOnly and SameSite=Strict.
	expect(cookies.find((c) => c.name === 'colander_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

	const mark = logMark();
	await page.getByLabel('Name for the new passkey').fill('Laptop');
	await page.getByRole('button', { name: 'Add a passkey' }).click();
	await expect(page.getByText('Passkey added.', { exact: false })).toBeVisible();
	expect(await device.count()).toBe(1);
	await expect.poll(() => mailsSince(mark).map((m) => m.subject)).toContain('Colander account: a passkey was added to your account');

	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Sign in|Your account/);
	// The email field offers the passkey in its autofill, which this device answers on its own; the
	// button is the way otherwise.
	const button = page.getByRole('button', { name: 'Sign in with a passkey' });
	if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
	await expect(page.getByText('You signed in with a passkey.')).toBeVisible();
	await page.screenshot({ path: 'screenshots/account-passkey.png', animations: 'disabled' });
	await page.close();
});

test('a new curator has member rights from a code until an invite adds a passkey', async () => {
	const curator = `curator.${Date.now()}@example.test`;
	// Staff make the curator on the admin host.
	const admin = await ext.ctx.newPage();
	await adminSignIn(admin, STAFF, '/admin/people');
	await admin.getByLabel('Email', { exact: true }).fill(curator);
	await admin.getByRole('button', { name: 'Save role' }).click();
	await expect(admin.getByText(`${curator} is now curator.`, { exact: false })).toBeVisible();
	await admin.close();

	// An email code alone: the console asks for a passkey, and the API refuses review.
	await ext.ctx.clearCookies({ domain: 'localhost' });
	const page = await ext.ctx.newPage();
	await signIn(page, curator, '/console');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Confirm with your passkey');
	await expect(page.getByText('Your account has no passkey yet')).toBeVisible();
	const cookie = await apiSignIn(curator);
	const refused = await api('/v1/review/queue', { cookie });
	expect([refused.status, refused.json.error.code]).toEqual([403, 'passkey_required']);

	// The invite adds the passkey, and with it the console opens.
	await enrollReviewer(page, curator, STAFF);
	await page.goto(`${ORIGIN}/console`);
	await expect(page.getByRole('heading', { level: 1, name: 'Review queue' })).toBeVisible();
	await expect(page.getByText('Curator', { exact: true })).toBeVisible();
	await page.close();
});

test('staff work on the admin host through Access, and its token opens nothing on the main host', async () => {
	const page = await ext.ctx.newPage();
	await adminSignIn(page, ADMIN, '/admin/audit');
	await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
	await expect(page.getByRole('row').filter({ hasText: 'role changed' }).first()).toBeVisible();
	// The site's own links leave the admin host for the main one.
	await expect(page.getByRole('banner').getByRole('link', { name: 'Account' })).toHaveAttribute('href', `${ORIGIN}/account`);
	await page.screenshot({ path: 'screenshots/admin-audit.png', animations: 'disabled' });

	// A member's identity gets no staff authority there.
	const member = await adminHttp('/v1/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': await devAccess('nobody@example.test') } });
	expect([member.status, member.json.error.code]).toEqual([403, 'not_staff']);
	// Without Access nothing on the admin host answers, static pages included.
	expect((await adminHttp('/admin')).status).toBe(403);

	// On the main host the admin API does not exist, a forged identity header is dropped, the
	// dev stub is absent, and /admin leads to the admin host.
	const token = process.env.COLANDER_E2E_STAFF_ACCESS!;
	const main = await fetch(`${ORIGIN}/v1/admin/me`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
	expect(main.status).toBe(404);
	const forged = await fetch(`${ORIGIN}/v1/review/queue`, { headers: { 'x-colander-access-email': STAFF, 'x-colander-host': 'admin' } });
	expect(forged.status).toBe(401);
	expect((await fetch(`${ORIGIN}/__dev/access`, { method: 'POST', body: JSON.stringify({ email: STAFF }) })).status).toBe(404);
	const redirect = await fetch(`${ORIGIN}/admin/people`, { redirect: 'manual' });
	expect([redirect.status, redirect.headers.get('location')]).toEqual([302, `${adminOrigin()}/admin/people`]);
	await page.close();
});
