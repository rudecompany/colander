// A small in-memory fake of the Stripe endpoints Colander uses (Go's billing/billingtest). Tests
// hand its fetch to the Billing service, inspect the requests it recorded and pay checkout sessions
// to get the webhook events Stripe would send. It never talks to Stripe.
import { hex, utf8 } from '@colander/shared/bytes';

/** One API call the fake received. */
export interface StripeRequest {
	method: string;
	path: string;
	/** body for POST, query for GET */
	form: URLSearchParams;
	headers: Headers;
}

/** A recurring price in the fake's catalog. */
export interface Price {
	amount: number;
	/** month | year */
	interval: string;
}

type Obj = Record<string, any>;

export const ORIGIN = 'https://stripe.fake';

export class StripeFake {
	prices: Record<string, Price> = {};
	/** The clock in unix seconds. */
	now: () => number = () => Math.floor(Date.now() / 1000);
	private n = 0;
	private requests: StripeRequest[] = [];
	private sessions = new Map<string, Obj>();
	private subs = new Map<string, Obj>();
	/** invoice id to invoice payments */
	private payments = new Map<string, Obj[]>();
	/** refunded PaymentIntents */
	private refunds = new Set<string>();
	/** deleted customers */
	readonly deletedCustomers = new Set<string>();

	/** The fetch the Billing service calls. */
	readonly fetch: typeof fetch = async (input, init) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		const form = req.method === 'GET' ? url.searchParams : new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
		this.requests.push({ method: req.method, path: url.pathname, form, headers: req.headers });
		return this.serve(req.method, url.pathname, form, req.headers);
	};

	/** The recorded API calls with this method and path ("" matches any). */
	recorded(method = '', path = ''): StripeRequest[] {
		return this.requests.filter((r) => (method === '' || r.method === method) && (path === '' || r.path === path));
	}

	private id(prefix: string): string {
		return `${prefix}_fake${String(++this.n).padStart(4, '0')}`;
	}

	private serve(method: string, p: string, form: URLSearchParams, headers: Headers): Response {
		if (!(headers.get('Authorization') ?? '').startsWith('Bearer sk_')) {
			return Response.json({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, { status: 401 });
		}
		if (method === 'POST' && p === '/v1/checkout/sessions') {
			const id = this.id('cs_test');
			const s: Obj = {
				id,
				object: 'checkout.session',
				url: `${ORIGIN}/pay/${id}`,
				mode: form.get('mode') ?? '',
				client_reference_id: form.get('client_reference_id') ?? '',
				customer: form.get('customer') ?? '',
				customer_email: form.get('customer_email') ?? '',
				success_url: form.get('success_url') ?? '',
				cancel_url: form.get('cancel_url') ?? '',
				metadata: nested(form, 'metadata'),
				payment_status: 'unpaid',
				status: 'open',
				created: this.now()
			};
			this.sessions.set(id, { ...s, form });
			return Response.json(s);
		}
		if (p.startsWith('/v1/subscriptions/')) {
			const sub = this.subs.get(p.slice('/v1/subscriptions/'.length));
			if (!sub) return notFound('subscription');
			if (method === 'POST' && form.get('cancel_at_period_end') === 'true') sub.cancel_at_period_end = true;
			if (method === 'DELETE') {
				sub.status = 'canceled';
				sub.ended_at = this.now();
			}
			return Response.json(sub);
		}
		if (method === 'GET' && p.startsWith('/v1/checkout/sessions/')) {
			const s = this.sessions.get(p.slice('/v1/checkout/sessions/'.length));
			if (!s) return notFound('checkout session');
			const { form: _, ...clean } = s;
			return Response.json(clean);
		}
		if (method === 'DELETE' && p.startsWith('/v1/customers/')) {
			const id = p.slice('/v1/customers/'.length);
			if (this.deletedCustomers.has(id)) return notFound('customer');
			this.deletedCustomers.add(id);
			return Response.json({ id, object: 'customer', deleted: true });
		}
		if (method === 'GET' && p === '/v1/invoice_payments') {
			return Response.json({ object: 'list', data: this.payments.get(form.get('invoice') ?? '') ?? null, has_more: false });
		}
		if (method === 'POST' && p === '/v1/refunds') {
			const pi = form.get('payment_intent') ?? '';
			if (this.refunds.has(pi)) {
				return Response.json({ error: { type: 'invalid_request_error', code: 'charge_already_refunded' } }, { status: 400 });
			}
			this.refunds.add(pi);
			return Response.json({ id: this.id('re'), object: 'refund', payment_intent: pi, status: 'succeeded' });
		}
		return notFound(`route ${method} ${p}`);
	}

	/**
	 * Completes a checkout session as if the customer paid, and returns the webhook payloads Stripe
	 * would send, in the order it usually sends them.
	 */
	pay(sessionId: string): string[] {
		const s = this.sessions.get(sessionId);
		if (!s) throw new Error(`stripe fake: unknown checkout session ${sessionId}`);
		const form = s.form as URLSearchParams;
		const now = this.now();
		if (s.customer === '') s.customer = this.id('cus');
		s.status = 'complete';
		s.payment_status = 'paid';
		const { amount, interval } = this.priceOf(form);
		s.amount_total = amount;
		s.currency = 'usd';
		if (s.mode === 'payment') {
			s.payment_intent = this.id('pi');
			return [this.event('checkout.session.completed', s)];
		}
		const sub: Obj = {
			id: this.id('sub'),
			object: 'subscription',
			customer: s.customer,
			status: 'active',
			cancel_at_period_end: false,
			cancel_at: null,
			start_date: now,
			metadata: nested(form, 'subscription_data[metadata]'),
			items: {
				object: 'list',
				data: [
					{
						current_period_start: now,
						current_period_end: addInterval(now, interval),
						price: { id: form.get('line_items[0][price]') ?? '', unit_amount: amount, recurring: { interval } }
					}
				]
			}
		};
		this.subs.set(sub.id, sub);
		s.subscription = sub.id;
		return [this.event('customer.subscription.created', sub), this.event('checkout.session.completed', s), this.invoice(sub, amount, true)];
	}

	/**
	 * Starts the subscription's next period. When paid is false the renewal payment fails and the
	 * subscription becomes past_due; renewing a past_due subscription retries the same period.
	 */
	renew(subId: string, paid: boolean): string[] {
		const sub = this.subs.get(subId)!;
		const item = sub.items.data[0];
		if (sub.status !== 'past_due') {
			const start = item.current_period_end;
			item.current_period_start = start;
			item.current_period_end = addInterval(start, item.price.recurring.interval);
		}
		sub.status = paid ? 'active' : 'past_due';
		return [this.invoice(sub, item.price.unit_amount, paid), this.event('customer.subscription.updated', sub)];
	}

	/** Ends a subscription now, as when the customer cancels through Link, and returns the event. */
	cancel(subId: string): string {
		const sub = this.subs.get(subId)!;
		sub.status = 'canceled';
		return this.event('customer.subscription.deleted', sub);
	}

	/** The charge.refunded event for a PaymentIntent refunded outside Colander. */
	refunded(paymentIntent: string): string {
		this.refunds.add(paymentIntent);
		return this.event('charge.refunded', { id: this.id('ch'), object: 'charge', payment_intent: paymentIntent, amount_refunded: 300 });
	}

	private invoice(sub: Obj, amount: number, paid: boolean): string {
		const id = this.id('in');
		const pi = this.id('pi');
		const inv: Obj = {
			id,
			object: 'invoice',
			customer: sub.customer,
			amount_paid: 0,
			status: 'open',
			parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } }
		};
		if (!paid) return this.event('invoice.payment_failed', inv);
		inv.amount_paid = amount;
		inv.status = 'paid';
		this.payments.set(id, [
			{
				id: this.id('inpay'),
				object: 'invoice_payment',
				invoice: id,
				status: 'paid',
				amount_paid: amount,
				payment: { type: 'payment_intent', payment_intent: pi },
				status_transitions: { paid_at: this.now() }
			}
		]);
		return this.event('invoice.paid', inv);
	}

	private priceOf(form: URLSearchParams): Price {
		const p = this.prices[form.get('line_items[0][price]') ?? ''];
		if (p) return p;
		return {
			amount: Number(form.get('line_items[0][price_data][unit_amount]') ?? 0),
			interval: form.get('line_items[0][price_data][recurring][interval]') ?? ''
		};
	}

	private event(type: string, obj: Obj): string {
		const { form: _, ...clean } = obj;
		return JSON.stringify({
			id: this.id('evt'),
			object: 'event',
			type,
			created: this.now(),
			api_version: '2026-04-22.dahlia',
			data: { object: structuredClone(clean) }
		});
	}
}

function notFound(what: string): Response {
	return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}` } }, { status: 404 });
}

/** Collects form keys like metadata[kind] into an object. */
function nested(form: URLSearchParams, prefix: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of form) {
		const inner = k.startsWith(prefix + '[') && k.endsWith(']') ? k.slice(prefix.length + 1, -1) : '';
		if (inner !== '' && !inner.includes('[')) out[inner] ??= v;
	}
	return out;
}

/** Go's AddDate(1, 0, 0) or AddDate(0, 1, 0) in UTC. */
function addInterval(t: number, interval: string): number {
	const d = new Date(t * 1000);
	if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
	else d.setUTCMonth(d.getUTCMonth() + 1);
	return d.getTime() / 1000;
}

/** A Stripe-Signature header for payload, signed at t (unix seconds) with secret. */
export async function sign(payload: string, secret: string, t: number): Promise<string> {
	const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, utf8(`${t}.${payload}`));
	return `t=${t},v1=${hex(new Uint8Array(mac))}`;
}
