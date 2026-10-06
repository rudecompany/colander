// Pairing codes (src/routes/pairing.ts, contract 7): a code for an active plan or a reviewer, used
// once within 10 minutes from any origin, stored only as a hash, and claims limited per IP. A
// reviewer code is the only way to a reviewer token, and needs a fresh passkey sign-in.
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { normalizePairCode, type PairClaimed, type PairCreated, type PairStatus } from '@colander/shared/api';
import { importKeys, verifyPlanToken, type TrustedKey } from '@colander/shared/signing';
import { newToken } from '../src/auth';
import { ACCESS_EMAIL_HEADER, HOST_HEADER } from '../src/http';
import { prune } from '../src/jobs';
import { maskEmail } from '../src/routes/pairing';
import { addPasskey, createSession, grantRole } from '../src/store/accounts';
import { saveSubscription } from '../src/store/billing';
import { errorCode, expectStatus, Harness } from './api';

const MINUTE = 60_000;
const csrf = (cookie: string) => ['Cookie', cookie, 'X-Colander-CSRF', '1'];
const claimBody = (code: string, browser = 'firefox') => ({ code, ext_version: '1.4.0', browser });

let devKeys: TrustedKey[];
beforeAll(async () => {
	devKeys = await importKeys([inject('contract').devPublicKey]);
});

/** A member with Plus running for 30 more days. */
async function plusMember(h: Harness, email = 'maya@example.test'): Promise<{ cookie: string; id: string }> {
	const cookie = await h.signIn(email);
	const id = await h.run((store) => {
		const a = store.db.get<{ id: string }>('SELECT id FROM accounts WHERE email = ?', email)!;
		saveSubscription(store.db, { id: `sub_${a.id}`, accountId: a.id, customerId: 'cus_1', status: 'active', interval: 'year', periodStart: h.s - 86400, periodEnd: h.s + 30 * 86400, ending: false, startDate: h.s - 86400 }, h.s);
		return a.id;
	});
	return { cookie, id };
}

/**
 * A reviewer of role signed in with a passkey just now, as an invite leaves them: the cookie. Review
 * accounts get their passkey only through an invite (test/passkeys.test.ts covers that path).
 */
async function reviewer(h: Harness, email: string, role: 'curator' | 'staff' | 'admin'): Promise<string> {
	return h.run((store) => {
		const a = grantRole(store.db, email, role, h.s, { host: 'job' });
		const { raw, hash } = newToken();
		const passkeyId = addPasskey(store.db, { accountId: a.id, credentialId: `cred-${a.id}`, publicKey: new Uint8Array([1]), signCount: 0, transports: [], backedUp: false, name: '' }, h.s);
		createSession(store.db, { tokenHash: hash, accountId: a.id, method: 'passkey', passkeyId, now: h.s, expires: h.s + 30 * 86400 });
		return `colander_session=${raw}`;
	});
}

async function makeCode(h: Harness, cookie: string, kind: 'plan' | 'reviewer'): Promise<PairCreated> {
	const res = await h.do('POST', '/v1/pair', { kind }, ...csrf(cookie));
	await expectStatus(res, 201);
	return res.json();
}

async function pairStatus(h: Harness, cookie: string, id: string): Promise<PairStatus> {
	const res = await h.do('GET', `/v1/pair/${id}`, undefined, 'Cookie', cookie);
	await expectStatus(res, 200);
	return res.json();
}

const claim = (h: Harness, code: string, ip = 'ip-hash-198.51.100.7', browser = 'firefox') =>
	h.do('POST', '/v1/pair/claim', claimBody(code, browser), 'x-colander-ip-hash', ip);

describe('pairing codes', () => {
	it('reads typed codes as Crockford base32', () => {
		expect(normalizePairCode('KXQ4-JP7M')).toBe('KXQ4JP7M');
		expect(normalizePairCode(' kxq4 jp7m ')).toBe('KXQ4JP7M');
		expect(normalizePairCode('ILO0-ABCD')).toBe('1100ABCD');
		for (const bad of ['', 'KXQ4-JP7', 'KXQ4-JP7MM', 'KXQ4-JP7U', 'KXQ4_JP7M']) expect(normalizePairCode(bad), bad).toBeNull();
	});

	it('names the account a code came from by a masked email', () => {
		expect(['pat@colander.test', 'a@b.example', 'no-at-sign', ''].map(maskEmail)).toEqual(['p***@colander.test', 'a***@b.example', 'n***', '***']);
	});

	it('hands an active plan to the extension once, as a plan token for the account', async () => {
		const h = await Harness.create();
		const maya = await plusMember(h);
		const made = await makeCode(h, maya.cookie, 'plan');
		expect(made.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(Date.parse(made.expires_at)).toBe(h.clock + 10 * MINUTE);
		expect(await pairStatus(h, maya.cookie, made.id)).toEqual({ status: 'pending', ext_version: null, browser: null });
		// Only a hash is stored.
		const stored = await h.run((store) => JSON.stringify(store.db.all('SELECT * FROM pairings')));
		expect(stored).not.toContain(made.code.replace('-', ''));

		// Typed in lowercase without the dash, from any origin.
		const res = await claim(h, made.code.replace('-', '').toLowerCase());
		await expectStatus(res, 200);
		const got = (await res.json()) as PairClaimed;
		expect(got.kind).toBe('plan');
		// Whose account it is, so a person handed someone else's code can tell.
		expect(got.account).toBe('m***@example.test');
		const claims = await verifyPlanToken(got.token, devKeys);
		expect(claims).toMatchObject({ sub: maya.id, plan: 'plus', trial: false, exp: h.s + 30 * 86400 + 3 * 86400 });
		expect(await pairStatus(h, maya.cookie, made.id)).toEqual({ status: 'claimed', ext_version: '1.4.0', browser: 'firefox' });

		// Single use.
		const again = await claim(h, made.code);
		await expectStatus(again, 404);
		expect(await errorCode(again)).toBe('invalid_code');
	});

	it('refuses a plan code without an active plan, and a reviewer code for members', async () => {
		const h = await Harness.create();
		const member = await h.signIn('maya@example.test');
		let res = await h.do('POST', '/v1/pair', { kind: 'plan' }, ...csrf(member));
		await expectStatus(res, 404);
		expect(await errorCode(res)).toBe('no_plan');
		res = await h.do('POST', '/v1/pair', { kind: 'reviewer' }, ...csrf(member));
		await expectStatus(res, 403);
		expect(await errorCode(res)).toBe('forbidden');
		res = await h.do('POST', '/v1/pair', { kind: 'admin' }, ...csrf(member));
		await expectStatus(res, 400);
		expect(await errorCode(res)).toBe('invalid_kind');
		// Signed out, and without the CSRF header.
		await expectStatus(await h.do('POST', '/v1/pair', { kind: 'plan' }, 'X-Colander-CSRF', '1'), 401);
		await expectStatus(await h.do('POST', '/v1/pair', { kind: 'plan' }, 'Cookie', member), 403);
		// Nobody reads another account's code.
		const other = await plusMember(h, 'lee@example.test');
		const made = await makeCode(h, other.cookie, 'plan');
		await expectStatus(await h.do('GET', `/v1/pair/${made.id}`, undefined, 'Cookie', member), 404);
	});

	it('gives a reviewer code, after a fresh passkey sign-in, a 7-day reviewer token that replaces the earlier one', async () => {
		const h = await Harness.create();
		const sam = await reviewer(h, 'sam@colander.test', 'curator');
		// An email code alone gives member rights: no reviewer code.
		const code = await h.signIn('sam@colander.test');
		const refused = await h.do('POST', '/v1/pair', { kind: 'reviewer' }, ...csrf(code));
		await expectStatus(refused, 403);
		expect(await errorCode(refused)).toBe('passkey_required');
		const tokens: string[] = [];
		for (let i = 0; i < 2; i++) {
			const made = await makeCode(h, sam, 'reviewer');
			const res = await claim(h, made.code, 'ip-hash-198.51.100.7', 'chrome');
			await expectStatus(res, 200);
			const got = (await res.json()) as { kind: string; token: string };
			expect(got.kind).toBe('reviewer');
			tokens.push(got.token);
		}
		expect(tokens[1]).toMatch(/^colander_rt_/);
		expect(await h.run((store) => [store.auth.reviewerAccount(tokens[0]!), store.auth.reviewerAccount(tokens[1]!)])).toEqual([undefined, expect.objectContaining({ email: 'sam@colander.test' })]);
		const queue = await h.do('GET', '/v1/review/queue', undefined, 'Authorization', `Bearer ${tokens[1]}`);
		await expectStatus(queue, 200);
		// Each issue is in the audit log, and the account page shows when the connection ends.
		expect(await h.run((store) => store.db.all("SELECT action, reason FROM audit_log WHERE action = 'token_issued'"))).toEqual([
			{ action: 'token_issued', reason: 'pairing code' },
			{ action: 'token_issued', reason: 'pairing code' }
		]);
		const me = (await (await h.do('GET', '/v1/account', undefined, 'Cookie', sam)).json()) as { account: { reviewer_token: { expires_at: string } } };
		expect(me.account.reviewer_token.expires_at).toBe('2026-10-08T12:00:00Z');
		h.clock += 7 * 86_400_000;
		expect(await errorCode(await h.do('GET', '/v1/review/queue', undefined, 'Authorization', `Bearer ${tokens[1]}`))).toBe('token_expired');
		// The passkey sign-in is a week old now: a new code needs it again.
		expect(await errorCode(await h.do('POST', '/v1/pair', { kind: 'reviewer' }, ...csrf(sam)))).toBe('recent_auth_required');
		h.clock -= 7 * 86_400_000;

		// A role taken away before the claim: refused, and the code stays unused.
		const made = await makeCode(h, sam, 'reviewer');
		await h.run((store) => grantRole(store.db, 'sam@colander.test', 'member', h.s, { host: 'job' }));
		const res = await claim(h, made.code);
		await expectStatus(res, 403);
		expect(await pairStatus(h, sam, made.id)).toMatchObject({ status: 'pending' });
	});

	it('ends unused codes when every session ends', async () => {
		const h = await Harness.create();
		const sam = await reviewer(h, 'sam@colander.test', 'curator');
		const made = await makeCode(h, sam, 'reviewer');
		await expectStatus(await h.do('POST', '/v1/auth/logout', { everywhere: true }, ...csrf(sam)), 204);
		expect(await errorCode(await claim(h, made.code))).toBe('invalid_code');
		expect(await h.run((store) => store.db.all('SELECT 1 FROM reviewer_tokens'))).toEqual([]);
	});

	it('ends an unused reviewer code on Disconnect, so no code shown before it connects the side panel again', async () => {
		const h = await Harness.create();
		const sam = await reviewer(h, 'sam@colander.test', 'curator');
		const first = await (await claim(h, (await makeCode(h, sam, 'reviewer')).code)).json<{ token: string }>();
		const waiting = await makeCode(h, sam, 'reviewer');
		await expectStatus(await h.do('DELETE', '/v1/account/reviewer-token', undefined, ...csrf(sam)), 204);
		expect(await errorCode(await h.do('GET', '/v1/review/queue', undefined, 'Authorization', `Bearer ${first.token}`))).toBe('invalid_token');
		expect(await errorCode(await claim(h, waiting.code))).toBe('invalid_code');
		// A code alone, with no token yet, ends the same way, and both are in the audit log.
		const alone = await makeCode(h, sam, 'reviewer');
		await expectStatus(await h.do('DELETE', '/v1/account/reviewer-token', undefined, ...csrf(sam)), 204);
		expect(await errorCode(await claim(h, alone.code))).toBe('invalid_code');
		expect(await h.run((store) => store.db.all("SELECT action FROM audit_log WHERE action = 'token_revoked'"))).toHaveLength(2);
	});

	// A token works in any browser on any device, so staff authority stays on the admin host.
	it('gives staff and admins a reviewer token with curator authority only', async () => {
		const h = await Harness.create();
		const rae = await reviewer(h, 'rae@colander.test', 'staff');
		const res = await claim(h, (await makeCode(h, rae, 'reviewer')).code);
		await expectStatus(res, 200);
		const got = (await res.json()) as PairClaimed;
		expect(got).toMatchObject({ kind: 'reviewer', account: 'r***@colander.test' });
		const bearer = ['Authorization', `Bearer ${got.token}`];
		const decision = { verdict: 'likely_slop', reason: 'Generated narration over stock footage.', signals: ['watermark'] };
		const admin = [HOST_HEADER, 'admin', ACCESS_EMAIL_HEADER, 'rae@colander.test', 'X-Colander-CSRF', '1'];
		await expectStatus(await h.do('POST', '/v1/review/sources/yt/@bignarration/decision', { ...decision, large: true }, ...admin), 200);
		const refused = await h.do('POST', '/v1/review/sources/yt/@bignarration/decision', decision, ...bearer);
		await expectStatus(refused, 403);
		expect(await errorCode(refused)).toBe('staff_required');
		// Curator work goes through, and is logged as a curator's.
		await expectStatus(await h.do('POST', '/v1/review/sources/yt/@smallnarration/decision', decision, ...bearer), 200);
		const small = await h.do('GET', '/v1/review/sources/yt/@smallnarration', undefined, ...bearer);
		expect(((await small.json()) as { history: { actor: string }[] }).history.map((e) => e.actor)).toEqual(['curator']);
		// An admin's code works the same way.
		const ada = await reviewer(h, 'ada@colander.test', 'admin');
		const adas = (await (await claim(h, (await makeCode(h, ada, 'reviewer')).code, 'ip-hash-203.0.113.5')).json()) as PairClaimed;
		const big = await h.do('POST', '/v1/review/sources/yt/@bignarration/decision', decision, 'Authorization', `Bearer ${adas.token}`);
		expect(await errorCode(big)).toBe('staff_required');
	});

	it('expires after 10 minutes, and a new code ends the one before', async () => {
		const h = await Harness.create();
		const maya = await plusMember(h);
		const first = await makeCode(h, maya.cookie, 'plan');
		const second = await makeCode(h, maya.cookie, 'plan');
		expect(await pairStatus(h, maya.cookie, first.id)).toMatchObject({ status: 'expired' });
		await expectStatus(await claim(h, first.code), 404);

		h.clock += 10 * MINUTE;
		expect(await pairStatus(h, maya.cookie, second.id)).toMatchObject({ status: 'expired' });
		const res = await claim(h, second.code);
		await expectStatus(res, 404);
		expect(await errorCode(res)).toBe('invalid_code');

		// The plan ended after the code was made: the claim is refused and the code stays.
		const third = await makeCode(h, maya.cookie, 'plan');
		await h.run((store) => store.db.run("UPDATE subscriptions SET status = 'canceled', period_end = ?", h.s - 4 * 86400));
		const ended = await claim(h, third.code);
		await expectStatus(ended, 404);
		expect(await errorCode(ended)).toBe('no_plan');
		expect(await pairStatus(h, maya.cookie, third.id)).toMatchObject({ status: 'pending' });

		// The hourly prune drops codes an hour after they expired.
		h.clock += 71 * MINUTE;
		expect(await h.run((store) => (prune(store.db, h.clock), store.db.get<{ n: number }>('SELECT count(*) AS n FROM pairings')!.n))).toBe(0);
	});

	it('limits claims to 10 per IP per 10 minutes, wrong codes included', async () => {
		const h = await Harness.create();
		const maya = await plusMember(h);
		const made = await makeCode(h, maya.cookie, 'plan');
		for (let i = 0; i < 10; i++) expect(await errorCode(await claim(h, 'AAAA-AAAA'))).toBe('invalid_code');
		const limited = await claim(h, made.code);
		await expectStatus(limited, 429);
		expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
		// Another address is not held back, and the first one gets a try again after a minute.
		await expectStatus(await claim(h, 'AAAA-AAAA', 'ip-hash-203.0.113.9'), 404);
		h.clock += MINUTE;
		await expectStatus(await claim(h, made.code), 200);
	});

	it('counts wrong codes from all addresses for the watchdog, without refusing anyone', async () => {
		const h = await Harness.create();
		const maya = await plusMember(h);
		const made = await makeCode(h, maya.cookie, 'plan');
		const status = () => h.run((store) => store.watchdog().then((s) => s.pairGuessing));
		for (let i = 0; i < 299; i++) await claim(h, 'AAAA-AAAA', `ip-hash-${i}`);
		expect(await status()).toBe(false);
		expect(await errorCode(await claim(h, 'AAAA-AAAA', 'ip-hash-299'))).toBe('invalid_code');
		expect(await status()).toBe(true);
		// A real code from a fresh address still works, and the alert ends as the count drains.
		await expectStatus(await claim(h, made.code, 'ip-hash-fresh'), 200);
		h.clock += 60 * MINUTE;
		expect(await status()).toBe(false);
	});

	it('checks the claim body', async () => {
		const h = await Harness.create();
		const res = (body: unknown) => h.do('POST', '/v1/pair/claim', body);
		expect(await errorCode(await res({ ...claimBody('AAAA-AAAA'), browser: 'netscape' }))).toBe('invalid_field');
		expect(await errorCode(await res({ ...claimBody('AAAA-AAAA'), browser: 'constructor' }))).toBe('invalid_field');
		expect(await errorCode(await res({ ...claimBody('AAAA-AAAA'), ext_version: '1.0 beta' }))).toBe('invalid_field');
		expect(await errorCode(await res({ ...claimBody('AAAA-AAAA'), install_id: 'x' }))).toBe('unknown_field');
	});

	it('answers the claim from any origin through the Worker', async () => {
		const pre = await exports.default.fetch(
			new Request('https://getcolander.com/v1/pair/claim', { method: 'OPTIONS', headers: { Origin: 'moz-extension://abc', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
		);
		expect(pre.status).toBe(204);
		expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const create = await exports.default.fetch(new Request('https://getcolander.com/v1/pair', { method: 'OPTIONS', headers: { Origin: 'moz-extension://abc', 'Access-Control-Request-Method': 'POST' } }));
		expect(create.status).toBe(404);
	});
});
