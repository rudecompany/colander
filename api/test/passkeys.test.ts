// Passkeys, invites, reviewers and account data (src/routes/account.ts, src/webauthn.ts,
// src/erase.ts; docs/contracts.md 6.6 to 6.8) against a software authenticator
// (test/authenticator.ts): registration and sign-in with P-256 and Ed25519 keys, the checks a
// stolen or replayed credential must fail, step-up, held requests, invites, the curator passkey
// rule, reviewer tokens, export and deletion.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/auth';
import { Billing } from '../src/billing';
import { reapplyErasures } from '../src/erase';
import { grantRole, putFlow, setDisplayName } from '../src/store/accounts';
import { cookieOf, errorCode, expectStatus, Harness } from './api';
import { SoftAuthenticator, type Misbehave } from './authenticator';
import { ORIGIN, sign, StripeFake } from './stripe-fake';

const CSRF = ['X-Colander-CSRF', '1'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SITE = new URL(env.PUBLIC_URL).origin;

type AccountJSON = { id: string; role: string; session: { method: string } | null; passkey_count: number; requests: { id: string; kind: string }[] };

/** Adds a passkey to the signed-in account, as the account page does. Returns the response. */
async function addPasskey(h: Harness, cookie: string, auth: SoftAuthenticator, m: Misbehave = {}, name = 'Laptop'): Promise<Response> {
	const o = await h.do('POST', '/v1/account/passkeys/options', undefined, ...CSRF, 'Cookie', cookie);
	if (o.status !== 200) return o;
	const { options } = (await o.json()) as { options: Parameters<SoftAuthenticator['create']>[0] & { excludeCredentials: { id: string }[] } };
	const credential = await auth.create(options, m);
	return h.do('POST', '/v1/account/passkeys', { credential, name }, ...CSRF, 'Cookie', `${cookie}; ${cookieOf(o, 'colander_pk')}`);
}

/** Signs in with the passkey; with a session cookie it is a step-up. Returns the response. */
async function passkeySignIn(h: Harness, auth: SoftAuthenticator, cookie = '', m: Misbehave = {}): Promise<Response> {
	const o = await h.do('POST', '/v1/auth/passkey/options', undefined, ...CSRF, ...(cookie ? ['Cookie', cookie] : []));
	await expectStatus(o, 200);
	const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
	const credential = await auth.get(options, m);
	const flow = cookieOf(o, 'colander_pk');
	return h.do('POST', '/v1/auth/passkey/verify', { credential }, ...CSRF, 'Cookie', cookie ? `${cookie}; ${flow}` : flow);
}

const sessionOf = (res: Response) => cookieOf(res, 'colander_session');
const accountOf = async (res: Response) => ((await res.clone().json()) as { account: AccountJSON }).account;
const me = async (h: Harness, cookie: string) => accountOf(await h.do('GET', '/v1/account', undefined, 'Cookie', cookie));

describe('passkeys', () => {
	it.each(['ES256', 'EdDSA'] as const)('registers and signs in with an %s passkey, each sign-in with a new passkey session', async (alg) => {
		const h = await Harness.create();
		const cookie = await h.signIn('maya@example.test');
		const auth = new SoftAuthenticator(SITE, alg);
		h.mail = '';
		const added = await addPasskey(h, cookie, auth);
		await expectStatus(added, 201);
		expect(((await added.json()) as { passkey: Record<string, unknown> }).passkey).toEqual({
			id: expect.stringMatching(/^pk_/),
			name: 'Laptop',
			created_at: '2026-10-01T12:00:00Z',
			last_used_at: null,
			synced: true
		});
		expect(h.mail).toContain('Subject: Colander account: a passkey was added to your account');
		expect(h.mail).toContain('then remove any passkey you do not recognize.');
		// The user handle is the account ID, never the email.
		expect(new TextDecoder().decode(auth.userHandle)).toMatch(/^acc_/);

		const signedIn = await passkeySignIn(h, auth);
		await expectStatus(signedIn, 200);
		const session = sessionOf(signedIn);
		expect((await accountOf(signedIn)).session).toEqual({ method: 'passkey', authenticated_at: '2026-10-01T12:00:00Z' });
		const again = await passkeySignIn(h, auth);
		expect(sessionOf(again)).not.toBe(session);
		expect(await h.run((store) => store.db.get('SELECT last_used_at, backed_up FROM passkeys'))).toEqual({ last_used_at: h.s, backed_up: 1 });
	});

	it('refuses a wrong origin, a wrong RP ID, no user verification, an unknown credential, a used challenge and a counter that goes back', async () => {
		const h = await Harness.create();
		const cookie = await h.signIn('maya@example.test');
		const auth = new SoftAuthenticator(SITE);
		// Registration checks the same things.
		for (const m of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { noUv: true }] as Misbehave[]) {
			expect(await errorCode(await addPasskey(h, cookie, auth, m)), JSON.stringify(m)).toBe('passkey_invalid');
		}
		await expectStatus(await addPasskey(h, cookie, auth), 201);
		for (const m of [{ origin: 'https://staging.getcolander.com' }, { rpId: 'staging.getcolander.com' }, { noUv: true }] as Misbehave[]) {
			expect(await errorCode(await passkeySignIn(h, auth, '', m)), JSON.stringify(m)).toBe('passkey_invalid');
		}
		const stranger = new SoftAuthenticator(SITE);
		await stranger.create({ challenge: 'x', rp: { id: 'getcolander.com' }, user: { id: 'eA' } });
		expect(await errorCode(await passkeySignIn(h, stranger))).toBe('passkey_invalid');

		// A challenge works once: replaying the same answer fails.
		const o = await h.do('POST', '/v1/auth/passkey/options', undefined, ...CSRF);
		const { options } = (await o.json()) as { options: { challenge: string; rpId: string } };
		const credential = await auth.get(options);
		const flow = cookieOf(o, 'colander_pk');
		const [first, second] = await Promise.all([
			h.do('POST', '/v1/auth/passkey/verify', { credential }, ...CSRF, 'Cookie', flow),
			h.do('POST', '/v1/auth/passkey/verify', { credential }, ...CSRF, 'Cookie', flow)
		]);
		expect([first.status, second.status].sort()).toEqual([200, 400]);

		// A hardware key counts up; an answer with an older count is a clone.
		await expectStatus(await passkeySignIn(h, auth, '', { counter: 5 }), 200);
		expect(await errorCode(await passkeySignIn(h, auth, '', { counter: 3 }))).toBe('passkey_invalid');
		await expectStatus(await passkeySignIn(h, auth, '', { counter: 6 }), 200);
	});

	it('asks for a recent sign-in, and for a passkey once the account holds one, before export, passkey changes, deletion and tokens', async () => {
		const h = await Harness.create();
		const cookie = await h.signIn('maya@example.test');
		// No passkey yet: a code sign-in of the last 10 minutes is enough.
		await expectStatus(await h.do('GET', '/v1/account/export', undefined, 'Cookie', cookie), 200);
		h.clock += 11 * MINUTE;
		expect(await errorCode(await h.do('GET', '/v1/account/export', undefined, 'Cookie', cookie))).toBe('recent_auth_required');
		expect(await errorCode(await addPasskey(h, cookie, new SoftAuthenticator(SITE)))).toBe('recent_auth_required');

		const fresh = await h.signIn('maya@example.test');
		const auth = new SoftAuthenticator(SITE);
		await expectStatus(await addPasskey(h, fresh, auth), 201);
		// Now a code is not enough for anything sensitive.
		for (const [method, path] of [
			['GET', '/v1/account/export'],
			['DELETE', '/v1/account'],
			['POST', '/v1/account/passkeys/options']
		]) {
			expect(await errorCode(await h.do(method!, path!, undefined, ...CSRF, 'Cookie', fresh)), path).toBe('passkey_required');
		}
		// A passkey step-up rotates the session: the old token ends.
		const up = await passkeySignIn(h, auth, fresh);
		await expectStatus(up, 200);
		const stepped = sessionOf(up);
		await expectStatus(await h.do('GET', '/v1/account', undefined, 'Cookie', fresh), 401);
		await expectStatus(await h.do('GET', '/v1/account/export', undefined, 'Cookie', stepped), 200);
		// A step-up only offers this account's passkeys.
		const o = await h.do('POST', '/v1/auth/passkey/options', undefined, ...CSRF, 'Cookie', stepped);
		expect(((await o.json()) as { options: { allowCredentials: { id: string }[] } }).options.allowCredentials.map((c) => c.id)).toEqual([auth.id]);
		h.clock += 11 * MINUTE;
		expect(await errorCode(await h.do('GET', '/v1/account/export', undefined, 'Cookie', stepped))).toBe('recent_auth_required');
	});

	it('caps an account at 10 passkeys, excludes the ones it holds, and tells the address when one is removed', async () => {
		const h = await Harness.create();
		const auths = [new SoftAuthenticator(SITE)];
		let cookie = await h.signIn('maya@example.test');
		await expectStatus(await addPasskey(h, cookie, auths[0]!), 201);
		cookie = sessionOf(await passkeySignIn(h, auths[0]!));
		for (let i = 1; i < 10; i++) {
			const a = new SoftAuthenticator(SITE);
			auths.push(a);
			await expectStatus(await addPasskey(h, cookie, a, {}, `Key ${i}`), 201);
		}
		const o = await h.do('POST', '/v1/account/passkeys/options', undefined, ...CSRF, 'Cookie', cookie);
		expect(await errorCode(o)).toBe('too_many_passkeys');
		const list = (await (await h.do('GET', '/v1/account/passkeys', undefined, 'Cookie', cookie)).json()) as { passkeys: { id: string }[]; current: string };
		expect(list.passkeys).toHaveLength(10);
		expect(list.current).toBe(list.passkeys[0]!.id);

		h.mail = '';
		await expectStatus(await h.do('DELETE', `/v1/account/passkeys/${list.passkeys[9]!.id}`, undefined, ...CSRF, 'Cookie', cookie), 204);
		expect(h.mail).toContain('Subject: Colander account: a passkey was taken off your account');
		// The next registration excludes every passkey the account still holds.
		const next = await h.do('POST', '/v1/account/passkeys/options', undefined, ...CSRF, 'Cookie', cookie);
		const excluded = ((await next.json()) as { options: { excludeCredentials: { id: string }[] } }).options.excludeCredentials.map((c) => c.id);
		expect(excluded.sort()).toEqual(auths.slice(0, 9).map((a) => a.id).sort());
		// Removing the passkey a session signed in with demotes that session to an email sign-in.
		await expectStatus(await h.do('DELETE', `/v1/account/passkeys/${list.passkeys[0]!.id}`, undefined, ...CSRF, 'Cookie', cookie), 204);
		expect((await me(h, cookie)).session?.method).toBe('email');
	});

	it('signs out everywhere: every session and the reviewer token end, and from a fresh passkey session every other passkey goes', async () => {
		const h = await Harness.create();
		const mine = new SoftAuthenticator(SITE);
		const intruder = new SoftAuthenticator(SITE);
		const code = await h.signIn('maya@example.test');
		await expectStatus(await addPasskey(h, code, intruder), 201);
		const elsewhere = await h.signIn('maya@example.test');
		const pk = sessionOf(await passkeySignIn(h, intruder));
		await expectStatus(await addPasskey(h, pk, mine), 201);
		const owner = sessionOf(await passkeySignIn(h, mine));
		h.mail = '';
		await expectStatus(await h.do('POST', '/v1/auth/logout', { everywhere: true }, ...CSRF, 'Cookie', owner), 204);
		for (const c of [elsewhere, pk, owner]) await expectStatus(await h.do('GET', '/v1/account', undefined, 'Cookie', c), 401);
		expect(await h.run((store) => store.db.all('SELECT credential_id FROM passkeys'))).toEqual([{ credential_id: mine.id }]);
		expect(h.mail).toContain('every other passkey was taken off');
		expect(await errorCode(await passkeySignIn(h, intruder))).toBe('passkey_invalid');
	});
});

describe('held requests', () => {
	it('with a passkey on the account and only a code, deletion waits 72 hours; the link or a passkey sign-in cancels it', async () => {
		const h = await Harness.create();
		const auth = new SoftAuthenticator(SITE);
		const first = await h.signIn('maya@example.test');
		await expectStatus(await addPasskey(h, first, auth), 201);
		const code = await h.signIn('maya@example.test');
		h.mail = '';
		const held = await h.do('POST', '/v1/account/requests', { kind: 'delete' }, ...CSRF, 'Cookie', code);
		await expectStatus(held, 201);
		expect(h.mail).toContain('Subject: Your Colander request: delete the account in 3 days');
		const secret = /\/account\/cancel#([A-Za-z0-9_-]+)/.exec(h.mail)![1]!;
		expect(await errorCode(await h.do('POST', '/v1/account/requests', { kind: 'delete' }, ...CSRF, 'Cookie', code))).toBe('already_waiting');
		expect((await me(h, code)).requests.map((r) => r.kind)).toEqual(['delete']);
		// The cancel link from the email works once, without a session.
		const cancelled = await h.do('POST', '/v1/auth/cancel', { secret }, ...CSRF);
		await expectStatus(cancelled, 200);
		expect(await cancelled.json()).toEqual({ cancelled: 'delete' });
		await expectStatus(await h.do('POST', '/v1/auth/cancel', { secret }, ...CSRF), 404);

		// A passkey sign-in cancels whatever waits.
		await expectStatus(await h.do('POST', '/v1/account/requests', { kind: 'export' }, ...CSRF, 'Cookie', code), 201);
		await expectStatus(await passkeySignIn(h, auth), 200);
		expect((await me(h, code)).requests).toEqual([]);

		// Uncancelled, the deletion runs once 72 hours have passed.
		const again = await h.signIn('maya@example.test');
		await expectStatus(await h.do('POST', '/v1/account/requests', { kind: 'delete' }, ...CSRF, 'Cookie', again), 201);
		h.clock += 71 * HOUR;
		await h.run((store) => import('../src/erase').then((m) => m.runHeldRequests(store, h.clock)));
		expect(await h.run((store) => store.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n)).toBe(1);
		h.clock += 2 * HOUR;
		await h.run((store) => import('../src/erase').then((m) => m.runHeldRequests(store, h.clock)));
		expect(await h.run((store) => store.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n)).toBe(0);
	});

	it('never deletes a staff or admin account: not at once, not held, and not when a member became staff while it waited', async () => {
		const h = await Harness.create();
		const run = () => h.run((store) => import('../src/erase').then((m) => m.runHeldRequests(store, h.clock)));
		// The bootstrap admin holds no passkey: an email code alone must not delete it.
		await h.run((store) => grantRole(store.db, 'ada@example.test', 'admin', h.s, { host: 'ops' }));
		const admin = await h.signIn('ada@example.test');
		for (const [method, path, body] of [
			['DELETE', '/v1/account', undefined],
			['POST', '/v1/account/requests', { kind: 'delete' }]
		] as const) {
			const res = await h.do(method, path, body, ...CSRF, 'Cookie', admin);
			expect([res.status, await errorCode(res)], path).toEqual([403, 'staff_account']);
		}

		// A member asks with a code; the account becomes staff before the 72 hours are over.
		const auth = new SoftAuthenticator(SITE);
		await expectStatus(await addPasskey(h, await h.signIn('maya@example.test'), auth), 201);
		await expectStatus(await h.do('POST', '/v1/account/requests', { kind: 'delete' }, ...CSRF, 'Cookie', await h.signIn('maya@example.test')), 201);
		await h.run((store) => grantRole(store.db, 'maya@example.test', 'staff', h.s, { host: 'job' }));
		h.clock += 73 * HOUR;
		await run();
		expect(await h.run((store) => store.db.all('SELECT email, role FROM accounts ORDER BY email'))).toEqual([
			{ email: 'ada@example.test', role: 'admin' },
			{ email: 'maya@example.test', role: 'staff' }
		]);
		expect(await h.run((store) => store.db.all("SELECT kind FROM account_requests WHERE cancelled_at IS NOT NULL AND done_at IS NULL"))).toEqual([{ kind: 'delete' }]);
		expect(await h.run((store) => store.db.get("SELECT host, reason FROM audit_log WHERE action = 'delete_refused'"))).toEqual({
			host: 'job',
			reason: 'staff and admin accounts are not deleted'
		});
	});

	it('lets a member who lost their passkey remove it after 72 hours, and then add a new one', async () => {
		const h = await Harness.create();
		const lost = new SoftAuthenticator(SITE);
		const first = await h.signIn('maya@example.test');
		await expectStatus(await addPasskey(h, first, lost), 201);
		const code = await h.signIn('maya@example.test');
		const pkId = (await h.run((store) => store.db.get<{ id: string }>('SELECT id FROM passkeys')))!.id;
		await expectStatus(await h.do('POST', '/v1/account/requests', { kind: 'remove_passkey', passkey_id: pkId }, ...CSRF, 'Cookie', code), 201);
		h.clock += 73 * HOUR;
		await h.run((store) => import('../src/erase').then((m) => m.runHeldRequests(store, h.clock)));
		const later = await h.signIn('maya@example.test');
		await expectStatus(await addPasskey(h, later, new SoftAuthenticator(SITE)), 201);
		expect(await h.run((store) => store.db.all('SELECT credential_id FROM passkeys'))).not.toContainEqual({ credential_id: lost.id });
	});
});

/** Makes email a reviewer of role and issues an invite for it, as the admin host does. Returns the raw invite. */
async function invite(h: Harness, email: string, role: string, ttl = DAY): Promise<string> {
	return h.run((store) => {
		const a = grantRole(store.db, email, role, h.s, { host: 'job' });
		setDisplayName(store.db, a.id, 'Sam');
		const secret = newToken('inv_');
		putFlow(store.db, { tokenHash: secret.hash, kind: 'invite', accountId: a.id, role, createdAt: h.s, expiresAt: h.s + ttl / 1000 });
		return secret.raw;
	});
}

/** Redeems an invite from a code session: returns the passkey session cookie, or the error response. */
async function redeem(h: Harness, cookie: string, inv: string, auth: SoftAuthenticator): Promise<Response> {
	const o = await h.do('POST', '/v1/auth/invite/options', { invite: inv }, ...CSRF, 'Cookie', cookie);
	if (o.status !== 200) return o;
	const { options } = (await o.json()) as { options: Parameters<SoftAuthenticator['create']>[0] };
	const credential = await auth.create(options);
	return h.do('POST', '/v1/auth/invite/verify', { invite: inv, credential, name: 'Work laptop' }, ...CSRF, 'Cookie', `${cookie}; ${cookieOf(o, 'colander_pk')}`);
}

describe('reviewers', () => {
	it('raising a member to curator removes the passkeys, sessions and token it had, so a passkey added as a member never reviews', async () => {
		const h = await Harness.create();
		const auth = new SoftAuthenticator(SITE);
		const cookie = await h.signIn('sam@example.test');
		await expectStatus(await addPasskey(h, cookie, auth), 201);
		await invite(h, 'sam@example.test', 'curator');
		expect(await h.run((store) => store.db.all('SELECT 1 FROM passkeys UNION ALL SELECT 1 FROM sessions'))).toEqual([]);
		expect(await errorCode(await passkeySignIn(h, auth))).toBe('passkey_invalid');
	});

	it('curators review only with a passkey session of the last 12 hours; an email code gives member rights', async () => {
		const h = await Harness.create();
		const inv = await invite(h, 'sam@example.test', 'curator');
		const code = await h.signIn('sam@example.test');
		expect(await errorCode(await h.do('GET', '/v1/review/queue', undefined, 'Cookie', code))).toBe('passkey_required');
		// A reviewer adds the first passkey only through an invite.
		expect(await errorCode(await addPasskey(h, code, new SoftAuthenticator(SITE)))).toBe('invite_required');
		const auth = new SoftAuthenticator(SITE);
		h.mail = '';
		const redeemed = await redeem(h, code, inv, auth);
		await expectStatus(redeemed, 200);
		expect(h.mail).toContain('a passkey was added to your account with an invite');
		const session = sessionOf(redeemed);
		expect((await accountOf(redeemed)).session?.method).toBe('passkey');
		await expectStatus(await h.do('GET', '/v1/review/queue', undefined, 'Cookie', session), 200);
		// Staff authority never exists on the main host, even for staff.
		h.clock += 12 * HOUR + 1000;
		expect(await errorCode(await h.do('GET', '/v1/review/queue', undefined, 'Cookie', session))).toBe('passkey_required');
		await expectStatus(await h.do('GET', '/v1/review/queue', undefined, 'Cookie', sessionOf(await passkeySignIn(h, auth))), 200);
	});

	it('asks a reviewer who holds a passkey but signed in with a code for that passkey before adding another, not for an invite', async () => {
		const h = await Harness.create();
		const inv = await invite(h, 'sam@example.test', 'curator');
		const auth = new SoftAuthenticator(SITE);
		await expectStatus(await redeem(h, await h.signIn('sam@example.test'), inv, auth), 200);
		const code = await h.signIn('sam@example.test');
		expect(await errorCode(await addPasskey(h, code, new SoftAuthenticator(SITE)))).toBe('passkey_required');
		// The step-up the website then opens unlocks it.
		const up = sessionOf(await passkeySignIn(h, auth, code));
		await expectStatus(await addPasskey(h, up, new SoftAuthenticator(SITE), {}, 'Phone'), 201);
	});

	it('invites need a session of the same account, work once within 24 hours, and only for the role they were issued for', async () => {
		const h = await Harness.create();
		const inv = await invite(h, 'sam@example.test', 'curator');
		const other = await h.signIn('maya@example.test');
		expect(await errorCode(await redeem(h, other, inv, new SoftAuthenticator(SITE)))).toBe('invite_invalid');
		await expectStatus(await h.do('POST', '/v1/auth/invite/options', { invite: inv }, ...CSRF), 401);
		const sam = await h.signIn('sam@example.test');
		await expectStatus(await redeem(h, sam, inv, new SoftAuthenticator(SITE)), 200);
		expect(await errorCode(await redeem(h, await h.signIn('sam@example.test'), inv, new SoftAuthenticator(SITE)))).toBe('invite_invalid');

		// Expired after 24 hours.
		const late = await invite(h, 'lee@example.test', 'curator');
		h.clock += DAY + 1000;
		expect(await errorCode(await redeem(h, await h.signIn('lee@example.test'), late, new SoftAuthenticator(SITE)))).toBe('invite_invalid');
		// Refused once the role changed, and never for a member.
		const changed = await invite(h, 'kim@example.test', 'curator');
		await h.run((store) => grantRole(store.db, 'kim@example.test', 'member', h.s, { host: 'job' }));
		expect(await errorCode(await redeem(h, await h.signIn('kim@example.test'), changed, new SoftAuthenticator(SITE)))).toBe('invite_invalid');
		const member = await invite(h, 'ana@example.test', 'member');
		expect(await errorCode(await redeem(h, await h.signIn('ana@example.test'), member, new SoftAuthenticator(SITE)))).toBe('invite_invalid');
	});

	it('issues reviewer tokens from a fresh passkey session, for 7 days, with curator authority at most', async () => {
		const h = await Harness.create();
		const inv = await invite(h, 'rae@example.test', 'staff');
		const code = await h.signIn('rae@example.test');
		expect(await errorCode(await h.do('POST', '/v1/account/reviewer-token', undefined, ...CSRF, 'Cookie', code))).toBe('passkey_required');
		const session = sessionOf(await redeem(h, code, inv, new SoftAuthenticator(SITE)));
		const res = await h.do('POST', '/v1/account/reviewer-token', undefined, ...CSRF, 'Cookie', session);
		await expectStatus(res, 200);
		const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
		expect(token).toMatch(/^colander_rt_[A-Za-z0-9_-]{43}$/);
		expect(expires_at).toBe('2026-10-08T12:00:00Z');
		expect(await h.run((store) => store.db.get('SELECT token_hash FROM reviewer_tokens'))).toEqual({ token_hash: hashToken(token) });
		const bearer = ['Authorization', `Bearer ${token}`];
		// Staff with a token act as curators: appeals answer staff_required.
		const appeal = await h.do('POST', '/v1/review/appeals/apl_none/resolve', { outcome: 'denied', reasoning: 'x' }, ...bearer);
		expect(await errorCode(appeal)).toBe('staff_required');
		expect((await me(h, session)) as unknown).toMatchObject({ reviewer_token: { expires_at: '2026-10-08T12:00:00Z', last_used_at: '2026-10-01T12:00:00Z' } });
		h.clock += 7 * DAY;
		expect(await errorCode(await h.do('GET', '/v1/review/queue', undefined, ...bearer))).toBe('token_expired');
		// Disconnecting deletes it.
		await expectStatus(await h.do('DELETE', '/v1/account/reviewer-token', undefined, ...CSRF, 'Cookie', session), 204);
		expect(await h.run((store) => store.db.all('SELECT 1 FROM reviewer_tokens'))).toEqual([]);
	});
});

describe('account data', () => {
	it('exports everything Colander keeps about the account, and audits the export', async () => {
		const h = await Harness.create();
		const cookie = await h.signIn('maya@example.test');
		await h.run((store) => store.db.run("INSERT INTO sync_blobs (sub, version, data, updated_at) SELECT id, 2, '{\"strictness\":\"strict\"}', 5 FROM accounts"));
		const auth = new SoftAuthenticator(SITE);
		await expectStatus(await addPasskey(h, cookie, auth), 201);
		// The account holds a passkey now: the code session is not enough.
		expect(await errorCode(await h.do('GET', '/v1/account/export', undefined, 'Cookie', cookie))).toBe('passkey_required');
		const pk = sessionOf(await passkeySignIn(h, auth));
		const out = await h.do('GET', '/v1/account/export', undefined, 'Cookie', pk);
		await expectStatus(out, 200);
		expect(out.headers.get('Content-Disposition')).toBe('attachment; filename="colander-account.json"');
		const data = (await out.json()) as Record<string, unknown>;
		expect(Object.keys(data).sort()).toEqual(['account', 'audit', 'decisions', 'exported_at', 'passkeys', 'requests', 'reviewer_token', 'sessions', 'subscription', 'synced_settings']);
		expect(data.synced_settings).toEqual({ version: 2, updated_at: '1970-01-01T00:00:05Z', data: { strictness: 'strict' } });
		expect((data.passkeys as unknown[]).length).toBe(1);
		expect(JSON.stringify(data)).not.toMatch(/token_hash|public_key|credential_id/);
		expect(await h.run((store) => store.db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'exported'"))).toEqual({ n: 1 });
	});

	it('deletes the account: Plus ends with a refund, the Stripe customer goes, names leave the log, and a restore erases it again', async () => {
		const h = await Harness.create();
		const f = new StripeFake();
		f.now = () => h.s;
		f.prices = { price_plus_year: { amount: 3000, interval: 'year' } };
		await h.run((store) => {
			store.billing = new Billing(store.db, {
				secretKey: 'sk_test_colander',
				webhookSecret: 'whsec_test',
				priceMonthly: '',
				priceYearly: 'price_plus_year',
				managedPayments: false,
				apiBase: ORIGIN,
				publicUrl: SITE
			});
			store.billing.fetch = f.fetch;
		});
		const cookie = await h.signIn('maya@example.test');
		const co = await h.do('POST', '/v1/billing/checkout', { price: 'plus_yearly' }, ...CSRF, 'Cookie', cookie);
		const session = ((await co.json()) as { url: string }).url.split('/').pop()!;
		const events = f.pay(session);
		for (const ev of events) await expectStatus(await h.do('POST', '/v1/billing/webhook', ev, 'Stripe-Signature', await sign(ev, 'whsec_test', h.s)), 200);
		const id = (await me(h, cookie)).id;
		const subscription = (await h.run((store) => store.db.get<{ id: string }>('SELECT id FROM subscriptions')))!.id;
		await h.run((store) => {
			store.db.run("INSERT INTO sources (id, platform, canonical_id, created_at) VALUES (900, 'yt', '@x', 1)");
			store.db.run(
				"INSERT INTO decisions (source_id, verdict, reason, actor, account_id, actor_name, created_at, expires_at) VALUES (900, 'clear', 'Fine.', 'curator', ?, 'Maya', 1, 2)",
				id
			);
			store.db.run(
				"INSERT INTO decision_log (at, platform, target_type, target_id, source_id, source_key, reason, actor, actor_name, account_id) VALUES (1, 'yt', 'source', '@x', 900, '@x', 'Fine.', 'curator', 'Maya', ?)",
				id
			);
		});
		h.mail = '';
		await expectStatus(await h.do('DELETE', '/v1/account', undefined, ...CSRF, 'Cookie', cookie), 204);
		expect(f.recorded('POST', '/v1/refunds')).toHaveLength(1);
		expect(f.recorded('DELETE').map((r) => r.path.split('/').slice(0, 3).join('/'))).toEqual(['/v1/subscriptions', '/v1/customers']);
		expect(h.mail).toContain('Subject: Your Colander account is erased');
		expect(
			await h.run((store) => [
				store.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n,
				store.db.get<{ n: number }>('SELECT count(*) AS n FROM subscriptions')!.n,
				store.db.get('SELECT account_id, actor_name FROM decisions'),
				store.db.get('SELECT actor_name, account_id FROM decision_log WHERE source_id = 900'),
				store.db.get("SELECT target FROM audit_log WHERE action = 'account_deleted'")
			])
		).toEqual([0, 0, { account_id: null, actor_name: null }, { actor_name: null, account_id: null }, { target: id }]);
		expect(await env.BACKUPS.head(`erasures/${id}`)).not.toBeNull();
		// A later webhook for the subscription belongs to an unknown account and changes nothing.
		const late = f.cancel(subscription);
		await expectStatus(await h.do('POST', '/v1/billing/webhook', late, 'Stripe-Signature', await sign(late, 'whsec_test', h.s)), 200);
		// A restore brings the account back; the erasure record deletes it again.
		await h.run((store) => store.db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)', id, 'maya@example.test'));
		expect(await h.run((store) => reapplyErasures(store, env))).toBeGreaterThanOrEqual(1);
		expect(await h.run((store) => store.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')!.n)).toBe(0);
		await env.BACKUPS.delete(`erasures/${id}`);
	});

	it('erases an install: its tags, reports, trial and trial settings', async () => {
		const h = await Harness.create();
		const install = ['Authorization', 'Install ' + 'A'.repeat(21) + 'Q'];
		const tag = { client_id: crypto.randomUUID(), platform: 'yt', target_type: 'source', target_id: '@x', verdict: 'slop', platform_label: false };
		await expectStatus(await h.do('POST', '/v1/tags', { tags: [tag] }, ...install), 200);
		await expectStatus(await h.do('POST', '/v1/reports', { client_id: 'r1', platform: 'yt', source_id: '@x', reason: 'Generated.' }, ...install), 201);
		await expectStatus(await h.do('POST', '/v1/trial', undefined, ...install), 200);
		await expectStatus(await h.do('DELETE', '/v1/install', undefined, ...install), 204);
		expect(
			await h.run((store) =>
				['tags', 'reports', 'trials', 'installs', 'sync_blobs'].map((t) => store.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n)
			)
		).toEqual([0, 0, 0, 0, 0]);
		await expectStatus(await h.do('DELETE', '/v1/install'), 401);
	});
});
