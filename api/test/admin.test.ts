// The admin host and the permission table (src/access.ts, src/routes/admin.ts, src/permissions.ts;
// docs/contracts.md 6.1 and 6.9), through the edge: the Access token check that fails closed, the
// headers the edge strips and sets, the A3T subject pinned on first sign-in, the dev Access stub
// that works only in dev, and every admin action by role.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { can, type Action, type Role } from '../src/permissions';
import { grantRole, getAccount } from '../src/store/accounts';
import { Store } from '../src/store/store';
import { accessHeaders, accessToken, ADMIN_ORIGIN } from './tokens';

const MAIN = 'https://getcolander.com';
const primary = () => env.STORE.getByName('primary');
let n = 0;
/** A fresh address per test, since every test here shares the primary Store. */
const email = (who: string) => `${who}.${++n}@colander.test`;
const role = (address: string, r: Role) => runInDurableObject(primary(), (s: Store) => grantRole(s.db, address, r, Math.floor(Date.now() / 1000), { host: 'job' }));

let client = 0;
const send = (url: string, init: RequestInit = {}) => {
	const headers = new Headers(init.headers);
	if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `198.18.9.${++client % 250}`);
	return exports.default.fetch(new Request(url, { redirect: 'manual', ...init, headers }));
};
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const sendWith = (overrides: Partial<Env>, url: string, init: RequestInit = {}) =>
	worker.fetch(new IncomingRequest(url, { redirect: 'manual', ...init } as RequestInit<IncomingRequestCfProperties>), { ...env, ...overrides }, createExecutionContext());
const code = async (res: Response) => ((await res.clone().json()) as { error: { code: string } }).error.code;

afterEach(() => vi.restoreAllMocks());

describe('the Access check on the admin host', () => {
	it('lets in a valid token for a staff account and fails closed on anything else', async () => {
		const rae = email('rae');
		await role(rae, 'staff');
		const me = (token?: string) => send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });
		const ok = await me(await accessToken(rae));
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ account: { email: rae, role: 'staff' }, authority: 'staff' });
		expect(ok.headers.get('Access-Control-Allow-Origin')).toBeNull();

		const now = Math.floor(Date.now() / 1000);
		const good = await accessToken(rae);
		const refused: [string, string | undefined][] = [
			['no token', undefined],
			['wrong audience', await accessToken(rae, { claims: { aud: ['another-app'] } })],
			['wrong issuer', await accessToken(rae, { claims: { iss: 'https://other-team.cloudflareaccess.com' } })],
			['expired', await accessToken(rae, { claims: { exp: now - 1 } })],
			['not yet valid', await accessToken(rae, { claims: { nbf: now + 600 } })],
			['bad signature', good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA')],
			['unknown key', await accessToken(rae, { kid: 'someone-else' })],
			['a global session token', await accessToken(rae, { claims: { type: 'org' } })],
			['a service token', await accessToken('', { claims: { email: undefined, common_name: 'abc.access' } })],
			['garbage', 'not.a.jwt']
		];
		for (const [what, token] of refused) {
			const res = await me(token);
			expect(res.status, what).toBe(403);
			expect(await code(res), what).toBe('access_required');
		}
		// Without the team domain and AUD the admin host stays closed.
		const unset = await sendWith({ CF_ACCESS_AUD: '' }, `${ADMIN_ORIGIN}/v1/admin/me`, { headers: { 'Cf-Access-Jwt-Assertion': good } });
		expect(unset.status).toBe(403);
		// Static pages are behind it too, and the home page is the admin console.
		expect((await send(`${ADMIN_ORIGIN}/admin`)).status).toBe(403);
		const home = await send(`${ADMIN_ORIGIN}/`, { headers: { 'Cf-Access-Jwt-Assertion': good } });
		expect([home.status, home.headers.get('Location')]).toEqual([302, `${ADMIN_ORIGIN}/admin`]);
	});

	it('answers not_staff for members and curators, and only the admin and review APIs exist there', async () => {
		for (const r of ['member', 'curator'] as const) {
			const who = email(r);
			await role(who, r);
			const res = await send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: await accessHeaders(who) });
			expect([res.status, await code(res)], r).toEqual([403, 'not_staff']);
		}
		const staff = await accessHeaders(email('nobody'));
		expect(await code(await send(`${ADMIN_ORIGIN}/v1/review/queue`, { headers: staff }))).toBe('not_staff');
		const rae = email('rae');
		await role(rae, 'staff');
		const h = await accessHeaders(rae);
		for (const path of ['/v1/account', '/v1/tags', '/v1/list/snapshot', '/ops/status', '/healthz', '/v1/auth/code']) {
			expect((await send(`${ADMIN_ORIGIN}${path}`, { headers: h })).status, path).toBe(404);
		}
		expect((await send(`${ADMIN_ORIGIN}/v1/review/queue`, { headers: h })).status).toBe(200);
	});

	it('pins the A3T subject on the first sign-in and refuses another one after; One-time PIN tokens carry none', async () => {
		const rae = email('rae');
		const account = await role(rae, 'admin');
		const me = async (subject?: string) => send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: await accessHeaders(rae, { subject }) });
		expect((await me('111')).status).toBe(200);
		expect(await runInDurableObject(primary(), (s: Store) => getAccount(s.db, account.id)!.accessSubject)).toBe('a3t:111');
		expect((await me('111')).status).toBe(200);
		const forged = await me('222');
		expect([forged.status, await code(forged)]).toEqual([403, 'not_staff']);
		// One-time PIN, the fallback, proves the mailbox instead.
		expect((await me()).status).toBe(200);
		// A subject pinned to one account never signs in as another.
		const sam = email('sam');
		await role(sam, 'staff');
		expect((await send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: await accessHeaders(sam, { subject: '111' }) })).status).toBe(403);
		const audit = await runInDurableObject(primary(), (s: Store) =>
			s.db.all("SELECT action, reason FROM audit_log WHERE actor_email IN (?, ?) AND action LIKE 'access_%' ORDER BY id", rae, sam)
		);
		expect(audit).toEqual([
			{ action: 'access_pinned', reason: null },
			{ action: 'access_refused', reason: 'subject mismatch' },
			{ action: 'access_refused', reason: 'subject pinned to another account' }
		]);
	});
});

describe('what the edge forwards', () => {
	it('drops every x-colander- header the client sends, on both hosts, and sets its own', async () => {
		const rae = email('rae');
		const mallory = email('mallory');
		await role(rae, 'staff');
		await role(mallory, 'admin');
		const store = vi.spyOn(Store.prototype, 'fetch');
		const forged = { 'x-colander-access-email': mallory, 'x-colander-access-subject': 'a3t:x', 'x-colander-host': 'admin', 'x-colander-ip-hash': 'forged', 'x-colander-request-id': 'x' };
		await send(`${MAIN}/v1/review/queue`, { headers: forged });
		await send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: { ...forged, ...(await accessHeaders(rae)), Cookie: 'colander_session=abc', Authorization: 'Bearer colander_rt_x' } });
		const [main, admin] = store.mock.calls.map((c) => Object.fromEntries((c[0] as Request).headers));
		expect(main).toMatchObject({ 'x-colander-host': 'main' });
		expect(main!['x-colander-access-email']).toBeUndefined();
		expect(main!['x-colander-ip-hash']).not.toBe('forged');
		expect(admin).toMatchObject({ 'x-colander-host': 'admin', 'x-colander-access-email': rae, 'x-colander-access-subject': '', 'x-colander-csrf': '1' });
		// The admin host never passes on the product cookie, a bearer token or the Access token itself.
		expect(admin!.cookie).toBeUndefined();
		expect(admin!.authorization).toBeUndefined();
		expect(admin!['cf-access-jwt-assertion']).toBeUndefined();
	});

	it('keeps the admin API off the main host and sends /admin to the admin host', async () => {
		expect((await send(`${MAIN}/v1/admin/me`)).status).toBe(404);
		const res = await send(`${MAIN}/admin/people?q=x`);
		expect([res.status, res.headers.get('Location')]).toEqual([302, `${ADMIN_ORIGIN}/admin/people?q=x`]);
		// Staff signed in on the main host act as curators, and need a passkey for that.
		expect((await sendWith({ ADMIN_HOST: '' }, `${MAIN}/admin`)).status).toBe(404);
	});
});

describe('the dev Access stub', () => {
	const dev = { PUBLIC_URL: 'http://localhost:8787' } as Partial<Env>;

	it('signs in on admin.localhost in dev mode only, and its token is worthless anywhere else', async () => {
		const rae = email('rae');
		await role(rae, 'staff');
		const stub = await sendWith(dev, 'http://admin.localhost:8787/__dev/access', { method: 'POST', body: JSON.stringify({ email: rae }) });
		expect(stub.status).toBe(200);
		const { token } = (await stub.json()) as { token: string };
		expect(stub.headers.get('Set-Cookie')).toBe(`CF_Authorization=${token}; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict`);
		const cookie = { Cookie: `CF_Authorization=${token}` };
		expect((await sendWith(dev, 'http://admin.localhost:8787/v1/admin/me', { headers: cookie })).status).toBe(200);

		// The stub does not exist outside dev mode on localhost, nor on the main host.
		for (const [overrides, url] of [
			[{}, `${ADMIN_ORIGIN}/__dev/access`],
			[{ ...dev, COLANDER_DEV: '' }, 'http://admin.localhost:8787/__dev/access'],
			[dev, 'http://localhost:8787/__dev/access'],
			[{ PUBLIC_URL: 'https://staging.getcolander.com' }, 'https://staging-admin.getcolander.com/__dev/access']
		] as const) {
			const res = await sendWith(overrides, url, { method: 'POST', body: JSON.stringify({ email: rae }) });
			// Answered like any unknown path, and no token is minted.
			expect([404, 405], url).toContain(res.status);
			expect(res.headers.get('Set-Cookie'), url).toBeNull();
		}
		// The dev token, as a header or a cookie, opens nothing on a deployed admin host.
		for (const headers of [{ 'Cf-Access-Jwt-Assertion': token }, cookie]) {
			expect((await send(`${ADMIN_ORIGIN}/v1/admin/me`, { headers })).status).toBe(403);
		}
	});
});

describe('the permission table', () => {
	it('decides every action by authority, target and its own account', () => {
		const actor = (authority: Role) => ({ id: 'me', authority });
		const t = (r: string, newRole?: string) => ({ id: 'them', role: r, newRole });
		const cases: [Role, Action, ReturnType<typeof t> | undefined, boolean][] = [
			['curator', 'review', undefined, true],
			['curator', 'review.staff', undefined, false],
			['staff', 'review.staff', undefined, true],
			['curator', 'people.read', undefined, false],
			['staff', 'people.read', undefined, true],
			// Roles change only below the actor, to roles below the actor, never to admin.
			['staff', 'role.set', t('member', 'curator'), true],
			['staff', 'role.set', t('curator', 'member'), true],
			['staff', 'role.set', t('member', 'staff'), false],
			['staff', 'role.set', t('staff', 'member'), false],
			['admin', 'role.set', t('member', 'staff'), true],
			['admin', 'role.set', t('staff', 'curator'), true],
			['admin', 'role.set', t('member', 'admin'), false],
			['admin', 'role.set', t('admin', 'staff'), false],
			['admin', 'role.set', { id: 'me', role: 'admin', newRole: 'staff' }, false],
			['admin', 'role.set', t('member', 'owner'), false],
			// Invites: review roles only; staff and admin accounts only by an admin; never for oneself.
			['staff', 'invite.issue', t('curator'), true],
			['staff', 'invite.issue', t('staff'), false],
			['staff', 'invite.issue', t('member'), false],
			['admin', 'invite.issue', t('staff'), true],
			['admin', 'invite.issue', t('admin'), true],
			['admin', 'invite.issue', { id: 'me', role: 'admin', newRole: undefined }, false],
			['staff', 'people.revoke', t('curator'), false],
			['admin', 'people.revoke', t('staff'), true],
			['admin', 'people.revoke', t('admin'), false],
			['admin', 'people.email', t('member'), true],
			['admin', 'people.email', t('curator'), false],
			['staff', 'supporters.credit', undefined, false],
			['admin', 'supporters.credit', undefined, true],
			['staff', 'audit.read', undefined, false],
			['admin', 'audit.read', undefined, true]
		];
		for (const [authority, action, target, want] of cases) expect([authority, action, target, can(actor(authority), action, target)]).toEqual([authority, action, target, want]);
	});

	it('enforces it on every admin route, by role', async () => {
		const staff = email('staff');
		const admin = email('admin');
		const curator = email('curator');
		const otherStaff = email('staff2');
		await role(staff, 'staff');
		await role(admin, 'admin');
		const cur = await role(curator, 'curator');
		const os = await role(otherStaff, 'staff');
		const as = async (who: string, method: string, path: string, body?: unknown) =>
			send(`${ADMIN_ORIGIN}${path}`, { method, headers: { ...(await accessHeaders(who)), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
		const status = async (...a: Parameters<typeof as>) => (await as(...a)).status;

		expect(await status(staff, 'GET', '/v1/admin/people')).toBe(200);
		expect(await status(staff, 'GET', '/v1/admin/people?q=example')).toBe(200);
		expect(await status(staff, 'PUT', '/v1/admin/people/role', { email: email('new'), role: 'curator' })).toBe(200);
		expect(await status(staff, 'PUT', '/v1/admin/people/role', { email: email('new'), role: 'staff' })).toBe(403);
		expect(await status(staff, 'PUT', '/v1/admin/people/role', { email: otherStaff, role: 'member' })).toBe(403);
		expect(await status(staff, 'PUT', '/v1/admin/people/role', { email: staff, role: 'member' })).toBe(403);
		expect(await status(admin, 'PUT', '/v1/admin/people/role', { email: email('new'), role: 'staff' })).toBe(200);
		expect(await status(admin, 'PUT', '/v1/admin/people/role', { email: email('new'), role: 'admin' })).toBe(403);
		expect(await status(staff, 'POST', `/v1/admin/people/${cur.id}/invite`)).toBe(201);
		expect(await status(staff, 'POST', `/v1/admin/people/${os.id}/invite`)).toBe(403);
		expect(await status(admin, 'POST', `/v1/admin/people/${os.id}/invite`)).toBe(201);
		expect(await status(staff, 'POST', `/v1/admin/people/${cur.id}/revoke`)).toBe(403);
		expect(await status(admin, 'POST', `/v1/admin/people/${cur.id}/revoke`)).toBe(200);
		expect(await status(admin, 'PUT', `/v1/admin/people/${cur.id}/email`, { email: email('x'), checkout_session: 'cs_1', amount_cents: 300, date: '2026-10-01' })).toBe(403);
		expect(await status(staff, 'POST', '/v1/admin/donations/cs_none/credit', { credit_name: '' })).toBe(403);
		expect(await status(admin, 'POST', '/v1/admin/donations/cs_none/credit', { credit_name: '' })).toBe(404);
		expect(await status(staff, 'GET', '/v1/admin/audit')).toBe(403);
		const audit = await as(admin, 'GET', '/v1/admin/audit');
		expect(audit.status).toBe(200);
		const entries = ((await audit.json()) as { entries: { action: string; reason: string | null }[] }).entries;
		expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['invite_issued', 'revoked', 'role_changed']));
		// A search by email is recorded; opening the reviewer list is not.
		expect(entries.filter((e) => e.action === 'people_searched').map((e) => e.reason)).toEqual(['example']);
		// Writes need the CSRF header and a same-origin fetch here too.
		const { 'X-Colander-CSRF': _, ...noCsrf } = await accessHeaders(staff);
		expect(await code(await send(`${ADMIN_ORIGIN}/v1/admin/people/role`, { method: 'PUT', headers: noCsrf, body: '{}' }))).toBe('csrf_required');
	});

	it('shows the invite to the issuer only, mails a notice, and binds it to the account and role', async () => {
		const staff = email('staff');
		await role(staff, 'staff');
		const cur = await role(email('cur'), 'curator');
		const res = await send(`${ADMIN_ORIGIN}/v1/admin/people/${cur.id}/invite`, { method: 'POST', headers: await accessHeaders(staff) });
		const body = (await res.json()) as { invite: string; url: string; expires_at: string };
		expect(body.invite).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
		expect(body.url).toBe(`${env.PUBLIC_URL}/account/invite#invite=${body.invite}`);
		const row = await runInDurableObject(primary(), (s: Store) => s.db.get('SELECT kind, account_id, role FROM auth_flows WHERE kind = ? AND account_id = ?', 'invite', cur.id));
		expect(row).toEqual({ kind: 'invite', account_id: cur.id, role: 'curator' });
	});
});
