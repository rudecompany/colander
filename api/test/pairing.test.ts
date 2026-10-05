// Pairing codes (src/routes/pairing.ts, contract 7): a code for an active plan or a reviewer, used
// once within 10 minutes from any origin, stored only as a hash, and claims limited per IP.
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { normalizePairCode, type PairCreated, type PairStatus } from '@colander/shared/api';
import { importKeys, verifyPlanToken, type TrustedKey } from '@colander/shared/signing';
import { prune } from '../src/jobs';
import { grantRole } from '../src/store/accounts';
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
		const got = (await res.json()) as { kind: string; token: string };
		expect(got.kind).toBe('plan');
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

	it('gives a reviewer code a reviewer token that replaces the earlier one', async () => {
		const h = await Harness.create();
		await h.run((store) => grantRole(store.db, 'sam@colander.test', 'curator', h.s));
		const sam = await h.signIn('sam@colander.test');
		const tokens: string[] = [];
		for (let i = 0; i < 2; i++) {
			const made = await makeCode(h, sam, 'reviewer');
			const res = await claim(h, made.code, 'ip-hash-198.51.100.7', 'chrome');
			await expectStatus(res, 200);
			const got = (await res.json()) as { kind: string; token: string };
			expect(got.kind).toBe('reviewer');
			tokens.push(got.token);
		}
		expect(await h.run((store) => [store.auth.reviewerAccount(tokens[0]!), store.auth.reviewerAccount(tokens[1]!)?.email])).toEqual([undefined, 'sam@colander.test']);
		const queue = await h.do('GET', '/v1/review/queue', undefined, 'Authorization', `Bearer ${tokens[1]}`);
		await expectStatus(queue, 200);

		// A role taken away before the claim: refused, and the code stays unused.
		const made = await makeCode(h, sam, 'reviewer');
		await h.run((store) => grantRole(store.db, 'sam@colander.test', 'member', h.s));
		const res = await claim(h, made.code);
		await expectStatus(res, 403);
		expect(await pairStatus(h, sam, made.id)).toMatchObject({ status: 'pending' });
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
