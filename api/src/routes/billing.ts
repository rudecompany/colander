// Billing and entitlements (contracts 6.8, Go's internal/api/billing.go): checkout, donations,
// cancel and refund, the Stripe webhook, plan tokens and the supporters page.
import { importKeys, issuePlanToken, verifyPlanToken } from '@colander/shared/signing';
import { session, signedIn } from '../auth';
import {
	AlreadySubscribedError,
	BadPriceError,
	NoPlanError,
	NotRefundableError,
	SignatureError,
	StripeError,
	UnavailableError
} from '../billing';
import { IP_HASH_HEADER, json, jsonError, setCache, tooMany } from '../http';
import { allow } from '../limits';
import { plusCancelled, plusRefunded } from '../mail';
import { decode, readBody, rfc3339, trimSpace } from './respond';
import { supporters } from '../store/billing';
import type { Store } from '../store/store';
import { unix } from '../scoring/engine';
import { writeAccount, type RouteSpec } from './account';

export function billingRoutes(s: Store): RouteSpec[] {
	return [
		['POST', '/v1/billing/checkout', (r) => billingCheckout(s, r)],
		['POST', '/v1/billing/donate', (r) => billingDonate(s, r)],
		['POST', '/v1/billing/cancel', (r) => billingCancel(s, r)],
		['POST', '/v1/billing/webhook', (r) => billingWebhook(s, r)],
		['POST', '/v1/entitlement', (r) => postEntitlement(s, r)],
		['POST', '/v1/entitlement/refresh', (r) => refreshEntitlement(s, r)],
		['GET', '/v1/supporters', () => getSupporters(s)]
	];
}

const billingUnavailable = () => jsonError(503, 'billing_unavailable', 'Payments are switched off right now, so nothing was charged.');

/** Answers a failed Stripe call; anything else is the Store's 500. */
function billingFailed(route: string, err: unknown): Response {
	if (!(err instanceof StripeError)) throw err;
	console.error(JSON.stringify({ message: 'stripe call failed', route, error: err.message }));
	return jsonError(
		502,
		'payment_provider_error',
		'Our payment provider did not answer as expected, so nothing was changed. Please try again in a moment.'
	);
}

async function billingCheckout(s: Store, request: Request): Promise<Response> {
	const a = session(s.auth, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 1 << 10, { price: 'string' });
	if (body instanceof Response) return body;
	try {
		return json(200, { url: await s.billing.checkout(a, body.price) });
	} catch (err) {
		if (err instanceof BadPriceError) return jsonError(400, 'invalid_price', 'price must be plus_yearly or plus_monthly.');
		if (err instanceof UnavailableError) return billingUnavailable();
		if (err instanceof AlreadySubscribedError) {
			return jsonError(409, 'already_subscribed', 'This account already has Plus. You can manage it on your account page.');
		}
		return billingFailed('POST /v1/billing/checkout', err);
	}
}

async function billingDonate(s: Store, request: Request): Promise<Response> {
	const body = await decode(request, 2 << 10, { amount_cents: 'int', recurring: 'bool', credit_name: 'string' });
	if (body instanceof Response) return body;
	if (!s.billing.enabled()) return billingUnavailable();
	const name = trimSpace(body.credit_name);
	if (body.amount_cents < 100 || body.amount_cents > 100000) {
		return jsonError(400, 'invalid_amount', 'Choose an amount from $1 to $1,000.');
	}
	if ([...name].length > 80 || /\p{Cc}/u.test(name)) {
		return jsonError(400, 'invalid_credit_name', 'The name for the supporters page must be one line of at most 80 characters.');
	}
	const wait = allow(s.db, s.now(), request.headers.get(IP_HASH_HEADER) ?? '', 1, 'donate');
	if (wait > 0) return tooMany(wait / 1000);
	try {
		return json(200, { url: await s.billing.donate(body.amount_cents, body.recurring, name) });
	} catch (err) {
		return billingFailed('POST /v1/billing/donate', err);
	}
}

async function billingCancel(s: Store, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const a = ses.account;
	const body = await decode(request, 1 << 10, { refund: 'bool' });
	if (body instanceof Response) return body;
	let periodEnd: number;
	try {
		periodEnd = (await s.billing.cancel(a.id, body.refund, unix(s.now()))).periodEnd;
	} catch (err) {
		if (err instanceof UnavailableError) return billingUnavailable();
		if (err instanceof NoPlanError) return jsonError(404, 'no_plan', 'There is no running Plus plan on this account to cancel.');
		if (err instanceof NotRefundableError) {
			return jsonError(
				409,
				'not_refundable',
				'Your last charge is more than 30 days old, so it cannot be refunded. You can still cancel, and Plus stays on until the end of the period.'
			);
		}
		return billingFailed('POST /v1/billing/cancel', err);
	}
	const [subject, text] = body.refund ? plusRefunded() : plusCancelled(periodEnd);
	try {
		await s.mailer.send(a.email, subject, text);
	} catch (err) {
		console.error(JSON.stringify({ message: 'billing email not sent', error: String(err) }));
	}
	return writeAccount(s, a, ses);
}

async function billingWebhook(s: Store, request: Request): Promise<Response> {
	if (!s.billing.enabled() || s.billing.config.webhookSecret === '') return billingUnavailable();
	const { bytes, over } = await readBody(request.body, 1 << 20);
	if (over) return jsonError(413, 'too_large', 'The webhook body is too large.');
	try {
		await s.billing.handleWebhook(bytes, request.headers.get('Stripe-Signature') ?? '', unix(s.now()));
	} catch (err) {
		if (err instanceof SignatureError) {
			console.warn(JSON.stringify({ message: 'stripe webhook rejected', error: err.message }));
			return jsonError(400, 'invalid_signature', 'The Stripe-Signature header does not verify.');
		}
		// A 500 makes Stripe retry later.
		console.error(JSON.stringify({ message: 'stripe webhook failed', error: String(err) }));
		return jsonError(500, 'internal', 'The event could not be applied. Stripe will retry it.');
	}
	return json(200, { received: true });
}

async function postEntitlement(s: Store, request: Request): Promise<Response> {
	const a = session(s.auth, request);
	return a instanceof Response ? a : issueToken(s, a.id);
}

/**
 * Re-issues a paid plan token while the subscription behind it runs. The token may have expired;
 * its signature proves which account it was issued to. Trial tokens never become paid ones.
 */
async function refreshEntitlement(s: Store, request: Request): Promise<Response> {
	const body = await decode(request, 4 << 10, { token: 'string' });
	if (body instanceof Response) return body;
	const key = await s.signingKey();
	const c = await verifyPlanToken(body.token, await importKeys([key.publicBase64]));
	if (!c || typeof c.sub !== 'string' || c.sub === '') return jsonError(400, 'invalid_plan', 'The plan token is not valid.');
	if (c.trial) return jsonError(404, 'no_plan', 'A trial token cannot be refreshed. Get Plus to keep its features.');
	return issueToken(s, c.sub);
}

async function issueToken(s: Store, accountId: string): Promise<Response> {
	let claims;
	try {
		claims = s.billing.planClaims(accountId, unix(s.now()));
	} catch (err) {
		if (err instanceof NoPlanError) return jsonError(404, 'no_plan', 'There is no active Plus plan on this account.');
		throw err;
	}
	return json(200, { token: await issuePlanToken(await s.signingKey(), claims) });
}

/** The same for every viewer and never reads the session, so the edge keeps it a minute (hosting plan section 2). */
function getSupporters(s: Store): Response {
	const list = supporters(s.db).map((sp) => ({ name: sp.name, since: rfc3339(sp.since) }));
	return json(200, { supporters: list }, setCache(new Headers(), 'public'));
}
