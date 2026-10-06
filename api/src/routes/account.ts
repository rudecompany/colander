// Accounts and sign-in (docs/contracts.md 6.6): emailed 6-digit codes and passkeys, invites that
// enroll a reviewer's passkey, sessions and step-up, passkey management, export, deletion, held
// requests and disconnecting the side panel (reviewer tokens come only from a pairing code,
// src/routes/pairing.ts). Every route that sets or uses the session needs the CSRF rule
// (src/auth.ts csrfOk), sign-in included, so a cross-site page can never sign a visitor in.
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { csrfOk, csrfRequired, hashToken, newCode, newToken, normalizeEmail, readCookie, safeNext, signedIn, TTL, type Auth } from '../auth';
import { StripeError, toPlan, UnavailableError } from '../billing';
import { eraseAccount, sendQuietly, StaffAccountError, undeletable } from '../erase';
import { IP_HASH_HEADER, json, jsonError, REQUEST_ID_HEADER, tooMany } from '../http';
import { allow, available } from '../limits';
import { codeSignInPaused, heldRequest, securityNotice, signInCode } from '../mail';
import { rank } from '../permissions';
import { decode, pathValue, rfc3339, trimSpace } from './respond';
import { unix } from '../scoring/engine';
import {
	addPasskey,
	audit,
	cancelAllRequests,
	cancelRequest,
	cancelRequestByHash,
	deleteFlow,
	deletePasskey,
	deleteReviewerToken,
	ensureAccount,
	failFlow,
	getAccount,
	getFlow,
	heldRequests,
	holdRequest,
	passkeyByCredential,
	passkeyCount,
	passkeys,
	putFlow,
	reviewerTokenOf,
	sessionDates,
	setDisplayName,
	takeFlow,
	useMagicLink,
	usePasskey,
	type Account,
	type AuditEntry,
	type HeldRequest,
	type Session
} from '../store/accounts';
import { current } from '../store/billing';
import { endPairings } from '../store/pairings';
import { getSync } from '../store/misc';
import type { Store } from '../store/store';
import {
	authenticationOptions,
	MAX_PASSKEYS,
	parseCredential,
	registrationOptions,
	relyingParty,
	verifyAuthentication,
	verifyRegistration,
	type RelyingParty
} from '../webauthn';

/** A route the Store registers: method, URLPattern pathname and handler. */
export type RouteSpec = [method: string, pattern: string, handler: (request: Request, url: URL, params: Record<string, string | undefined>) => Response | Promise<Response>];

/** Where Turnstile checks a token: with TURNSTILE_SECRET_KEY set, every code request needs one. */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function accountRoutes(s: Store, env: Pick<Env, 'PUBLIC_URL'> & { TURNSTILE_SECRET_KEY?: string }): RouteSpec[] {
	const publicUrl = env.PUBLIC_URL.replace(/\/+$/, '');
	const rp = relyingParty(publicUrl);
	const turnstile = env.TURNSTILE_SECRET_KEY ?? '';
	return [
		['POST', '/v1/auth/code', (r) => authCode(s, turnstile, r)],
		['POST', '/v1/auth/code/verify', (r) => authCodeVerify(s, r)],
		['POST', '/v1/auth/passkey/options', (r) => passkeyOptions(s, rp, r)],
		['POST', '/v1/auth/passkey/verify', (r) => passkeyVerify(s, rp, r)],
		['POST', '/v1/auth/invite/options', (r) => inviteOptions(s, rp, r)],
		['POST', '/v1/auth/invite/verify', (r) => inviteVerify(s, rp, r)],
		['POST', '/v1/auth/verify', (r) => authVerifyLink(s, r)],
		['POST', '/v1/auth/logout', (r) => authLogout(s, r)],
		['POST', '/v1/auth/cancel', (r) => cancelByLink(s, r)],
		['GET', '/v1/account', (r) => getAccountRoute(s, r)],
		['PATCH', '/v1/account', (r) => patchAccount(s, r)],
		['DELETE', '/v1/account', (r) => deleteAccountRoute(s, r)],
		['GET', '/v1/account/export', (r) => exportAccount(s, r)],
		['GET', '/v1/account/passkeys', (r) => listPasskeys(s, r)],
		['POST', '/v1/account/passkeys/options', (r) => addPasskeyOptions(s, rp, r)],
		['POST', '/v1/account/passkeys', (r) => addPasskeyRoute(s, rp, r)],
		['DELETE', '/v1/account/passkeys/:id', (r, _u, p) => removePasskey(s, r, pathValue(p, 'id'))],
		['POST', '/v1/account/requests', (r) => holdRoute(s, publicUrl, r)],
		['DELETE', '/v1/account/requests/:id', (r, _u, p) => cancelRoute(s, r, pathValue(p, 'id'))],
		['DELETE', '/v1/account/reviewer-token', (r) => revokeReviewerToken(s, r)]
	];
}

/** The audit fields of a request on the main host. */
export const main = (request: Request, actorId?: string): Omit<AuditEntry, 'action' | 'target'> => ({
	host: 'main',
	actorId,
	requestId: request.headers.get(REQUEST_ID_HEADER) ?? undefined
});

const passkeyJSON = (p: ReturnType<typeof passkeys>[number]) => ({
	id: p.id,
	name: p.name || null,
	created_at: rfc3339(p.createdAt),
	last_used_at: p.lastUsedAt ? rfc3339(p.lastUsedAt) : null,
	synced: p.backedUp
});

const requestJSON = (r: HeldRequest) => ({
	id: r.id,
	kind: r.kind,
	created_at: rfc3339(r.createdAt),
	due_at: rfc3339(r.dueAt),
	done_at: r.doneAt ? rfc3339(r.doneAt) : null,
	...(r.kind === 'remove_passkey' ? { passkey_id: r.arg } : {})
});

/** 200 with the account, its plan, how this session signed in, and its sign-in state. */
export function writeAccount(s: Store, a: Account, ses?: Session, headers: HeadersInit = {}): Response {
	const now = unix(s.now());
	const token = reviewerTokenOf(s.db, a.id);
	const account = {
		id: a.id,
		email: a.email,
		display_name: a.displayName === '' ? null : a.displayName,
		role: a.role,
		plan: toPlan(current(s.db, a.id), now),
		created_at: rfc3339(a.createdAt),
		session: ses ? { method: s.auth.passkey(ses) ? 'passkey' : 'email', authenticated_at: rfc3339(ses.authenticatedAt) } : null,
		passkey_count: passkeyCount(s.db, a.id),
		reviewer_token: token && token.expires_at > now ? { expires_at: rfc3339(token.expires_at), last_used_at: token.last_used_at ? rfc3339(token.last_used_at) : null } : null,
		requests: heldRequests(s.db, a.id, now).map(requestJSON)
	};
	return json(200, { account }, headers);
}

/** Checks a Turnstile token when Turnstile is configured. */
async function turnstileOk(secret: string, token: string): Promise<boolean> {
	if (!secret) return true;
	if (!token || token.length > 2048) return false;
	try {
		const res = await fetch(SITEVERIFY, {
			method: 'POST',
			body: new URLSearchParams({ secret, response: token }),
			signal: AbortSignal.timeout(5000)
		});
		return ((await res.json()) as { success?: boolean }).success === true;
	} catch {
		return false;
	}
}

/** The limiter key of an address: its hash, never the address. */
const emailKey = (email: string) => hashToken('email:' + email);

/**
 * POST /v1/auth/code {"email", "next", "turnstile"?}: emails a 6-digit code and sets the flow
 * cookie. Always 202 for a valid address, so the answer never tells whether an account exists;
 * 5 codes an hour and 10 a day per address, 30 an hour per IP; an address whose wrong-code budget
 * ran out gets no code for 24 hours, silently.
 */
async function authCode(s: Store, turnstileSecret: string, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const body = await decode(request, 8 << 10, { email: 'string', next: 'string', turnstile: 'string?' });
	if (body instanceof Response) return body;
	const email = normalizeEmail(body.email);
	if (!email) return jsonError(400, 'invalid_email', 'Enter a valid email address.');
	if (!(await turnstileOk(turnstileSecret, body.turnstile ?? ''))) {
		return jsonError(400, 'turnstile_failed', 'We could not check that this request came from a person. Try again.');
	}
	const now = s.now();
	const ip = request.headers.get(IP_HASH_HEADER) ?? '';
	const key = emailKey(email);
	const flow = newToken();
	const code = newCode();
	const started = s.db.tx(() => {
		const wait = allow(s.db, now, ip, 1, 'auth_email_ip') || allow(s.db, now, key, 1, 'auth_email', 'auth_email_day');
		if (wait > 0) return wait;
		putFlow(s.db, {
			tokenHash: flow.hash,
			kind: 'email_code',
			email,
			secretHash: hashToken(flow.raw + code),
			next: safeNext(body.next),
			createdAt: unix(now),
			expiresAt: unix(now) + TTL.code
		});
		return available(s.db, now, key, 'auth_lock') ? 0 : -1;
	});
	if (started > 0) return tooMany(started / 1000);
	if (started === 0) {
		s.countSignInMail(now);
		await sendQuietly(s, email, signInCode(code));
	}
	return json(202, { ok: true }, { 'Set-Cookie': s.auth.cookie(s.auth.names.flow, flow.raw, TTL.code) });
}

/** The email code's flow cookie token, or ''. */
const flowToken = (auth: Auth, request: Request) => readCookie(request, auth.names.flow);

/** The passkey challenge cookie's token, or ''. */
const pkToken = (auth: Auth, request: Request) => readCookie(request, auth.names.pk);

const codeExpired = () => jsonError(400, 'code_expired', 'This code has expired or was used up. Ask for a new one.');

/**
 * POST /v1/auth/code/verify {"code"}: needs the flow cookie of the same browser. A code works once
 * for 10 minutes, 5 wrong codes end the flow, 30 tries per IP an hour, and 10 wrong codes a day
 * for one address pause code sign-in for it for 24 hours. The first sign-in creates the account.
 * The session is new (rotated) and counts as an email sign-in.
 */
async function authCodeVerify(s: Store, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const body = await decode(request, 1 << 10, { code: 'string' });
	if (body instanceof Response) return body;
	const token = flowToken(s.auth, request);
	if (!token) return codeExpired();
	const now = s.now();
	const ip = request.headers.get(IP_HASH_HEADER) ?? '';
	const flowHash = hashToken(token);
	const code = trimSpace(body.code).replace(/\s+/g, '');
	let paused = '';
	const result = s.db.tx((): Response | { account: Account; cookie: string; session: Session } => {
		const wait = allow(s.db, now, ip, 1, 'auth_verify_ip');
		if (wait > 0) return tooMany(wait / 1000);
		const flow = getFlow(s.db, flowHash, 'email_code', unix(now));
		if (!flow) return codeExpired();
		const key = emailKey(flow.email);
		if (!available(s.db, now, key, 'auth_lock')) {
			deleteFlow(s.db, flowHash);
			return jsonError(400, 'code_paused', 'Sign-in codes are paused for this address for 24 hours. Sign in with a passkey, or try again tomorrow.');
		}
		if (!/^\d{6}$/.test(code) || hashToken(token + code) !== flow.secretHash) {
			const attempts = failFlow(s.db, flowHash);
			allow(s.db, now, key, 1, 'auth_fail');
			if (!available(s.db, now, key, 'auth_fail')) {
				// The day's budget is used up: code sign-in pauses for 24 hours, and the address hears once.
				if (allow(s.db, now, key, 1, 'auth_lock') === 0) paused = flow.email;
				deleteFlow(s.db, flowHash);
				return jsonError(400, 'code_paused', 'Too many wrong codes for this address. Sign-in codes are paused for 24 hours; a passkey still works.');
			}
			if (attempts >= 5) {
				deleteFlow(s.db, flowHash);
				return jsonError(400, 'code_expired', 'That code is not right, and this code is now used up after 5 tries. Ask for a new one.');
			}
			return jsonError(400, 'code_invalid', 'That code is not right. Check the latest email from Colander and try again.');
		}
		if (!takeFlow(s.db, flowHash, 'email_code', unix(now))) return codeExpired();
		const account = ensureAccount(s.db, flow.email, unix(now));
		const started = s.auth.startSession(request, account.id, 'email');
		audit(s.db, { ...main(request, account.id), action: 'signed_in', target: account.id, after: 'email' }, unix(now));
		return { account, ...started };
	});
	if (paused) await sendQuietly(s, paused, codeSignInPaused());
	if (result instanceof Response) return result;
	const headers = new Headers();
	headers.append('Set-Cookie', result.cookie);
	headers.append('Set-Cookie', s.auth.cookie(s.auth.names.flow, '', 0));
	return writeAccount(s, result.account, result.session, headers);
}

const passkeyInvalid = () => jsonError(400, 'passkey_invalid', 'That passkey did not work here. Try again, or sign in with an email code.');

/**
 * POST /v1/auth/passkey/options: a challenge for a passkey sign-in, tied to the passkey cookie for
 * 5 minutes. With a session it is a step-up and offers only that account's passkeys. Without one,
 * 60 per IP an hour.
 */
async function passkeyOptions(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const ses = s.auth.session(request);
	const now = s.now();
	if (!ses) {
		const wait = allow(s.db, now, request.headers.get(IP_HASH_HEADER) ?? '', 1, 'passkey_options_ip');
		if (wait > 0) return tooMany(wait / 1000);
	}
	const allowed = ses ? passkeys(s.db, ses.account.id) : [];
	if (ses && allowed.length === 0) return jsonError(409, 'no_passkey', 'This account has no passkey yet. Confirm with an email code instead.');
	const options = await authenticationOptions(rp, allowed);
	const flow = newToken();
	putFlow(s.db, {
		tokenHash: flow.hash,
		kind: 'passkey',
		accountId: ses?.account.id,
		challenge: options.challenge,
		createdAt: unix(now),
		expiresAt: unix(now) + TTL.challenge
	});
	return json(200, { options }, { 'Set-Cookie': s.auth.cookie(s.auth.names.pk, flow.raw, TTL.challenge) });
}

/**
 * POST /v1/auth/passkey/verify {"credential"}: signs in, or steps up, with a passkey. The
 * signature is checked before the transaction (WebCrypto is async); the transaction then uses up
 * the challenge (only one request can), records the counter and starts a new passkey session. A
 * passkey sign-in cancels every request the account had waiting.
 */
async function passkeyVerify(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const body = await decode(request, 16 << 10, { credential: 'raw' });
	if (body instanceof Response) return body;
	const cred = parseCredential<AuthenticationResponseJSON>(body.credential);
	const token = pkToken(s.auth, request);
	if (!cred || !token) return passkeyInvalid();
	const flowHash = hashToken(token);
	const flow = getFlow(s.db, flowHash, 'passkey', unix(s.now()));
	const pk = passkeyByCredential(s.db, cred.id);
	if (!flow || !pk || (flow.accountId !== '' && flow.accountId !== pk.accountId)) return passkeyInvalid();
	const verified = await verifyAuthentication(rp, cred, flow.challenge, pk);
	if (!verified) return passkeyInvalid();
	const now = unix(s.now());
	const result = s.db.tx(() => {
		const taken = takeFlow(s.db, flowHash, 'passkey', now);
		if (!taken || taken.challenge !== flow.challenge) return undefined;
		usePasskey(s.db, pk.id, verified.signCount, verified.backedUp, now);
		const started = s.auth.startSession(request, pk.accountId, 'passkey', pk.id);
		const cancelled = cancelAllRequests(s.db, pk.accountId, now);
		audit(s.db, { ...main(request, pk.accountId), action: 'signed_in', target: pk.accountId, after: 'passkey' }, now);
		for (const r of cancelled) audit(s.db, { ...main(request, pk.accountId), action: 'request_cancelled', target: pk.accountId, before: r.kind, reason: 'passkey sign-in' }, now);
		return { ...started, account: getAccount(s.db, pk.accountId)! };
	});
	if (!result) return passkeyInvalid();
	const headers = new Headers();
	headers.append('Set-Cookie', result.cookie);
	headers.append('Set-Cookie', s.auth.cookie(s.auth.names.pk, '', 0));
	return writeAccount(s, result.account, result.session, headers);
}

const inviteInvalid = () =>
	jsonError(400, 'invite_invalid', 'This invite does not work: it expired, was used, or belongs to another account. Ask the admin who sent it for a new one.');

/**
 * The invite an account may redeem now: unexpired, unused, for this account, and issued for the
 * role the account still holds.
 */
function usableInvite(s: Store, ses: Session, invite: string) {
	const inv = getFlow(s.db, hashToken(invite), 'invite', unix(s.now()));
	if (!inv || inv.accountId !== ses.account.id || inv.role !== ses.account.role || rank(inv.role) < rank('curator')) return undefined;
	return inv;
}

/**
 * POST /v1/auth/invite/options {"invite"}: the options to enroll a reviewer's passkey with an
 * invite. It needs a session of the same account (an email code is enough), so an invite works
 * only together with control of that mailbox.
 */
async function inviteOptions(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const body = await decode(request, 1 << 10, { invite: 'string' });
	if (body instanceof Response) return body;
	const inv = usableInvite(s, ses, trimSpace(body.invite));
	if (!inv) return inviteInvalid();
	return registrationFlow(s, rp, ses, inv.tokenHash);
}

/** Starts a passkey registration for the session's account; for an invite, secretHash ties it to the invite. */
async function registrationFlow(s: Store, rp: RelyingParty, ses: Session, inviteHash = ''): Promise<Response> {
	const existing = passkeys(s.db, ses.account.id);
	if (existing.length >= MAX_PASSKEYS) return jsonError(409, 'too_many_passkeys', `An account can hold ${MAX_PASSKEYS} passkeys. Remove one first.`);
	const options = await registrationOptions(rp, ses.account, existing);
	const flow = newToken();
	const now = unix(s.now());
	putFlow(s.db, {
		tokenHash: flow.hash,
		kind: 'register',
		accountId: ses.account.id,
		secretHash: inviteHash,
		challenge: options.challenge,
		createdAt: now,
		expiresAt: now + TTL.challenge
	});
	return json(200, { options }, { 'Set-Cookie': s.auth.cookie(s.auth.names.pk, flow.raw, TTL.challenge) });
}

/** A passkey name: one line of at most 60 characters, or a default. */
function passkeyName(raw: string | undefined): string | Response {
	const name = trimSpace(raw ?? '');
	if ([...name].length > 60 || /\p{Cc}/u.test(name)) return jsonError(400, 'invalid_name', 'The passkey name must be one line of at most 60 characters.');
	return name;
}

/**
 * Verifies a registration for the session's flow and, in one transaction with the rest of the
 * caller's writes, stores the passkey. Returns the new passkey id or the error.
 */
async function finishRegistration(
	s: Store,
	rp: RelyingParty,
	request: Request,
	ses: Session,
	raw: string,
	name: string,
	inviteHash: string,
	then: (passkeyId: string, now: number) => void
): Promise<string | Response> {
	const token = pkToken(s.auth, request);
	const cred = parseCredential<RegistrationResponseJSON>(raw);
	if (!token || !cred) return passkeyInvalid();
	const flowHash = hashToken(token);
	const flow = getFlow(s.db, flowHash, 'register', unix(s.now()));
	if (!flow || flow.accountId !== ses.account.id || flow.secretHash !== inviteHash) return passkeyInvalid();
	const created = await verifyRegistration(rp, cred, flow.challenge);
	if (!created) return passkeyInvalid();
	const now = unix(s.now());
	try {
		return s.db.tx(() => {
			const taken = takeFlow(s.db, flowHash, 'register', now);
			if (!taken || taken.challenge !== flow.challenge) throw new Refused(passkeyInvalid());
			if (passkeyCount(s.db, ses.account.id) >= MAX_PASSKEYS) {
				throw new Refused(jsonError(409, 'too_many_passkeys', `An account can hold ${MAX_PASSKEYS} passkeys. Remove one first.`));
			}
			if (passkeyByCredential(s.db, created.credentialId)) throw new Refused(jsonError(409, 'passkey_exists', 'This passkey is already registered.'));
			const id = addPasskey(s.db, { ...created, accountId: ses.account.id, name }, now);
			audit(s.db, { ...main(request, ses.account.id), action: 'passkey_added', target: ses.account.id, after: id }, now);
			then(id, now);
			return id;
		});
	} catch (err) {
		if (err instanceof Refused) return err.res;
		throw err;
	}
}

/** Rolls a transaction back with an answer. */
class Refused extends Error {
	constructor(readonly res: Response) {
		super('refused');
	}
}

/**
 * POST /v1/auth/invite/verify {"invite", "credential", "name"}: enrolls the invited passkey and
 * signs the session in with it. The invite is used up in the same transaction, and only if the
 * account still holds the role it was issued for. Both addresses of record hear about it.
 */
async function inviteVerify(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const body = await decode(request, 16 << 10, { invite: 'string', credential: 'raw', name: 'string?' });
	if (body instanceof Response) return body;
	const name = passkeyName(body.name);
	if (name instanceof Response) return name;
	const inviteHash = hashToken(trimSpace(body.invite));
	if (!usableInvite(s, ses, trimSpace(body.invite))) return inviteInvalid();
	let started: { cookie: string; session: Session } | undefined;
	const id = await finishRegistration(s, rp, request, ses, body.credential, name, inviteHash, (passkeyId, now) => {
		const inv = takeFlow(s.db, inviteHash, 'invite', now);
		const account = getAccount(s.db, ses.account.id)!;
		if (!inv || inv.accountId !== account.id || inv.role !== account.role) throw new Refused(inviteInvalid());
		started = s.auth.startSession(request, account.id, 'passkey', passkeyId);
		audit(s.db, { ...main(request, account.id), action: 'invite_redeemed', target: account.id, after: passkeyId }, now);
	});
	if (id instanceof Response) return id;
	await sendQuietly(s, ses.account.email, securityNotice('A passkey was added to your account with an invite'));
	const headers = new Headers();
	headers.append('Set-Cookie', started!.cookie);
	headers.append('Set-Cookie', s.auth.cookie(s.auth.names.pk, '', 0));
	return writeAccount(s, started!.session.account, started!.session, headers);
}

/**
 * POST /v1/auth/verify {"token"}: finishes a sign-in link mailed before code sign-in shipped.
 * Links are no longer sent and die within 20 minutes; this goes with the next release.
 */
async function authVerifyLink(s: Store, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const body = await decode(request, 4 << 10, { token: 'string' });
	if (body instanceof Response) return body;
	const now = unix(s.now());
	const signedIn = s.db.tx(() => {
		const a = useMagicLink(s.db, hashToken(trimSpace(body.token)), now);
		if (!a) return undefined;
		audit(s.db, { ...main(request, a.id), action: 'signed_in', target: a.id, after: 'email_link' }, now);
		return s.auth.startSession(request, a.id, 'email');
	});
	if (!signedIn) return jsonError(400, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a code instead.');
	return writeAccount(s, signedIn.session.account, signedIn.session, { 'Set-Cookie': signedIn.cookie });
}

/**
 * POST /v1/auth/logout {"everywhere"?}: ends this session. Everywhere ends every session, the
 * reviewer token and the pairing codes not yet used; from a passkey session of the last 10 minutes it also removes every other
 * passkey, so one an intruder added does not outlive the owner taking the mailbox back.
 */
async function authLogout(s: Store, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	let everywhere = false;
	if (Number(request.headers.get('Content-Length') ?? 0) > 0) {
		const body = await decode(request, 1 << 10, { everywhere: 'bool?' });
		if (body instanceof Response) return body;
		everywhere = body.everywhere === true;
	}
	const ses = s.auth.session(request);
	if (everywhere && ses) {
		const now = unix(s.now());
		const removed = s.db.tx(() => {
			let n = 0;
			if (s.auth.passkey(ses) && s.auth.recent(ses)) {
				n = passkeys(s.db, ses.account.id).filter((p) => p.id !== ses.passkeyId).length;
				s.db.run('DELETE FROM passkeys WHERE account_id = ? AND id != ?', ses.account.id, ses.passkeyId);
			}
			s.db.run('DELETE FROM sessions WHERE account_id = ?', ses.account.id);
			deleteReviewerToken(s.db, ses.account.id);
			endPairings(s.db, ses.account.id);
			audit(s.db, { ...main(request, ses.account.id), action: 'signed_out_everywhere', target: ses.account.id }, now);
			return n;
		});
		if (removed > 0) await sendQuietly(s, ses.account.email, securityNotice('Every other passkey was taken off your account'));
		return new Response(null, { status: 204, headers: { 'Set-Cookie': s.auth.cookie(s.auth.names.session, '', 0) } });
	}
	return new Response(null, { status: 204, headers: { 'Set-Cookie': s.auth.signOut(request) } });
}

/** POST /v1/auth/cancel {"secret"}: the link in the email that cancels a held request. */
async function cancelByLink(s: Store, request: Request): Promise<Response> {
	if (!csrfOk(request)) return csrfRequired();
	const body = await decode(request, 1 << 10, { secret: 'string' });
	if (body instanceof Response) return body;
	const now = unix(s.now());
	const r = s.db.tx(() => {
		const r = cancelRequestByHash(s.db, hashToken(trimSpace(body.secret)), now);
		if (r) audit(s.db, { ...main(request), action: 'request_cancelled', target: r.accountId, before: r.kind, reason: 'cancel link' }, now);
		return r;
	});
	if (!r) return jsonError(404, 'not_found', 'Nothing is waiting under this link: it was cancelled, it already ran, or the link is wrong.');
	return json(200, { cancelled: r.kind });
}

function getAccountRoute(s: Store, request: Request): Response {
	const ses = signedIn(s.auth, request);
	return ses instanceof Response ? ses : writeAccount(s, ses.account, ses);
}

async function patchAccount(s: Store, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const body = await decode(request, 4 << 10, { display_name: 'string?' });
	if (body instanceof Response) return body;
	const name = trimSpace(body.display_name ?? '');
	if ([...name].length > 60 || /[\r\n\t]/.test(name)) {
		return jsonError(400, 'invalid_display_name', 'The display name must be one line of at most 60 characters.');
	}
	setDisplayName(s.db, ses.account.id, name);
	return writeAccount(s, { ...ses.account, displayName: name }, ses);
}

function listPasskeys(s: Store, request: Request): Response {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	return json(200, { passkeys: passkeys(s.db, ses.account.id).map(passkeyJSON), current: ses.passkeyId || null });
}

/**
 * Who may add a passkey: a member after a recent sign-in, with a passkey when the account already
 * holds one; a curator, staff member or admin only from a recent passkey session of that account
 * (the first one comes through an invite), so a stolen mailbox never gains review authority. A
 * reviewer with a passkey who signed in with a code is asked for that passkey (passkey_required).
 */
function mayAddPasskey(s: Store, ses: Session): Response | null {
	if (rank(ses.account.role) >= rank('curator')) {
		if (passkeyCount(s.db, ses.account.id) === 0) {
			return jsonError(403, 'invite_required', 'Reviewer accounts add their first passkey with an invite from an admin, and more passkeys from a passkey sign-in.');
		}
		return s.auth.stepUp(ses, { passkey: true });
	}
	return s.auth.stepUp(ses);
}

async function addPasskeyOptions(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const refused = mayAddPasskey(s, ses);
	if (refused) return refused;
	return registrationFlow(s, rp, ses);
}

/** POST /v1/account/passkeys {"credential", "name"}: adds a passkey; the address hears about it. */
async function addPasskeyRoute(s: Store, rp: RelyingParty, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const refused = mayAddPasskey(s, ses);
	if (refused) return refused;
	const body = await decode(request, 16 << 10, { credential: 'raw', name: 'string?' });
	if (body instanceof Response) return body;
	const name = passkeyName(body.name);
	if (name instanceof Response) return name;
	const id = await finishRegistration(s, rp, request, ses, body.credential, name, '', () => undefined);
	if (id instanceof Response) return id;
	await sendQuietly(s, ses.account.email, securityNotice('A passkey was added to your account'));
	const headers = new Headers({ 'Set-Cookie': s.auth.cookie(s.auth.names.pk, '', 0) });
	const p = passkeys(s.db, ses.account.id).find((x) => x.id === id)!;
	return json(201, { passkey: passkeyJSON(p) }, headers);
}

/** DELETE /v1/account/passkeys/{id}: needs a passkey sign-in of the last 10 minutes; with only a code it is a held request. */
async function removePasskey(s: Store, request: Request, id: string): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const refused = s.auth.stepUp(ses, { passkey: true });
	if (refused) return refused;
	const now = unix(s.now());
	const ok = s.db.tx(() => {
		if (!deletePasskey(s.db, ses.account.id, id)) return false;
		audit(s.db, { ...main(request, ses.account.id), action: 'passkey_removed', target: ses.account.id, before: id }, now);
		return true;
	});
	if (!ok) return jsonError(404, 'not_found', 'This account has no such passkey.');
	await sendQuietly(s, ses.account.email, securityNotice('A passkey was taken off your account'));
	return new Response(null, { status: 204 });
}

/**
 * GET /v1/account/export: everything Colander keeps about the account, as a JSON attachment. It
 * needs a recent sign-in, with a passkey when the account holds one; an export held for 72 hours
 * (asked for with only a code) may be downloaded after a recent code sign-in for 7 days.
 */
function exportAccount(s: Store, request: Request): Response {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const now = unix(s.now());
	let refused = s.auth.stepUp(ses);
	if (refused && s.auth.recent(ses) && heldRequests(s.db, ses.account.id, now).some((r) => r.kind === 'export' && r.doneAt > 0)) refused = null;
	if (refused) return refused;
	const a = ses.account;
	const sync = getSync(s.db, a.id);
	const sub = current(s.db, a.id);
	const at = (t: number) => (t ? rfc3339(t) : null);
	const data = {
		exported_at: rfc3339(now),
		account: { id: a.id, email: a.email, display_name: a.displayName || null, role: a.role, created_at: rfc3339(a.createdAt) },
		passkeys: passkeys(s.db, a.id).map(passkeyJSON),
		sessions: sessionDates(s.db, a.id).map((x) => ({
			method: x.method,
			created_at: at(x.created_at),
			authenticated_at: at(x.authenticated_at),
			last_seen_at: at(x.last_seen_at),
			expires_at: at(x.expires_at)
		})),
		reviewer_token: (() => {
			const t = reviewerTokenOf(s.db, a.id);
			return t ? { created_at: at(t.created_at), expires_at: at(t.expires_at), last_used_at: at(t.last_used_at) } : null;
		})(),
		subscription: sub
			? { plan: toPlan(sub, now), interval: sub.interval, status: sub.status, started_at: at(sub.createdAt), period_end: at(sub.periodEnd) }
			: null,
		synced_settings: sync.version > 0 ? { version: sync.version, updated_at: at(sync.updatedAt), data: JSON.parse(sync.data) as unknown } : null,
		decisions: s.db
			.all<{ verdict: string; reason: string; actor: string; created_at: number; platform: string; source_key: string }>(
				`SELECT d.verdict, d.reason, d.actor, d.created_at, s.platform, s.canonical_id AS source_key
				FROM decisions d JOIN sources s ON s.id = d.source_id WHERE d.account_id = ? ORDER BY d.id`,
				a.id
			)
			.map((d) => ({ at: at(d.created_at), platform: d.platform, source: d.source_key, verdict: d.verdict, reason: d.reason, as: d.actor })),
		requests: heldRequests(s.db, a.id, now).map(requestJSON),
		pairings: s.db
			.all<{ kind: string; created_at: number; expires_at: number; claimed_at: number | null; browser: string | null; ext_version: string | null }>(
				'SELECT kind, created_at, expires_at, claimed_at, browser, ext_version FROM pairings WHERE account_id = ? ORDER BY created_at',
				a.id
			)
			.map((p) => ({ kind: p.kind, created_at: at(p.created_at), expires_at: at(p.expires_at), claimed_at: at(p.claimed_at ?? 0), browser: p.browser, ext_version: p.ext_version })),
		audit: s.db
			.all<{ at: number; action: string; host: string; actor_id: string | null }>(
				'SELECT at, action, host, actor_id FROM audit_log WHERE target = ? ORDER BY id',
				a.id
			)
			.map((e) => ({ at: at(e.at), action: e.action, host: e.host, by_you: e.actor_id === null || e.actor_id === a.id }))
	};
	audit(s.db, { ...main(request, a.id), action: 'exported', target: a.id }, now);
	return json(200, data, { 'Content-Disposition': 'attachment; filename="colander-account.json"' });
}

/** Staff and admin accounts are never deleted here (erase.ts StaffAccountError). */
const staffAccount = () =>
	jsonError(403, 'staff_account', 'Staff and admin accounts stay open until an admin lowers the role on the admin host. Then you can delete it.');

/**
 * DELETE /v1/account: needs a recent sign-in, with a passkey when the account holds one. Ends
 * Plus (refunding when refundable), deletes the Stripe customer and then the account. Staff and
 * admin accounts are refused.
 */
async function deleteAccountRoute(s: Store, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	if (undeletable(ses.account.role)) return staffAccount();
	const refused = s.auth.stepUp(ses);
	if (refused) return refused;
	try {
		await eraseAccount(s, ses.account.id, main(request, ses.account.id));
	} catch (err) {
		if (err instanceof StaffAccountError) return staffAccount();
		if (err instanceof UnavailableError) {
			return jsonError(503, 'billing_unavailable', 'We could not end your Plus plan right now, so your account is unchanged. Please try again later.');
		}
		if (err instanceof StripeError) {
			console.error(JSON.stringify({ message: 'stripe call failed', route: 'DELETE /v1/account', error: err.message }));
			return jsonError(502, 'payment_provider_error', 'Our payment provider did not answer, so your account is unchanged. Please try again in a moment.');
		}
		throw err;
	}
	return new Response(null, { status: 204, headers: { 'Set-Cookie': s.auth.cookie(s.auth.names.session, '', 0) } });
}

const HELD_WORDS: Record<'delete' | 'export' | 'remove_passkey', string> = {
	delete: 'Delete the account',
	export: 'Download a copy of your data',
	remove_passkey: 'Remove a passkey'
};

/**
 * POST /v1/account/requests {"kind", "passkey_id"?}: what an account that holds a passkey asks for
 * with only an email code: deletion, an export, or removing a passkey (one that was lost). It waits
 * 72 hours; the email has a cancel link, and any passkey sign-in cancels it.
 */
async function holdRoute(s: Store, publicUrl: string, request: Request): Promise<Response> {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const body = await decode(request, 1 << 10, { kind: 'string', passkey_id: 'string?' });
	if (body instanceof Response) return body;
	const kind = body.kind;
	if (kind !== 'delete' && kind !== 'export' && kind !== 'remove_passkey') {
		return jsonError(400, 'invalid_kind', 'kind must be delete, export or remove_passkey.');
	}
	if (kind === 'delete' && undeletable(ses.account.role)) return staffAccount();
	if (!s.auth.recent(ses)) return jsonError(403, 'recent_auth_required', 'Confirm it is you to do this. For your safety we ask again after 10 minutes.');
	if (passkeyCount(s.db, ses.account.id) === 0 || s.auth.passkey(ses)) {
		return jsonError(409, 'not_needed', 'You can do this now, without waiting.');
	}
	if (kind === 'remove_passkey' && !passkeys(s.db, ses.account.id).some((p) => p.id === body.passkey_id)) {
		return jsonError(404, 'not_found', 'This account has no such passkey.');
	}
	const now = unix(s.now());
	const cancel = newToken();
	const due = now + TTL.held;
	const id = s.db.tx(() => {
		if (heldRequests(s.db, ses.account.id, now).some((r) => r.kind === kind && r.doneAt === 0)) return '';
		const id = holdRequest(s.db, { accountId: ses.account.id, kind, arg: body.passkey_id, cancelHash: cancel.hash, dueAt: due }, now);
		audit(s.db, { ...main(request, ses.account.id), action: 'request_held', target: ses.account.id, after: kind }, now);
		return id;
	});
	if (!id) return jsonError(409, 'already_waiting', 'This request is already waiting.');
	s.jobs.schedule('requests', due * 1000);
	await sendQuietly(s, ses.account.email, heldRequest(HELD_WORDS[kind], 3, `${publicUrl}/account/cancel#${cancel.raw}`));
	const r = heldRequests(s.db, ses.account.id, now).find((x) => x.id === id)!;
	return json(201, { request: requestJSON(r) });
}

/** DELETE /v1/account/requests/{id}: cancels a waiting request from the account page. */
function cancelRoute(s: Store, request: Request, id: string): Response {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const now = unix(s.now());
	const r = s.db.tx(() => {
		const r = cancelRequest(s.db, ses.account.id, id, now);
		if (r) audit(s.db, { ...main(request, ses.account.id), action: 'request_cancelled', target: ses.account.id, before: r.kind }, now);
		return r;
	});
	return r ? new Response(null, { status: 204 }) : jsonError(404, 'not_found', 'Nothing with this ID is waiting.');
}

/** DELETE /v1/account/reviewer-token: disconnects the side panel. */
function revokeReviewerToken(s: Store, request: Request): Response {
	const ses = signedIn(s.auth, request);
	if (ses instanceof Response) return ses;
	const now = unix(s.now());
	s.db.tx(() => {
		if (deleteReviewerToken(s.db, ses.account.id)) audit(s.db, { ...main(request, ses.account.id), action: 'token_revoked', target: ses.account.id }, now);
	});
	return new Response(null, { status: 204 });
}
