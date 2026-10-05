// The admin API (docs/contracts.md 6.9): people, roles, passkey invites, revocation, support email
// changes, supporter credit and the audit log. It exists only on the admin host, where the edge
// has verified Cloudflare Access and dropped every other credential; the role comes from the
// Store on every request, and can() (src/permissions.ts) decides every action.
import { csrfOk, csrfRequired, emailRef, newToken, normalizeEmail, TTL } from '../auth';
import { StripeError, UnavailableError } from '../billing';
import { sendQuietly } from '../erase';
import { json, jsonError } from '../http';
import { emailChangeHeld, securityNotice } from '../mail';
import { can, PERMISSIONS, type Action } from '../permissions';
import { decode, parseInt64, pathValue, rfc3339, trimSpace } from './respond';
import { unix } from '../scoring/engine';
import { staffOf, type Staff } from '../staff';
import { accountByEmail, audit, getAccount, grantRole, holdRequest, passkeyCount, putFlow, revokeCredentials, type Account } from '../store/accounts';
import type { Store } from '../store/store';
import type { RouteSpec } from './account';

export function adminRoutes(s: Store, env: Pick<Env, 'PUBLIC_URL'>): RouteSpec[] {
	const publicUrl = env.PUBLIC_URL.replace(/\/+$/, '');
	return [
		['GET', '/v1/admin/me', (r) => me(s, r)],
		['GET', '/v1/admin/people', (r, u) => people(s, r, u)],
		['PUT', '/v1/admin/people/role', (r) => setRole(s, r)],
		['POST', '/v1/admin/people/:id/invite', (r, _u, p) => invite(s, publicUrl, r, pathValue(p, 'id'))],
		['POST', '/v1/admin/people/:id/revoke', (r, _u, p) => revoke(s, r, pathValue(p, 'id'))],
		['PUT', '/v1/admin/people/:id/email', (r, _u, p) => changeEmail(s, publicUrl, r, pathValue(p, 'id'))],
		['POST', '/v1/admin/donations/:id/credit', (r, _u, p) => credit(s, r, pathValue(p, 'id'))],
		['GET', '/v1/admin/audit', (r, u) => auditLog(s, r, u)]
	];
}

/** The staff member, checked for CSRF on writes and for one permission. */
function staffFor(s: Store, request: Request, action: Action): Staff | Response {
	if (!csrfOk(request)) return csrfRequired();
	const st = staffOf(s, request);
	if (st instanceof Response) return st;
	return can(st.actor, action) ? st : forbidden();
}

const forbidden = () => jsonError(403, 'forbidden', 'Your role does not allow this.');

const personJSON = (s: Store, a: Account) => ({
	id: a.id,
	email: a.email,
	display_name: a.displayName || null,
	role: a.role,
	created_at: rfc3339(a.createdAt),
	passkey_count: passkeyCount(s.db, a.id),
	access_pinned: a.accessSubject !== ''
});

/** GET /v1/admin/me: who is signed in, and what they may do. */
function me(s: Store, request: Request): Response {
	const st = staffOf(s, request);
	if (st instanceof Response) return st;
	const allowed = (Object.keys(PERMISSIONS) as Action[]).filter((a) => can(st.actor, a));
	return json(200, { account: personJSON(s, st.account), authority: st.actor.authority, permissions: allowed });
}

/**
 * GET /v1/admin/people?q=: up to 50 accounts whose email contains q, or every reviewer without q.
 * A search can reach members' addresses, so it is audited with the accounts it found, never the
 * query, which may be an address; the reviewer list, which staff open on every visit, is not.
 */
function people(s: Store, request: Request, url: URL): Response {
	const st = staffFor(s, request, 'people.read');
	if (st instanceof Response) return st;
	const q = trimSpace(url.searchParams.get('q') ?? '').toLowerCase().slice(0, 254);
	const rows = q
		? s.db.all<{ id: string }>("SELECT id FROM accounts WHERE instr(email, ?) > 0 ORDER BY email LIMIT 50", q)
		: s.db.all<{ id: string }>("SELECT id FROM accounts WHERE role != 'member' ORDER BY role DESC, email LIMIT 50");
	if (q) audit(s.db, { ...st.who, action: 'people_searched', after: rows.map((r) => r.id).join(' '), reason: `${rows.length} found` }, unix(s.now()));
	return json(200, { people: rows.map((r) => personJSON(s, getAccount(s.db, r.id)!)) });
}

/**
 * PUT /v1/admin/people/role {"email", "role"}: grants or revokes a role below the actor's own on
 * an account below it, creating a member account for a new address. Raising it to a review role
 * ends the account's sessions, passkeys and token: the new reviewer enrolls through an invite.
 */
async function setRole(s: Store, request: Request): Promise<Response> {
	const st = staffFor(s, request, 'role.set');
	if (st instanceof Response) return st;
	const body = await decode(request, 1 << 10, { email: 'string', role: 'string' });
	if (body instanceof Response) return body;
	const email = normalizeEmail(body.email);
	if (!email) return jsonError(400, 'invalid_email', 'Enter a valid email address.');
	const target = accountByEmail(s.db, email);
	if (!can(st.actor, 'role.set', { id: target?.id ?? '', role: target?.role ?? 'member', newRole: body.role })) return forbidden();
	const a = grantRole(s.db, email, body.role, unix(s.now()), st.who);
	return json(200, { person: personJSON(s, a) });
}

/**
 * POST /v1/admin/people/{id}/invite: a single-use passkey invite for a review account, valid 24
 * hours and bound to the account and its role. Staff invite curators; only an admin invites staff
 * or admin; nobody invites themselves. The invite is shown to the issuer only, never emailed; the
 * account gets a notice that one was issued.
 */
async function invite(s: Store, publicUrl: string, request: Request, id: string): Promise<Response> {
	const st = staffFor(s, request, 'invite.issue');
	if (st instanceof Response) return st;
	const target = getAccount(s.db, id);
	if (!target) return jsonError(404, 'not_found', 'No account has this ID.');
	if (!can(st.actor, 'invite.issue', { id: target.id, role: target.role })) return forbidden();
	const secret = newToken('inv_');
	const now = unix(s.now());
	s.db.tx(() => {
		putFlow(s.db, {
			tokenHash: secret.hash,
			kind: 'invite',
			accountId: target.id,
			role: target.role,
			actorId: st.account.id,
			createdAt: now,
			expiresAt: now + TTL.invite
		});
		audit(s.db, { ...st.who, action: 'invite_issued', target: target.id, after: target.role }, now);
	});
	await sendQuietly(
		s,
		target.email,
		securityNotice('A passkey invite was issued for your account', 'tell the Colander team by replying to this email. The invite does nothing without your email sign-in.')
	);
	return json(201, { invite: secret.raw, url: `${publicUrl}/account/invite#invite=${secret.raw}`, expires_at: rfc3339(now + TTL.invite) });
}

/** POST /v1/admin/people/{id}/revoke: ends every session and deletes every passkey and token of an account below the admin. */
function revoke(s: Store, request: Request, id: string): Response {
	const st = staffFor(s, request, 'people.revoke');
	if (st instanceof Response) return st;
	const target = getAccount(s.db, id);
	if (!target) return jsonError(404, 'not_found', 'No account has this ID.');
	if (!can(st.actor, 'people.revoke', { id: target.id, role: target.role })) return forbidden();
	s.db.tx(() => {
		revokeCredentials(s.db, target.id);
		audit(s.db, { ...st.who, action: 'revoked', target: target.id }, unix(s.now()));
	});
	return json(200, { person: personJSON(s, target) });
}

/**
 * PUT /v1/admin/people/{id}/email {"email", "checkout_session", "amount_cents", "date"}: moves a
 * member who lost their mailbox to a new address, after support matched a Stripe receipt: the
 * Checkout Session ID, the amount and the UTC date (YYYY-MM-DD) must all match this account's
 * checkout. The move waits 7 days with a cancel link to the old address; then every session,
 * passkey and token ends. Review accounts are re-onboarded instead, never moved.
 */
async function changeEmail(s: Store, publicUrl: string, request: Request, id: string): Promise<Response> {
	const st = staffFor(s, request, 'people.email');
	if (st instanceof Response) return st;
	const body = await decode(request, 2 << 10, { email: 'string', checkout_session: 'string', amount_cents: 'int', date: 'string' });
	if (body instanceof Response) return body;
	const target = getAccount(s.db, id);
	if (!target) return jsonError(404, 'not_found', 'No account has this ID.');
	if (!can(st.actor, 'people.email', { id: target.id, role: target.role })) {
		return jsonError(403, 'forbidden', 'Only member accounts move to a new address. Re-onboard a reviewer with a new account and an invite.');
	}
	const email = normalizeEmail(body.email);
	if (!email || accountByEmail(s.db, email)) return jsonError(400, 'invalid_email', 'Enter an address no Colander account uses yet.');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return jsonError(400, 'invalid_date', 'date must be the charge date as YYYY-MM-DD in UTC.');
	let matches: boolean;
	try {
		matches = await s.billing.checkoutMatches(target.id, trimSpace(body.checkout_session), body.amount_cents, body.date);
	} catch (err) {
		if (err instanceof UnavailableError) return jsonError(503, 'billing_unavailable', 'Stripe is not configured, so the receipt cannot be checked.');
		if (err instanceof StripeError) return jsonError(502, 'payment_provider_error', 'Stripe did not answer. Try again in a moment.');
		throw err;
	}
	if (!matches) return jsonError(400, 'receipt_mismatch', 'The Checkout Session, amount and date do not match a checkout of this account.');
	const now = unix(s.now());
	const cancel = newToken();
	const due = now + TTL.emailChange;
	s.db.tx(() => {
		holdRequest(s.db, { accountId: target.id, kind: 'email_change', arg: email, actorId: st.account.id, cancelHash: cancel.hash, dueAt: due }, now);
		audit(s.db, { ...st.who, action: 'email_change_held', target: target.id, before: emailRef(target.email), after: emailRef(email) }, now);
	});
	s.jobs.schedule('requests', due * 1000);
	await sendQuietly(s, target.email, emailChangeHeld(email, 7, `${publicUrl}/account/cancel#${cancel.raw}`));
	return json(200, { due_at: rfc3339(due) });
}

/** POST /v1/admin/donations/{id}/credit {"credit_name"}: replaces or clears ("") a donor's supporter credit, by Checkout Session ID. */
async function credit(s: Store, request: Request, id: string): Promise<Response> {
	const st = staffFor(s, request, 'supporters.credit');
	if (st instanceof Response) return st;
	const body = await decode(request, 1 << 10, { credit_name: 'string' });
	if (body instanceof Response) return body;
	const name = trimSpace(body.credit_name);
	if ([...name].length > 80 || /\p{Cc}/u.test(name)) return jsonError(400, 'invalid_credit_name', 'The name must be one line of at most 80 characters.');
	const now = unix(s.now());
	const before = s.db.get<{ credit_name: string | null }>('SELECT credit_name FROM donations WHERE id = ?', id);
	if (!before) return jsonError(404, 'not_found', 'No donation has this Checkout Session ID.');
	s.db.tx(() => {
		s.db.run('UPDATE donations SET credit_name = ? WHERE id = ?', name || null, id);
		audit(s.db, { ...st.who, action: 'credit_changed', target: id, before: before.credit_name ?? '', after: name }, now);
	});
	return json(200, { donation: { id, credit_name: name || null } });
}

/** GET /v1/admin/audit?target=&before=: the newest 100 audit rows, optionally for one target. Reading it is audited too. */
function auditLog(s: Store, request: Request, url: URL): Response {
	const st = staffFor(s, request, 'audit.read');
	if (st instanceof Response) return st;
	const target = url.searchParams.get('target') ?? '';
	const before = parseInt64(url.searchParams.get('before') ?? '') ?? Number.MAX_SAFE_INTEGER;
	const rows = s.db.all<Record<string, string | number | null>>(
		`SELECT id, at, actor_id, actor_sub, actor_email, host, action, target, before, after, reason, request_id FROM audit_log
		WHERE id < ? AND (? = '' OR target = ?) ORDER BY id DESC LIMIT 100`,
		before,
		target,
		target
	);
	audit(s.db, { ...st.who, action: 'audit_read', target: target || undefined }, unix(s.now()));
	const entries = rows.map((r) => ({ ...r, at: rfc3339(r.at as number) }));
	return json(200, { entries, next_cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null });
}
