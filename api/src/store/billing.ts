// The billing tables (0002_billing.sql). In Go this SQL sat inside internal/billing next to the
// Stripe calls; here it is the data layer and the billing port keeps the Stripe side. Scoring,
// tagging and review never import this file: paying never changes a verdict.
import { bit, type Db } from './db';

/** A Plus subscription as stored (Go's billing.Subscription). */
export interface Subscription {
	id: string;
	accountId: string;
	customerId: string;
	/** Stripe status */
	status: string;
	/** month | year */
	interval: string;
	periodStart: number;
	periodEnd: number;
	cancelAtPeriodEnd: boolean;
	/** PaymentIntent or Charge of the latest paid invoice */
	latestPayment: string;
	latestPaidAt: number;
	refundedAt: number;
	createdAt: number;
}

/**
 * Returns the account's subscription that decides its plan: a live one first, then the one that
 * ended last. Undefined when the account never subscribed (Go's Service.Current).
 */
export function current(db: Db, accountId: string): Subscription | undefined {
	const r = db.get<{
		id: string;
		account_id: string;
		customer_id: string;
		status: string;
		interval: string;
		period_start: number;
		period_end: number;
		cancel_at_period_end: number;
		latest_payment: string;
		latest_paid_at: number;
		refunded_at: number;
		created_at: number;
	}>(
		`SELECT id, account_id, customer_id, status, interval, period_start, period_end, cancel_at_period_end,
		ifnull(latest_payment, '') AS latest_payment, ifnull(latest_paid_at, 0) AS latest_paid_at,
		ifnull(refunded_at, 0) AS refunded_at, created_at FROM subscriptions
		WHERE account_id = ? AND status NOT IN ('incomplete', 'incomplete_expired')
		ORDER BY status IN ('active', 'trialing', 'past_due') DESC, period_end DESC LIMIT 1`,
		accountId
	);
	return (
		r && {
			id: r.id,
			accountId: r.account_id,
			customerId: r.customer_id,
			status: r.status,
			interval: r.interval,
			periodStart: r.period_start,
			periodEnd: r.period_end,
			cancelAtPeriodEnd: r.cancel_at_period_end !== 0,
			latestPayment: r.latest_payment,
			latestPaidAt: r.latest_paid_at,
			refundedAt: r.refunded_at,
			createdAt: r.created_at
		}
	);
}

/** One credited name on the supporters page. Amounts and emails are never shown. */
export interface Supporter {
	name: string;
	since: number;
}

/** Lists credited donors, newest first. A name used for several donations appears once, since the first. */
export function supporters(db: Db): Supporter[] {
	return db
		.all<{ credit_name: string; since: number }>(
			`SELECT credit_name, min(created_at) AS since FROM donations
			WHERE credit_name IS NOT NULL AND refunded_at IS NULL GROUP BY credit_name ORDER BY since DESC LIMIT 1000`
		)
		.map((r) => ({ name: r.credit_name, since: r.since }));
}

/** The fields of a Stripe subscription that Go's saveSubscription stores. */
export interface SubscriptionInput {
	id: string;
	accountId: string;
	customerId: string;
	status: string;
	interval: string;
	periodStart: number;
	periodEnd: number;
	/** cancel_at_period_end, or a cancel_at date on newer API versions */
	ending: boolean;
	startDate: number;
}

/**
 * Mirrors a Plus subscription from Stripe. Returns false when the account is unknown and nothing
 * was stored (Go logs a warning then).
 */
export function saveSubscription(db: Db, s: SubscriptionInput, now: number): boolean {
	return (
		db.run(
			`INSERT INTO subscriptions (id, account_id, customer_id, status, interval,
				period_start, period_end, cancel_at_period_end, created_at, updated_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)
			ON CONFLICT (id) DO UPDATE SET status = excluded.status, interval = excluded.interval,
				period_start = excluded.period_start, period_end = excluded.period_end,
				cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
			s.id,
			s.accountId,
			s.customerId,
			s.status,
			s.interval,
			s.periodStart,
			s.periodEnd,
			bit(s.ending),
			s.startDate,
			now,
			s.accountId
		) > 0
	);
}

/** Stores the latest paid charge of a subscription, for refunds. */
export function recordPayment(db: Db, subId: string, payment: string, paidAt: number): void {
	db.run(
		`UPDATE subscriptions SET latest_payment = ?, latest_paid_at = ?, refunded_at = NULL
		WHERE id = ? AND ifnull(latest_paid_at, 0) <= ?`,
		payment,
		paidAt,
		subId,
		paidAt
	);
}

/** Records a refund of the charge or PaymentIntent with these IDs ("" matches nothing). */
export function markRefunded(db: Db, id1: string, id2: string, now: number): void {
	db.tx(() => {
		for (const table of ['subscriptions SET refunded_at = ? WHERE latest_payment', 'donations SET refunded_at = ? WHERE payment']) {
			db.run(`UPDATE ${table} IN (?, ?) AND refunded_at IS NULL`, now, id1, id2);
		}
	});
}

/** A completed donation Checkout Session (Go's saveDonation input). */
export interface DonationInput {
	/** Checkout Session id */
	id: string;
	amountCents: number;
	currency: string;
	recurring: boolean;
	/** trimmed; "" for no credit */
	creditName: string;
	/** PaymentIntent of a one-time donation, "" otherwise */
	payment: string;
	/** Stripe subscription of a monthly donation, "" otherwise */
	subscriptionId: string;
	createdAt: number;
}

/** Stores one donation; a repeated session changes nothing. */
export function saveDonation(db: Db, d: DonationInput): void {
	db.run(
		`INSERT INTO donations (id, amount_cents, currency, recurring, credit_name, payment,
		subscription_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
		d.id,
		d.amountCents,
		d.currency,
		bit(d.recurring),
		d.creditName || null,
		d.payment || null,
		d.subscriptionId || null,
		d.createdAt
	);
}

/** Whether a Stripe event was handled before (Go's HandleWebhook dedup read). */
export function billingEventSeen(db: Db, id: string): boolean {
	return db.get<{ n: number }>('SELECT count(*) AS n FROM billing_events WHERE id = ?', id)!.n > 0;
}

/** Records a handled Stripe event. */
export function recordBillingEvent(db: Db, id: string, type: string, now: number): void {
	db.run('INSERT INTO billing_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', id, type, now);
}
