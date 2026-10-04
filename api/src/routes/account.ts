// Accounts and sessions (contracts 6.6, Go's internal/api/account.go): email sign-in, verify,
// logout, the account, its display name and reviewer tokens.
import { csrfOk, hashToken, normalizeEmail, safeNext, session } from '../auth';
import { toPlan } from '../billing';
import { IP_HASH_HEADER, json, jsonError, tooMany } from '../http';
import { allow } from '../limits';
import { signIn } from '../mail';
import { decode, queryEscape, rfc3339, trimSpace } from './respond';
import { unix } from '../scoring/engine';
import { setDisplayName, type Account } from '../store/accounts';
import { current } from '../store/billing';
import type { Store } from '../store/store';

/** A route the Store registers: method, URLPattern pathname and handler. */
export type RouteSpec = [method: string, pattern: string, handler: (request: Request) => Response | Promise<Response>];

export function accountRoutes(s: Store, env: Pick<Env, 'PUBLIC_URL'>): RouteSpec[] {
	const publicUrl = env.PUBLIC_URL.replace(/\/+$/, '');
	return [
		['POST', '/v1/auth/email', (r) => authEmail(s, publicUrl, r)],
		['POST', '/v1/auth/verify', (r) => authVerify(s, r)],
		['POST', '/v1/auth/logout', (r) => authLogout(s, r)],
		['GET', '/v1/account', (r) => getAccount(s, r)],
		['PATCH', '/v1/account', (r) => patchAccount(s, r)],
		['POST', '/v1/account/reviewer-token', (r) => reviewerToken(s, r)]
	];
}

/** 200 with the account and its plan (null when it never subscribed). */
export function writeAccount(s: Store, a: Account, headers: HeadersInit = {}): Response {
	const account = {
		id: a.id,
		email: a.email,
		display_name: a.displayName === '' ? null : a.displayName,
		role: a.role,
		plan: toPlan(current(s.db, a.id), unix(s.now())),
		created_at: rfc3339(a.createdAt)
	};
	return json(200, { account }, headers);
}

async function authEmail(s: Store, publicUrl: string, request: Request): Promise<Response> {
	const body = await decode(request, 4 << 10, { email: 'string', next: 'string' });
	if (body instanceof Response) return body;
	const email = normalizeEmail(body.email);
	if (!email) return jsonError(400, 'invalid_email', 'Enter a valid email address.');
	const now = s.now();
	const next = safeNext(body.next);
	const ip = request.headers.get(IP_HASH_HEADER) ?? '';
	// Both quotas and the link commit together (hosting plan flow 8).
	const started = s.db.tx(() => {
		const wait = allow(s.db, now, ip, 1, 'auth_email_ip') || allow(s.db, now, hashToken(email), 1, 'auth_email');
		return wait > 0 ? wait : s.auth.startSignIn(email, next);
	});
	if (typeof started === 'number') return tooMany(started / 1000);
	const link = `${publicUrl}/auth/callback?token=${queryEscape(started)}&next=${queryEscape(next)}`;
	const [subject, text] = signIn(link);
	try {
		await s.mailer.send(email, subject, text);
	} catch (err) {
		console.error(JSON.stringify({ message: 'sign-in email not sent', error: String(err) }));
	}
	// Always 202, so the response never tells whether an account exists.
	return json(202, { ok: true });
}

/**
 * Signing in sets the session cookie, so it needs the CSRF header too: without it a cross-site
 * form could sign a visitor into someone else's account (login CSRF).
 */
async function authVerify(s: Store, request: Request): Promise<Response> {
	if (!csrfOk(request)) return jsonError(403, 'csrf_required', 'Send the X-Colander-CSRF: 1 header with this request.');
	const body = await decode(request, 4 << 10, { token: 'string' });
	if (body instanceof Response) return body;
	const signedIn = s.auth.finishSignIn(trimSpace(body.token));
	if (!signedIn) return jsonError(400, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a new one.');
	return writeAccount(s, signedIn.account, { 'Set-Cookie': signedIn.cookie });
}

function authLogout(s: Store, request: Request): Response {
	if (!csrfOk(request)) return jsonError(403, 'csrf_required', 'Send the X-Colander-CSRF: 1 header with this request.');
	return new Response(null, { status: 204, headers: { 'Set-Cookie': s.auth.signOut(request) } });
}

function getAccount(s: Store, request: Request): Response {
	const a = session(s.auth, request);
	return a instanceof Response ? a : writeAccount(s, a);
}

async function patchAccount(s: Store, request: Request): Promise<Response> {
	const a = session(s.auth, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 4 << 10, { display_name: 'string?' });
	if (body instanceof Response) return body;
	const name = trimSpace(body.display_name ?? '');
	if ([...name].length > 60 || /[\r\n\t]/.test(name)) {
		return jsonError(400, 'invalid_display_name', 'The display name must be one line of at most 60 characters.');
	}
	setDisplayName(s.db, a.id, name);
	return writeAccount(s, { ...a, displayName: name });
}

function reviewerToken(s: Store, request: Request): Response {
	const a = session(s.auth, request);
	if (a instanceof Response) return a;
	if (a.role !== 'curator' && a.role !== 'staff') {
		return jsonError(403, 'forbidden', 'Only curators and staff can create a reviewer token.');
	}
	return json(200, { token: s.auth.issueReviewerToken(a.id) });
}
