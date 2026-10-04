// Billing (src/billing.ts and src/routes/billing.ts) against an in-memory Stripe: the port of
// server/internal/billing/webhook_test.go and server/internal/api/billing_test.go, plus the
// webhook's one transaction and the edge headers of the public billing routes. Settings sync
// belongs to the sync routes; here its check is the predicate it uses, tokenExpiry(current()).
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { b64decode } from '@colander/shared/bytes';
import { importKeys, issuePlanToken, planActive, SigningKey, verifyPlanToken, type TrustedKey } from '@colander/shared/signing';
import { API_VERSION, Billing, billingConfig, GRACE, SignatureError, tokenExpiry, verifySignature } from '../src/billing';
import { current } from '../src/store/billing';
import { errorCode, expectStatus, Harness } from './api';
import { ORIGIN, sign, StripeFake, type StripeRequest } from './stripe-fake';

const WEBHOOK_SECRET = 'whsec_test_colander';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let devKeys: TrustedKey[];
beforeAll(async () => {
	devKeys = await importKeys([inject('contract').devPublicKey]);
});

interface Plan {
	plan: string;
	interval: string;
	status: string;
	current_period_end: string;
	cancel_at_period_end: boolean;
	refundable: boolean;
}

/** Switches billing on against a fake Stripe that shares the harness clock (Go's h.stripe). */
async function stripe(h: Harness, managed = true, secretKey = 'sk_test_colander'): Promise<StripeFake> {
	const f = new StripeFake();
	f.now = () => h.s;
	f.prices = { price_plus_year: { amount: 3000, interval: 'year' }, price_plus_month: { amount: 300, interval: 'month' } };
	await h.run((store) => {
		store.billing = new Billing(store.db, {
			secretKey,
			webhookSecret: WEBHOOK_SECRET,
			priceMonthly: 'price_plus_month',
			priceYearly: 'price_plus_year',
			managedPayments: managed,
			apiBase: ORIGIN,
			publicUrl: 'http://localhost:8787'
		});
		store.billing.fetch = f.fetch;
	});
	return f;
}

/** Posts signed webhook events and expects each to be accepted. */
async function deliver(h: Harness, ...events: string[]): Promise<void> {
	for (const ev of events) await expectStatus(await h.do('POST', '/v1/billing/webhook', ev, 'Stripe-Signature', await sign(ev, WEBHOOK_SECRET, h.s)), 200);
}

const csrf = (cookie: string) => ['Cookie', cookie, 'X-Colander-CSRF', '1'];

/** Starts a checkout as the signed-in cookie and returns the session id from its URL. */
async function checkout(h: Harness, cookie: string, price: string): Promise<string> {
	const res = await h.do('POST', '/v1/billing/checkout', { price }, ...csrf(cookie));
	await expectStatus(res, 200);
	return ((await res.json()) as { url: string }).url.split('/').pop()!;
}

async function plan(h: Harness, cookie: string): Promise<Plan | null> {
	const res = await h.do('GET', '/v1/account', undefined, 'Cookie', cookie);
	await expectStatus(res, 200);
	return ((await res.json()) as { account: { plan: Plan | null } }).account.plan;
}

async function account(h: Harness, cookie: string): Promise<{ id: string }> {
	return ((await (await h.do('GET', '/v1/account', undefined, 'Cookie', cookie)).json()) as { account: { id: string } }).account;
}

async function entitlement(h: Harness, cookie: string): Promise<[token: string, status: number]> {
	const res = await h.do('POST', '/v1/entitlement', undefined, ...csrf(cookie));
	return [res.status === 200 ? ((await res.json()) as { token: string }).token : '', res.status];
}

/** The id of the newest stored subscription. */
const subId = (h: Harness) => h.run((store) => store.db.get<{ id: string }>('SELECT id FROM subscriptions ORDER BY created_at DESC LIMIT 1')!.id);

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

describe('verifySignature', () => {
	it('accepts any matching v1 within 5 minutes and refuses everything else (Go TestVerifySignature)', async () => {
		const secret = 'whsec_unit';
		const now = Date.UTC(2026, 9, 3, 12) / 1000;
		const payload = '{"id":"evt_1","type":"invoice.paid"}';
		const bytes = (s: string) => new TextEncoder().encode(s);
		const good = await sign(payload, secret, now);
		const ts = `t=${now}`;
		const ok = [
			good,
			good + ',v1=' + '00' + good.slice(-62), // an extra v1 from a rolled secret
			ts + ',v1=deadbeef,' + good.slice(ts.length + 1), // the matching v1 second
			good + ',v0=ignored'
		];
		for (const header of ok) await expect(verifySignature(bytes(payload), header, secret, now), header).resolves.toBeUndefined();
		await expect(verifySignature(bytes(payload), good, secret, now + 4 * 60)).resolves.toBeUndefined();

		const bad: Record<string, [string, string]> = {
			'tampered payload': [good, '{"id":"evt_1","type":"invoice.paid "}'],
			'wrong secret': [await sign(payload, 'whsec_other', now), payload],
			stale: [await sign(payload, secret, now - 6 * 60), payload],
			'from the future': [await sign(payload, secret, now + 6 * 60), payload],
			'no v1': [ts, payload],
			'no timestamp': [good.slice(ts.length + 1), payload],
			empty: ['', payload],
			'not hex': [ts + ',v1=zz', payload]
		};
		for (const [name, [header, body]] of Object.entries(bad)) {
			await expect(verifySignature(bytes(body), header, secret, now), name).rejects.toBeInstanceOf(SignatureError);
		}
		// An empty secret never verifies.
		await expect(verifySignature(bytes(payload), good, '', now)).rejects.toBeInstanceOf(SignatureError);
	});
});

describe('billing routes', () => {
	it('answer 503 without keys while stored state still answers', async () => {
		const h = await Harness.create();
		await h.run((store) => {
			store.billing = new Billing(store.db, billingConfig({ PUBLIC_URL: 'http://localhost:8787', STRIPE_PRICE_PLUS_MONTHLY: '', STRIPE_PRICE_PLUS_YEARLY: '', STRIPE_MANAGED_PAYMENTS: '' }));
		});
		const cookie = await h.signIn('maya@example.test');
		for (const [path, body] of [
			['/v1/billing/checkout', { price: 'plus_yearly' }],
			['/v1/billing/donate', { amount_cents: 500, recurring: false }],
			['/v1/billing/cancel', { refund: false }],
			['/v1/billing/webhook', '{"id":"evt_1"}']
		] as const) {
			const res = await h.do('POST', path, body, ...csrf(cookie));
			await expectStatus(res, 503);
			expect(await errorCode(res), path).toBe('billing_unavailable');
		}
		// No plan, no token, an empty supporters list.
		expect(await plan(h, cookie)).toBeNull();
		expect((await entitlement(h, cookie))[1]).toBe(404);
		const res = await h.do('GET', '/v1/supporters');
		await expectStatus(res, 200);
		expect((await res.text()).trim()).toBe('{"supporters":[]}');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('read their config from the environment', () => {
		const base = { PUBLIC_URL: 'https://getcolander.com/', STRIPE_PRICE_PLUS_MONTHLY: 'price_m', STRIPE_PRICE_PLUS_YEARLY: 'price_y' };
		expect(billingConfig({ ...base, STRIPE_MANAGED_PAYMENTS: '', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })).toEqual({
			secretKey: 'sk_live_x',
			webhookSecret: 'whsec_x',
			priceMonthly: 'price_m',
			priceYearly: 'price_y',
			managedPayments: true,
			apiBase: 'https://api.stripe.com',
			publicUrl: 'https://getcolander.com'
		});
		expect(billingConfig({ ...base, STRIPE_MANAGED_PAYMENTS: '0' }).managedPayments).toBe(false);
		expect(billingConfig({ ...base, STRIPE_MANAGED_PAYMENTS: 'false', STRIPE_API_BASE: 'http://127.0.0.1:9/' }).apiBase).toBe('http://127.0.0.1:9');
	});

	it('send Plus checkout through Managed Payments and donations through regular Checkout', async () => {
		const h = await Harness.create();
		let f = await stripe(h);
		const cookie = await h.signIn('maya@example.test');
		const acct = await account(h, cookie);

		await checkout(h, cookie, 'plus_yearly');
		const req = f.recorded('POST', '/v1/checkout/sessions')[0]!;
		const want: Record<string, string> = {
			mode: 'subscription',
			'line_items[0][price]': 'price_plus_year',
			'line_items[0][quantity]': '1',
			'managed_payments[enabled]': 'true',
			client_reference_id: acct.id,
			customer_email: 'maya@example.test',
			'subscription_data[metadata][account_id]': acct.id,
			'subscription_data[metadata][kind]': 'plus',
			success_url: 'http://localhost:8787/plans/welcome',
			cancel_url: 'http://localhost:8787/plans?checkout=plus_yearly&cancelled=1'
		};
		for (const [k, v] of Object.entries(want)) expect(req.form.get(k), k).toBe(v);
		// Managed Payments rejects these, so they must never be sent.
		for (const k of req.form.keys()) {
			expect(/^(automatic_tax|payment_method|shipping|tax_id|customer_update)|^invoice_creation$/.test(k), k).toBe(false);
		}
		expect(req.headers.get('Stripe-Version')).toBe(API_VERSION);
		expect(API_VERSION).toBe('2026-04-22.dahlia');
		expect(req.headers.get('Authorization')).toBe('Bearer sk_test_colander');
		expect(req.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');

		await checkout(h, cookie, 'plus_monthly');
		expect(f.recorded('POST', '/v1/checkout/sessions')[1]!.form.get('line_items[0][price]')).toBe('price_plus_month');
		let res = await h.do('POST', '/v1/billing/checkout', { price: 'family_yearly' }, ...csrf(cookie));
		await expectStatus(res, 400);
		expect(await errorCode(res)).toBe('invalid_price');
		await expectStatus(await h.do('POST', '/v1/billing/checkout', { price: 'plus_yearly' }), 403); // no CSRF header

		// With Managed Payments switched off the flag is not sent at all.
		const off = await stripe(h, false);
		await checkout(h, cookie, 'plus_yearly');
		expect(off.recorded('POST', '/v1/checkout/sessions')[0]!.form.has('managed_payments[enabled]')).toBe(false);

		// Donations: regular Checkout, never Managed Payments, with the amount as price_data.
		f = await stripe(h);
		const donate = async (body: Record<string, unknown>): Promise<StripeRequest> => {
			await expectStatus(await h.do('POST', '/v1/billing/donate', body), 200);
			return f.recorded('POST', '/v1/checkout/sessions').pop()!;
		};
		const once = await donate({ amount_cents: 500, recurring: false, credit_name: '  Ana  ' });
		for (const [k, v] of Object.entries({
			mode: 'payment',
			submit_type: 'donate',
			'line_items[0][price_data][unit_amount]': '500',
			'line_items[0][price_data][currency]': 'usd',
			'metadata[kind]': 'donation',
			'metadata[credit_name]': 'Ana',
			success_url: 'http://localhost:8787/support/thanks',
			cancel_url: 'http://localhost:8787/support?cancelled=1'
		})) {
			expect(once.form.get(k), k).toBe(v);
		}
		const monthly = await donate({ amount_cents: 1000, recurring: true });
		expect([
			monthly.form.get('mode'),
			monthly.form.get('line_items[0][price_data][recurring][interval]'),
			monthly.form.get('subscription_data[metadata][kind]')
		]).toEqual(['subscription', 'month', 'donation']);
		for (const r of [once, monthly]) expect(r.form.has('managed_payments[enabled]')).toBe(false);
		// An empty credit name is not sent.
		expect(monthly.form.has('metadata[credit_name]')).toBe(false);
		for (const [bad, code] of [
			[{ amount_cents: 99 }, 'invalid_amount'],
			[{ amount_cents: 100001 }, 'invalid_amount'],
			[{ amount_cents: 500, credit_name: 'two\nlines' }, 'invalid_credit_name'],
			[{ amount_cents: 500, credit_name: 'x'.repeat(81) }, 'invalid_credit_name'],
			[{ amount_cents: 5.5 }, 'invalid_json'],
			['{"amount_cents": 500.0}', 'invalid_json'],
			['{"amount_cents": 5e2}', 'invalid_json']
		] as const) {
			res = await h.do('POST', '/v1/billing/donate', bad);
			await expectStatus(res, 400);
			expect(await errorCode(res)).toBe(code);
		}
		// Donations are limited to 10 per client address an hour.
		for (let i = 0; i < 8; i++) await h.do('POST', '/v1/billing/donate', { amount_cents: 300 });
		res = await h.do('POST', '/v1/billing/donate', { amount_cents: 300 });
		await expectStatus(res, 429);
		expect(res.headers.get('Retry-After')).toBe('360');
	});

	it('answer 502 when Stripe refuses the call, and change nothing', async () => {
		const h = await Harness.create();
		const f = await stripe(h, true, 'rk_wrong');
		const cookie = await h.signIn('maya@example.test');
		const res = await h.do('POST', '/v1/billing/checkout', { price: 'plus_yearly' }, ...csrf(cookie));
		await expectStatus(res, 502);
		expect(await errorCode(res)).toBe('payment_provider_error');
		expect(f.recorded()).toHaveLength(1);
		expect(await plan(h, cookie)).toBeNull();
	});

	it('verify webhook signatures and apply each event once', async () => {
		const h = await Harness.create();
		const f = await stripe(h);
		const cookie = await h.signIn('maya@example.test');
		const created = f.pay(await checkout(h, cookie, 'plus_yearly'))[0]!;
		const post = async (body: string, sig: string) => (await h.do('POST', '/v1/billing/webhook', body, 'Stripe-Signature', sig)).status;

		const tampered = created.replace('"active"', '"trialing"');
		expect(tampered).not.toBe(created);
		expect(await post(tampered, await sign(created, WEBHOOK_SECRET, h.s))).toBe(400);
		expect(await post(created, await sign(created, 'whsec_wrong', h.s))).toBe(400);
		expect(await post(created, await sign(created, WEBHOOK_SECRET, h.s - 6 * 60))).toBe(400);
		const res = await h.do('POST', '/v1/billing/webhook', created, 'Stripe-Signature', '');
		await expectStatus(res, 400);
		expect(await errorCode(res)).toBe('invalid_signature');
		expect(await plan(h, cookie)).toBeNull();
		// Stripe may send several v1 signatures while a secret rolls; any one may match.
		const good = await sign(created, WEBHOOK_SECRET, h.s);
		expect(await post(created, good + ',v1=' + 'ab'.repeat(32))).toBe(200);
		expect(await plan(h, cookie)).not.toBeNull();

		const calls = f.recorded().length;
		expect(await post(created, good)).toBe(200);
		expect(f.recorded()).toHaveLength(calls); // a replayed event is not applied again
		// A body over 1 MiB is refused before anything else.
		expect(await post(' '.repeat((1 << 20) + 1), good)).toBe(413);
	});

	it('apply an event and record it in one transaction, so a failed write is retried whole', async () => {
		const h = await Harness.create();
		const f = await stripe(h);
		const cookie = await h.signIn('maya@example.test');
		const created = f.pay(await checkout(h, cookie, 'plus_yearly'))[0]!;
		await h.run((store) => store.db.run("CREATE TRIGGER no_events BEFORE INSERT ON billing_events BEGIN SELECT RAISE(ABORT, 'events are down'); END"));
		const res = await h.do('POST', '/v1/billing/webhook', created, 'Stripe-Signature', await sign(created, WEBHOOK_SECRET, h.s));
		await expectStatus(res, 500);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe('The event could not be applied. Stripe will retry it.');
		expect(await h.run((store) => store.db.get<{ n: number }>('SELECT count(*) AS n FROM subscriptions')!.n)).toBe(0);
		await h.run((store) => store.db.run('DROP TRIGGER no_events'));
		await deliver(h, created);
		expect((await plan(h, cookie))?.status).toBe('active');
	});

	it('run the Plus lifecycle and its plan tokens', async () => {
		const h = await Harness.create();
		const f = await stripe(h);
		let cookie = await h.signIn('maya@example.test');
		const acct = await account(h, cookie);
		const start = h.clock;
		await deliver(h, ...f.pay(await checkout(h, cookie, 'plus_yearly')));

		const periodEnd = Date.UTC(2027, 9, 1, 12);
		expect(await plan(h, cookie)).toEqual({
			plan: 'plus',
			interval: 'year',
			status: 'active',
			current_period_end: iso(periodEnd),
			cancel_at_period_end: false,
			refundable: true
		});
		expect(start).toBe(Date.UTC(2026, 9, 1, 12));
		let res = await h.do('POST', '/v1/billing/checkout', { price: 'plus_monthly' }, ...csrf(cookie));
		await expectStatus(res, 409);
		expect(await errorCode(res)).toBe('already_subscribed');

		// The token verifies with the published dev key and lasts until the period ends plus 3 days.
		const [token, status] = await entitlement(h, cookie);
		expect(status).toBe(200);
		const c = await verifyPlanToken(token, devKeys);
		expect(c).toEqual({ v: 1, sub: acct.id, plan: 'plus', trial: false, iat: h.s, exp: periodEnd / 1000 + GRACE });
		expect(planActive(c, h.clock)).toBe(true);
		expect(planActive(c, c!.exp * 1000)).toBe(false);

		// A refreshed token keeps the account as sub, so settings sync keeps one blob.
		h.clock += DAY;
		res = await h.do('POST', '/v1/entitlement/refresh', { token });
		await expectStatus(res, 200);
		const fresh = ((await res.json()) as { token: string }).token;
		expect(await verifyPlanToken(fresh, devKeys)).toEqual({ ...c, iat: h.s });

		// A failed renewal keeps Plus for 3 days of grace from the start of the unpaid period.
		h.clock = periodEnd + HOUR;
		cookie = await h.signIn('maya@example.test'); // sessions last 30 days
		await deliver(h, ...f.renew(await subId(h), false));
		expect(await plan(h, cookie)).toMatchObject({ status: 'past_due', refundable: false });
		expect((await verifyPlanToken((await entitlement(h, cookie))[0], devKeys))?.exp).toBe(periodEnd / 1000 + GRACE);
		await deliver(h, ...f.renew(await subId(h), true));

		// Cancel at period end: one click, Plus stays on, a calm email.
		h.mail = '';
		res = await h.do('POST', '/v1/billing/cancel', { refund: false }, ...csrf(cookie));
		await expectStatus(res, 200);
		expect(((await res.json()) as { account: { plan: Plan } }).account.plan).toMatchObject({ status: 'active', cancel_at_period_end: true });
		expect(h.mail).toContain('Plus stays on until 1 October 2028');
		const sub = await subId(h);
		const posts = f.recorded('POST', `/v1/subscriptions/${sub}`);
		expect(posts.map((r) => r.form.get('cancel_at_period_end'))).toEqual(['true']);
		expect((await entitlement(h, cookie))[1]).toBe(200); // Plus stays on until the period ends

		// The period ends: Stripe deletes the subscription. No more tokens, and refresh says no_plan.
		await deliver(h, f.cancel(sub));
		expect(await plan(h, cookie)).toMatchObject({ status: 'canceled', refundable: false });
		expect((await entitlement(h, cookie))[1]).toBe(404);
		res = await h.do('POST', '/v1/entitlement/refresh', { token: fresh });
		await expectStatus(res, 404);
		expect(await errorCode(res)).toBe('no_plan');
		res = await h.do('POST', '/v1/billing/cancel', { refund: false }, ...csrf(cookie));
		await expectStatus(res, 404);
		expect(await errorCode(res)).toBe('no_plan');

		// Coming back reuses the Stripe customer.
		await checkout(h, cookie, 'plus_monthly');
		const last = f.recorded('POST', '/v1/checkout/sessions').pop()!.form;
		expect(last.get('customer')).toMatch(/^cus_/);
		expect(last.has('customer_email')).toBe(false);
	});

	it('refund a charge under 30 days old and end Plus at once', async () => {
		const h = await Harness.create();
		const f = await stripe(h);
		let old = await h.signIn('old@example.test');
		await deliver(h, ...f.pay(await checkout(h, old, 'plus_yearly')));
		h.clock += 20 * DAY;
		const recent = await h.signIn('recent@example.test');
		await deliver(h, ...f.pay(await checkout(h, recent, 'plus_yearly')));
		h.clock += 11 * DAY; // old paid 31 days ago, recent 11 days ago
		old = await h.signIn('old@example.test'); // sessions last 30 days

		expect((await plan(h, old))?.refundable).toBe(false);
		let res = await h.do('POST', '/v1/billing/cancel', { refund: true }, ...csrf(old));
		await expectStatus(res, 409);
		expect(await errorCode(res)).toBe('not_refundable');
		expect(f.recorded('POST', '/v1/refunds')).toEqual([]);
		expect(await plan(h, old)).toMatchObject({ status: 'active', cancel_at_period_end: false });

		expect((await plan(h, recent))?.refundable).toBe(true);
		h.mail = '';
		res = await h.do('POST', '/v1/billing/cancel', { refund: true }, ...csrf(recent));
		await expectStatus(res, 200);
		const refunds = f.recorded('POST', '/v1/refunds');
		expect(refunds).toHaveLength(1);
		const pi = refunds[0]!.form.get('payment_intent')!;
		expect(pi).toMatch(/^pi_/);
		expect(refunds[0]!.headers.get('Idempotency-Key')).toBe(`colander-refund-${pi}`);
		expect(refunds[0]!.form.get('reason')).toBe('requested_by_customer');
		const sub = await h.run((store) => store.db.get<{ id: string }>("SELECT s.id FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE a.email = 'recent@example.test'")!.id);
		expect(f.recorded('DELETE', `/v1/subscriptions/${sub}`)).toHaveLength(1);
		expect(f.recorded('POST', `/v1/subscriptions/${sub}`)).toEqual([]);
		expect(((await res.json()) as { account: { plan: Plan } }).account.plan).toMatchObject({ status: 'canceled', refundable: false });
		expect(h.mail).toContain('We refunded your last Plus charge');

		// Stripe's charge.refunded for our own refund changes nothing further.
		await deliver(h, f.refunded(pi));
		expect((await entitlement(h, recent))[1]).toBe(404);
		// Settings sync stops at once: the predicate the sync routes check is over.
		const id = (await account(h, recent)).id;
		expect(await h.run((store) => tokenExpiry(current(store.db, id)!))).toBe(0);
		expect(await h.run((store) => store.db.get('SELECT refunded_at FROM subscriptions WHERE id = ?', sub))).toEqual({ refunded_at: h.s });
	});

	it('never refresh trial tokens into paid ones', async () => {
		const h = await Harness.create();
		const key = await SigningKey.fromSeed(b64decode(env.COLANDER_SIGNING_KEY));
		const trial = await issuePlanToken(key, { v: 1, sub: 'trl_abcdefghijkmnpqr', plan: 'plus', trial: true, iat: h.s, exp: h.s + 14 * 86400 });
		let res = await h.do('POST', '/v1/entitlement/refresh', { token: trial });
		await expectStatus(res, 404);
		expect(await errorCode(res)).toBe('no_plan');
		res = await h.do('POST', '/v1/entitlement/refresh', { token: 'not.a-token' });
		await expectStatus(res, 400);
		expect(await errorCode(res)).toBe('invalid_plan');
		// A token from another key does not verify either.
		const other = await SigningKey.fromSeed(new Uint8Array(32).fill(7));
		res = await h.do('POST', '/v1/entitlement/refresh', { token: await issuePlanToken(other, { v: 1, sub: 'acc_x', plan: 'plus', trial: false, iat: h.s, exp: h.s + 60 }) });
		await expectStatus(res, 400);
	});

	it('list credited supporters once each, newest first, without amounts, emails or refunds', async () => {
		const h = await Harness.create();
		const f = await stripe(h);
		const give = async (name: string, recurring: boolean): Promise<string> => {
			const res = await h.do('POST', '/v1/billing/donate', { amount_cents: 1000, recurring, credit_name: name });
			await expectStatus(res, 200);
			const events = f.pay(((await res.json()) as { url: string }).url.split('/').pop()!);
			await deliver(h, ...events);
			h.clock += HOUR;
			return events[events.length - 1]!;
		};
		await give('Ana', false);
		await give('', false);
		await give('Tomasz K.', true);
		const refundMe = await give('Refunded Person', false);
		await give('Ana', false); // a second gift keeps Ana's first date

		// Refund the last one-time donation, as from the Stripe dashboard.
		await deliver(h, f.refunded((JSON.parse(refundMe) as { data: { object: { payment_intent: string } } }).data.object.payment_intent));

		const res = await h.do('GET', '/v1/supporters');
		await expectStatus(res, 200);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({
			supporters: [
				{ name: 'Tomasz K.', since: '2026-10-01T14:00:00Z' },
				{ name: 'Ana', since: '2026-10-01T12:00:00Z' }
			]
		});
		expect(text).not.toMatch(/1000|amount|@/);
		// A monthly donation is a Stripe subscription, but never a Plus plan.
		expect(await h.run((store) => store.db.get<{ n: number }>('SELECT count(*) AS n FROM subscriptions')!.n)).toBe(0);
	});
});

describe('through the edge', () => {
	const call = (path: string, init: RequestInit = {}) =>
		exports.default.fetch(new Request(`https://getcolander.com${path}`, { ...init, headers: { 'CF-Connecting-IP': '198.51.100.7', ...init.headers } }));

	it('answers entitlement refresh to any origin and keeps supporters a minute at the edge', async () => {
		let res = await call('/v1/entitlement/refresh', { method: 'POST', body: '{"token":"x.y"}' });
		await expectStatus(res, 400);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		res = await call('/v1/supporters');
		await expectStatus(res, 200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
		// Cookie routes stay same-origin and uncached.
		res = await call('/v1/account');
		await expectStatus(res, 401);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});
});
