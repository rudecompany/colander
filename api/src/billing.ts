// Colander's money path on Stripe (Go's internal/billing): Plus checkout through Managed Payments,
// donations, cancellations and refunds, webhooks, and the subscription state behind paid plan
// tokens (contracts section 6.8). The SQL lives in store/billing.ts.
//
// Independence rule: scoring, tagging and review never import this module or read its tables, so
// paying or donating can never change a verdict. test/harness/independence.test.ts enforces it.
import type { PlanTokenPayload } from '@colander/shared/api';
import { concat, utf8 } from '@colander/shared/bytes';
import { readBody, rfc3339, trimSpace } from './request';
import type { Account } from './store/accounts';
import {
	billingEventSeen,
	current,
	markRefunded,
	recordBillingEvent,
	recordPayment,
	saveDonation,
	saveSubscription,
	type Subscription
} from './store/billing';
import type { Db } from './store/db';

/** Pins the Stripe API version, so object shapes never change under the server. */
export const API_VERSION = '2026-04-22.dahlia';

const DAY = 24 * 3600;
/** How long a plan token outlives the paid period, in seconds (contracts section 5). */
export const GRACE = 3 * DAY;
/** How long after a charge Cancel and refund is offered, in seconds. */
export const REFUND_WINDOW = 30 * DAY;
/** How far a webhook's signed timestamp may be from now, in seconds. */
export const SIGNATURE_TOLERANCE = 5 * 60;

/** Configuration from the environment (contracts section 10). */
export interface BillingConfig {
	/** STRIPE_SECRET_KEY; billing is off without it */
	secretKey: string;
	/** STRIPE_WEBHOOK_SECRET */
	webhookSecret: string;
	/** STRIPE_PRICE_PLUS_MONTHLY */
	priceMonthly: string;
	/** STRIPE_PRICE_PLUS_YEARLY */
	priceYearly: string;
	/** STRIPE_MANAGED_PAYMENTS: Plus checkout with Stripe as merchant of record */
	managedPayments: boolean;
	/** STRIPE_API_BASE, https://api.stripe.com by default */
	apiBase: string;
	/** website origin for the checkout return pages */
	publicUrl: string;
}

/** The parts of Env billing reads. The Stripe keys and the API base are optional. */
export type BillingEnv = Pick<Env, 'PUBLIC_URL' | 'STRIPE_PRICE_PLUS_MONTHLY' | 'STRIPE_PRICE_PLUS_YEARLY' | 'STRIPE_MANAGED_PAYMENTS'> & {
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
	STRIPE_API_BASE?: string;
};

export function billingConfig(env: BillingEnv): BillingConfig {
	const managed = env.STRIPE_MANAGED_PAYMENTS ?? '';
	return {
		secretKey: env.STRIPE_SECRET_KEY ?? '',
		webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
		priceMonthly: env.STRIPE_PRICE_PLUS_MONTHLY ?? '',
		priceYearly: env.STRIPE_PRICE_PLUS_YEARLY ?? '',
		managedPayments: managed !== '0' && managed !== 'false',
		apiBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, ''),
		publicUrl: env.PUBLIC_URL.replace(/\/+$/, '')
	};
}

/** Billing is not configured (Go's ErrUnavailable). */
export class UnavailableError extends Error {
	constructor() {
		super('billing is not configured');
	}
}
/** Go's ErrBadPrice. */
export class BadPriceError extends Error {
	constructor() {
		super('unknown price');
	}
}
/** Go's ErrAlreadySubscribed. */
export class AlreadySubscribedError extends Error {
	constructor() {
		super('the account already has Plus');
	}
}
/** Go's ErrNoPlan. */
export class NoPlanError extends Error {
	constructor() {
		super('no active plan');
	}
}
/** Go's ErrNotRefundable. */
export class NotRefundableError extends Error {
	constructor() {
		super('no charge in the last 30 days to refund');
	}
}
/** A webhook whose Stripe-Signature does not verify or is stale (Go's ErrSignature). */
export class SignatureError extends Error {
	constructor(detail?: string) {
		super('stripe webhook signature does not verify' + (detail ? `: ${detail}` : ''));
	}
}

/** A failed Stripe call: an error answer, or no usable answer at all (status 0). */
export class StripeError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		readonly code: string,
		readonly detail: string
	) {
		super(`stripe: status ${status} ${type} ${code}: ${detail}`);
	}
}

/** Whether the subscription still runs (Plus may still be on). */
export const live = (s: Subscription): boolean => ['active', 'trialing', 'past_due'].includes(s.status);

/**
 * The Stripe status as the contract's active, trialing, past_due or canceled: unpaid, paused and
 * incomplete_expired all mean Plus is off.
 */
export const planStatus = (s: Subscription): string => (live(s) ? s.status : 'canceled');

/** Whether the latest charge can still be refunded with Cancel and refund. now is unix seconds. */
export const refundable = (s: Subscription, now: number): boolean =>
	live(s) && s.latestPayment !== '' && s.refundedAt === 0 && now < s.latestPaidAt + REFUND_WINDOW;

/**
 * The end of the paid period plus grace, or 0 when Plus is off. While a renewal payment is retried
 * (past_due) the paid period is the previous one, which ended when the unpaid period began.
 */
export function tokenExpiry(s: Subscription): number {
	switch (s.status) {
		case 'active':
		case 'trialing':
			return s.periodEnd + GRACE;
		case 'past_due':
			return s.periodStart + GRACE;
	}
	return 0;
}

/** The plan object on an account (contracts section 6.8), null when the account never subscribed. */
export function toPlan(s: Subscription | undefined, now: number) {
	return s
		? {
				plan: 'plus',
				interval: s.interval,
				status: planStatus(s),
				current_period_end: rfc3339(s.periodEnd),
				cancel_at_period_end: s.cancelAtPeriodEnd,
				refundable: refundable(s, now)
			}
		: null;
}

// The Stripe objects, read with Go's zero values for anything missing (API version 2026-04-22.dahlia).
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : 0);
const meta = (v: unknown): Record<string, string> => obj(v) as Record<string, string>;

interface StripeSubscription {
	id: string;
	customer: string;
	status: string;
	cancelAtPeriodEnd: boolean;
	cancelAt: number;
	startDate: number;
	metadata: Record<string, string>;
	/** Since API version 2025-03-31.basil the billing period lives on the item. */
	items: { currentPeriodStart: number; currentPeriodEnd: number; interval: string }[];
}

function stripeSubscription(o: Obj): StripeSubscription {
	const items = obj(o.items).data;
	return {
		id: str(o.id),
		customer: str(o.customer),
		status: str(o.status),
		cancelAtPeriodEnd: o.cancel_at_period_end === true,
		cancelAt: int(o.cancel_at),
		startDate: int(o.start_date),
		metadata: meta(o.metadata),
		items: (Array.isArray(items) ? items : []).map((i: unknown) => ({
			currentPeriodStart: int(obj(i).current_period_start),
			currentPeriodEnd: int(obj(i).current_period_end),
			interval: str(obj(obj(obj(i).price).recurring).interval)
		}))
	};
}

/**
 * Verifies a Stripe-Signature header ("t=...,v1=...,v1=...") over payload with the endpoint
 * secret: HMAC-SHA256 of "t.payload"; any v1 value may match, and every one is checked in constant
 * time. now is unix seconds. Throws SignatureError.
 */
export async function verifySignature(payload: Uint8Array, header: string, secret: string, now: number): Promise<void> {
	let ts = '';
	const sigs: Uint8Array[] = [];
	for (const part of header.split(',')) {
		const p = part.trim();
		const eq = p.indexOf('=');
		const [k, v] = eq < 0 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)];
		if (k === 't') ts = v;
		else if (k === 'v1') {
			const b = unhex(v);
			if (b) sigs.push(b);
		}
	}
	const t = /^[+-]?\d+$/.test(ts) ? Number(ts) : NaN;
	if (!Number.isSafeInteger(t) || sigs.length === 0 || secret === '') throw new SignatureError();
	const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	const signed = concat(utf8(ts + '.'), payload);
	let match = false;
	for (const sig of sigs) match = (await crypto.subtle.verify('HMAC', key, sig, signed)) || match;
	if (!match) throw new SignatureError();
	const d = now - t;
	if (d > SIGNATURE_TOLERANCE || d < -SIGNATURE_TOLERANCE) throw new SignatureError(`timestamp is ${d}s away`);
}

/** Go's hex.DecodeString: undefined for odd lengths and non-hex characters. */
function unhex(s: string): Uint8Array | undefined {
	if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return undefined;
	return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/**
 * Talks to Stripe and keeps the billing tables (Go's billing.Service). Safe with an empty config:
 * every Stripe call then fails with UnavailableError, while plans, entitlements and supporters
 * answer from stored state. Times are unix seconds.
 */
export class Billing {
	/** Replaced in tests with a fake Stripe. */
	fetch: typeof fetch = (input, init) => fetch(input, init);

	constructor(
		private readonly db: Db,
		readonly config: BillingConfig
	) {}

	/** Whether Stripe is configured. */
	enabled(): boolean {
		return this.config.secretKey !== '';
	}

	/**
	 * The claims of a paid plan token for the account, or NoPlanError. sub is the account ID, so
	 * settings sync keeps one blob per account across renewals and browsers.
	 */
	planClaims(accountId: string, now: number): PlanTokenPayload {
		const sub = current(this.db, accountId);
		if (!sub || tokenExpiry(sub) <= now) throw new NoPlanError();
		return { v: 1, sub: accountId, plan: 'plus', trial: sub.status === 'trialing', iat: now, exp: tokenExpiry(sub) };
	}

	/** Starts a hosted Stripe Checkout for Plus and returns its URL. */
	async checkout(acct: Account, price: string): Promise<string> {
		const priceId = price === 'plus_yearly' ? this.config.priceYearly : price === 'plus_monthly' ? this.config.priceMonthly : undefined;
		if (priceId === undefined) throw new BadPriceError();
		if (!this.enabled() || priceId === '') throw new UnavailableError();
		const cur = current(this.db, acct.id);
		if (cur && live(cur)) throw new AlreadySubscribedError();
		const { publicUrl } = this.config;
		const form = new URLSearchParams({
			mode: 'subscription',
			'line_items[0][price]': priceId,
			'line_items[0][quantity]': '1',
			client_reference_id: acct.id,
			'metadata[kind]': 'plus',
			'metadata[account_id]': acct.id,
			'subscription_data[metadata][kind]': 'plus',
			'subscription_data[metadata][account_id]': acct.id,
			success_url: publicUrl + '/plans/welcome',
			cancel_url: publicUrl + '/plans?checkout=' + price + '&cancelled=1'
		});
		// Managed Payments makes Stripe the merchant of record. It rejects tax, shipping and payment
		// method parameters, so none are ever sent.
		if (this.config.managedPayments) form.set('managed_payments[enabled]', 'true');
		if (cur && cur.customerId !== '') form.set('customer', cur.customerId);
		else form.set('customer_email', acct.email);
		return str((await this.call('POST', '/v1/checkout/sessions', form)).url);
	}

	/**
	 * Starts a hosted Stripe Checkout for a donation of cents, once or monthly, and returns its URL.
	 * Donations are gifts rather than product sales, so they never use Managed Payments.
	 */
	async donate(cents: number, monthly: boolean, creditName: string): Promise<string> {
		if (!this.enabled()) throw new UnavailableError();
		const form = new URLSearchParams({
			'line_items[0][price_data][currency]': 'usd',
			'line_items[0][price_data][unit_amount]': String(cents),
			'line_items[0][quantity]': '1',
			'metadata[kind]': 'donation',
			success_url: this.config.publicUrl + '/support/thanks',
			cancel_url: this.config.publicUrl + '/support?cancelled=1'
		});
		if (monthly) {
			form.set('mode', 'subscription');
			form.set('line_items[0][price_data][product_data][name]', 'Monthly donation to Colander');
			form.set('line_items[0][price_data][recurring][interval]', 'month');
			form.set('subscription_data[metadata][kind]', 'donation');
		} else {
			form.set('mode', 'payment');
			form.set('submit_type', 'donate');
			form.set('line_items[0][price_data][product_data][name]', 'Donation to Colander');
		}
		if (creditName !== '') form.set('metadata[credit_name]', creditName);
		return str((await this.call('POST', '/v1/checkout/sessions', form)).url);
	}

	/**
	 * Ends the account's Plus at the end of the paid period. With refund it refunds the latest
	 * charge, when it is under 30 days old, and ends Plus now. Returns the subscription as it stands
	 * afterwards.
	 */
	async cancel(accountId: string, refund: boolean, now: number): Promise<Subscription> {
		if (!this.enabled()) throw new UnavailableError();
		const sub = current(this.db, accountId);
		if (!sub || !live(sub)) throw new NoPlanError();
		const path = '/v1/subscriptions/' + encodeURIComponent(sub.id);
		let out: Obj;
		if (refund) {
			// A refund recorded for the latest charge means an earlier try refunded it but did not
			// finish cancelling: cancel without refunding twice.
			const alreadyRefunded = sub.refundedAt !== 0 && now < sub.latestPaidAt + REFUND_WINDOW;
			if (!refundable(sub, now) && !alreadyRefunded) throw new NotRefundableError();
			if (!alreadyRefunded) {
				// Refund first: if cancelling then fails, the person is never left charged without Plus.
				const form = new URLSearchParams({ reason: 'requested_by_customer', 'metadata[account_id]': accountId });
				form.set(sub.latestPayment.startsWith('ch_') ? 'charge' : 'payment_intent', sub.latestPayment);
				await this.call('POST', '/v1/refunds', form, 'colander-refund-' + sub.latestPayment);
				markRefunded(this.db, sub.latestPayment, '', now);
			}
			out = await this.call('DELETE', path);
		} else if (sub.cancelAtPeriodEnd) {
			return sub;
		} else {
			out = await this.call('POST', path, new URLSearchParams({ cancel_at_period_end: 'true' }));
		}
		this.saveSubscription(stripeSubscription(out), now);
		return current(this.db, accountId)!;
	}

	/**
	 * Verifies and applies one Stripe event; an event handled before is ignored. Throws
	 * SignatureError for a bad signature; any other error means Stripe should retry. The objects
	 * are read from Stripe first, then every write and the event id commit in one transaction.
	 */
	async handleWebhook(payload: Uint8Array, signature: string, now: number): Promise<void> {
		await verifySignature(payload, signature, this.config.webhookSecret, now);
		let ev: Obj;
		try {
			ev = obj(JSON.parse(new TextDecoder().decode(payload)));
		} catch {
			throw new SignatureError('payload is not a Stripe event');
		}
		const id = str(ev.id);
		const type = str(ev.type);
		if (id === '') throw new SignatureError('payload is not a Stripe event');
		if (billingEventSeen(this.db, id)) return;
		let write: () => void;
		try {
			write = await this.apply(type, int(ev.created), obj(obj(ev.data).object), now);
		} catch (err) {
			throw new Error(`${type} ${id}: ${String(err)}`, { cause: err });
		}
		this.db.tx(() => {
			// A delivery racing this one past the check above applied the same idempotent writes.
			if (billingEventSeen(this.db, id)) return;
			write();
			recordBillingEvent(this.db, id, type, now);
		});
	}

	/** Reads what an event needs from Stripe and returns the writes that apply it. */
	private async apply(type: string, created: number, o: Obj, now: number): Promise<() => void> {
		const none = () => {};
		switch (type) {
			case 'checkout.session.completed':
			case 'checkout.session.async_payment_succeeded': {
				const m = meta(o.metadata);
				const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
				if (m.kind === 'donation' && paid) {
					return () =>
						saveDonation(this.db, {
							id: str(o.id),
							amountCents: int(o.amount_total),
							currency: str(o.currency),
							recurring: o.mode === 'subscription',
							creditName: trimSpace(str(m.credit_name)),
							payment: str(o.payment_intent),
							subscriptionId: str(o.subscription),
							createdAt: created
						});
				}
				if (m.kind === 'plus' && str(o.subscription) !== '') {
					const sub = await this.fetchSubscription(str(o.subscription));
					return () => this.saveSubscription(sub, now);
				}
				return none;
			}
			case 'customer.subscription.created':
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted': {
				if (meta(o.metadata).kind !== 'plus') return none;
				// Reading it fresh, rather than trusting the event's copy, makes events that arrive out
				// of order harmless.
				const sub = await this.fetchSubscription(str(o.id));
				return () => this.saveSubscription(sub, now);
			}
			case 'invoice.paid':
			case 'invoice.payment_failed': {
				// Since API version 2025-03-31.basil the subscription is under parent.subscription_details.
				const details = obj(obj(o.parent).subscription_details);
				const subId = str(details.subscription);
				if (subId === '' || meta(details.metadata).kind === 'donation') return none;
				const sub = await this.fetchSubscription(subId);
				const payment = type === 'invoice.paid' && int(o.amount_paid) > 0 ? await this.fetchPayment(str(o.id)) : undefined;
				return () => {
					this.saveSubscription(sub, now);
					if (payment) recordPayment(this.db, subId, payment.ref, payment.paidAt);
				};
			}
			case 'charge.refunded':
				if (int(o.amount_refunded) <= 0) return none;
				return () => markRefunded(this.db, str(o.id), str(o.payment_intent), now);
		}
		return none;
	}

	private async fetchSubscription(id: string): Promise<StripeSubscription> {
		return stripeSubscription(await this.call('GET', '/v1/subscriptions/' + encodeURIComponent(id)));
	}

	/**
	 * The PaymentIntent (or Charge) that paid an invoice, so it can be refunded. invoice_payments
	 * replaced invoice.charge and invoice.payment_intent in 2025-03-31.basil.
	 */
	private async fetchPayment(invoiceId: string): Promise<{ ref: string; paidAt: number } | undefined> {
		const list = await this.call('GET', '/v1/invoice_payments', new URLSearchParams({ invoice: invoiceId, status: 'paid' }));
		let best = { type: '', paymentIntent: '', charge: '', paidAt: 0 };
		for (const p of Array.isArray(list.data) ? list.data : []) {
			const paidAt = int(obj(obj(p).status_transitions).paid_at);
			if (obj(p).status === 'paid' && paidAt >= best.paidAt) {
				const pay = obj(obj(p).payment);
				best = { type: str(pay.type), paymentIntent: str(pay.payment_intent), charge: str(pay.charge), paidAt };
			}
		}
		const ref = best.type === 'charge' ? best.charge : best.paymentIntent;
		return ref === '' ? undefined : { ref, paidAt: best.paidAt };
	}

	/**
	 * Mirrors a Stripe subscription. Only Plus subscriptions are kept: monthly donations are
	 * subscriptions too and are recorded as donations instead.
	 */
	private saveSubscription(sub: StripeSubscription, now: number): void {
		const account = sub.metadata.account_id ?? '';
		const item = sub.items[0];
		if (sub.metadata.kind !== 'plus' || account === '' || !item) return;
		const stored = saveSubscription(
			this.db,
			{
				id: sub.id,
				accountId: account,
				customerId: sub.customer,
				status: sub.status,
				interval: item.interval,
				periodStart: item.currentPeriodStart,
				periodEnd: item.currentPeriodEnd,
				// Newer API versions can express cancel at period end as a cancel_at date.
				ending: sub.cancelAtPeriodEnd || sub.cancelAt !== 0,
				startDate: sub.startDate
			},
			now
		);
		if (!stored) console.warn(JSON.stringify({ message: 'stripe subscription for an unknown account ignored', subscription: sub.id }));
	}

	/**
	 * Sends one form-encoded request to Stripe and returns the JSON answer.
	 * ponytail: plain fetch instead of the stripe SDK; a handful of endpoints do not need it.
	 */
	private async call(method: string, path: string, form?: URLSearchParams, idempotencyKey = ''): Promise<Obj> {
		let url = this.config.apiBase + path;
		const headers: Record<string, string> = { Authorization: 'Bearer ' + this.config.secretKey, 'Stripe-Version': API_VERSION };
		let body: string | undefined;
		if (form && form.size > 0) {
			if (method === 'GET') url += '?' + form.toString();
			else {
				body = form.toString();
				headers['Content-Type'] = 'application/x-www-form-urlencoded';
			}
		}
		if (idempotencyKey !== '') headers['Idempotency-Key'] = idempotencyKey;
		let res: Response;
		try {
			res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(20_000) });
		} catch (err) {
			throw new StripeError(0, 'network', '', `${method} ${path}: ${String(err)}`);
		}
		let raw: Uint8Array;
		let over: boolean;
		try {
			({ bytes: raw, over } = await readBody(res.body, 4 << 20));
		} catch (err) {
			throw new StripeError(res.status, 'network', '', String(err));
		}
		let parsed: unknown;
		try {
			if (over) throw new Error('response larger than 4 MiB');
			parsed = JSON.parse(new TextDecoder().decode(raw));
		} catch (err) {
			if (res.status < 300) throw new StripeError(res.status, 'decode', '', String(err));
		}
		if (res.status >= 300) {
			const e = obj(obj(parsed).error);
			throw new StripeError(res.status, str(e.type), str(e.code), str(e.message));
		}
		return obj(parsed);
	}
}
