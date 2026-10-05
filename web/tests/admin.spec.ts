// The admin console on the admin host (docs/contracts.md 6.9) against mocked answers: who is signed
// in, the review queue with staff authority, people and roles, invites and the audit log.
import { test, expect, layoutSpills } from './fixtures.ts';
import { AUDIT, ME, PEOPLE, QUEUE, mockApi, reviewSource } from './mocks.ts';

/** The admin host of the test server: admin.localhost on the same port, as in dev. */
const adminHost = (baseURL: string | undefined) => baseURL!.replace('//localhost', '//admin.localhost');

const STAFF_ME = { ...ME, account: { ...ME.account, role: 'staff' }, authority: 'staff', permissions: ['review', 'review.staff', 'people.read', 'role.set', 'invite.issue'] };

test('reviews with full authority: staff decide large sources here', async ({ page, baseURL }) => {
	const calls = await mockApi(page, {
		'GET /v1/admin/me': { json: STAFF_ME },
		'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
		'GET /v1/review/sources/*': (c) => {
			const [, , , , p, id] = c.path.split('/');
			return { json: reviewSource(`${p}:${decodeURIComponent(id!)}`) };
		}
	});
	await page.goto(`${adminHost(baseURL)}/admin`);
	await expect(page.getByText('Staff, Rae')).toBeVisible();
	await page.getByRole('button', { name: /Ancient Facts Daily/ }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Ancient Facts Daily' })).toBeVisible();
	// A large source: no staff-only lock here.
	await expect(page.getByText('Staff decision needed')).toHaveCount(0);
	await expect(page.getByRole('navigation', { name: 'Admin console' }).getByRole('link')).toHaveText(['Review', 'People']);
	// The public page lives on the main host, which has the verdict; the admin host serves no public API.
	await expect(page.getByRole('link', { name: 'Public source page' })).toHaveAttribute('href', new RegExp(`^${baseURL}/s/`));
	await page.waitForLoadState('networkidle');
	expect(calls.filter((c) => c.path === '/v1/stats' || c.path === '/v1/log')).toEqual([]);
});

test('a client-side route to /admin on the main host goes on to the admin host', async ({ page, baseURL }) => {
	await mockApi(page, { 'GET /v1/admin/me': { json: ME } });
	await page.goto('/admin/people');
	await expect(page).toHaveURL(`${adminHost(baseURL)}/admin/people`);
	await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible();
});

test('says plainly when the Access identity is not staff', async ({ page }) => {
	await mockApi(page, { 'GET /v1/admin/me': { status: 403, json: { error: { code: 'not_staff', message: 'This Access identity is not a Colander staff account.' } } } });
	await page.goto('/admin');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not a staff account');
	await expect(page.getByText('Curators review on the main site.')).toBeVisible();
});

test('sets roles below your own and issues an invite shown only here', async ({ page }) => {
	const calls = await mockApi(page, {
		'GET /v1/admin/me': { json: STAFF_ME },
		'GET /v1/admin/people': { json: { people: PEOPLE } },
		'PUT /v1/admin/people/role': (c) => ({ json: { person: { ...PEOPLE[3], email: c.body.email, role: c.body.role } } }),
		'POST /v1/admin/people/*/invite': {
			status: 201,
			json: { invite: 'inv_abc', url: 'http://localhost/account/invite#invite=inv_abc', expires_at: '2026-10-06T09:00:00Z' }
		}
	});
	await page.goto('/admin/people');
	// Staff grant member and curator only.
	await expect(page.getByLabel('Role').locator('option')).toHaveText(['Member', 'Curator']);
	await page.getByLabel('Email', { exact: true }).fill('new@example.com');
	await page.getByRole('button', { name: 'Save role' }).click();
	await expect(page.getByText('new@example.com is now curator. Issue an invite so they can add a passkey.')).toBeVisible();
	expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ email: 'new@example.com', role: 'curator' });
	expect(calls.find((c) => c.method === 'PUT')!.headers['x-colander-csrf']).toBe('1');

	// Staff invite curators, never staff or admins, and never themselves.
	const lee = page.getByRole('listitem').filter({ hasText: 'lee@example.com' });
	await expect(page.getByRole('listitem').filter({ hasText: 'sam@example.com' }).getByRole('button', { name: 'Invite' })).toHaveCount(0);
	await lee.getByRole('button', { name: 'Invite' }).click();
	await expect(page.getByRole('heading', { name: 'Invite for lee@example.com' })).toBeVisible();
	await expect(page.getByText('http://localhost/account/invite#invite=inv_abc')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Copy the link' })).toBeVisible();
	await expect(page.getByText('End every sign-in')).toHaveCount(0);
});

test('admins move a member to a new address with a receipt check, held 7 days', async ({ page }) => {
	const calls = await mockApi(page, {
		'GET /v1/admin/me': { json: ME },
		'GET /v1/admin/people': { json: { people: [...PEOPLE, { ...PEOPLE[3]!, id: 'acc_maya', email: 'maya@example.com', role: 'member', passkey_count: 0 }] } },
		'PUT /v1/admin/people/*/email': { json: { due_at: '2026-10-12T09:00:00Z' } }
	});
	await page.goto('/admin/people');
	await page.getByRole('listitem').filter({ hasText: 'maya@example.com' }).getByRole('button', { name: 'Change email' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('New email').fill('maya@new.example');
	await dialog.getByLabel('Checkout Session ID from the receipt').fill('cs_live_123');
	await dialog.getByLabel('Amount charged, in dollars').fill('30');
	await dialog.getByLabel('Charge date (UTC)').fill('2026-09-12');
	await dialog.getByRole('button', { name: 'Move in 7 days' }).click();
	await expect(page.getByText('maya@example.com moves to maya@new.example on 12 October 2026', { exact: false })).toBeVisible();
	expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ email: 'maya@new.example', checkout_session: 'cs_live_123', amount_cents: 3000, date: '2026-09-12' });
});

test('admins read the audit log, newest first', async ({ page }) => {
	await mockApi(page, { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/audit': { json: { entries: AUDIT, next_cursor: null } } });
	await page.goto('/admin/audit');
	await expect(page.getByRole('row')).toHaveCount(AUDIT.length + 1);
	await expect(page.getByRole('row').nth(1)).toContainText('invite issued');
	await expect(page.getByRole('row').nth(3)).toContainText('github:slantview');
});

test('on a phone the audit log is one entry under the other, with addresses and IDs whole', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page, { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/audit': { json: { entries: AUDIT, next_cursor: null } } });
	await page.goto('/admin/audit');
	const entries = page.locator('ol.entries > li');
	await expect(entries).toHaveCount(AUDIT.length);
	await expect(page.getByRole('table')).toBeHidden();
	await expect(entries.first()).toContainText('invite issued');
	// Each address and ID sits on one line.
	for (const text of ['rae@example.com (admin)', 'acc_lee']) {
		const box = (await entries.first().getByText(text, { exact: true }).boundingBox())!;
		expect(box.height, text).toBeLessThan(30);
	}
	expect(await layoutSpills(page)).toEqual([]);
});
