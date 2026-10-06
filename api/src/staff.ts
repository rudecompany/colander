// Staff on the admin host (docs/contracts.md 6.9): the Access identity the edge verified, resolved
// to a staff or admin account, with the A3T subject pinned on the first sign-in. The review routes
// and the admin routes both use it; it never touches billing.
import { hashToken, hostOf, normalizeEmail } from './auth';
import { ACCESS_EMAIL_HEADER, ACCESS_SUBJECT_HEADER, jsonError, REQUEST_ID_HEADER } from './http';
import { rank, type Actor, type Role } from './permissions';
import { unix } from './scoring/engine';
import { accountByEmail, audit, pinAccessSubject, type Account, type AuditEntry } from './store/accounts';
import type { Store } from './store/store';

/** A staff member or admin on the admin host, as Access and the Store know them. */
export interface Staff {
	account: Account;
	actor: Actor;
	/** the audit fields of their requests */
	who: Omit<AuditEntry, 'action' | 'target'>;
}

const notStaff = () => jsonError(403, 'not_staff', 'This Access identity is not a Colander staff account.');

/**
 * Resolves the Access identity the edge verified to a staff or admin account. The account is
 * found by the Access email; with A3T Identity the token also carries the A3T subject, which is
 * pinned on the account's first sign-in and must match on every later one. A token without a
 * subject comes from Access One-time PIN, the fallback, which proves control of the mailbox.
 */
export function staffOf(s: Store, request: Request): Staff | Response {
	if (hostOf(request) !== 'admin') return jsonError(404, 'not_found', 'There is no API route for this method and path.');
	const email = normalizeEmail(request.headers.get(ACCESS_EMAIL_HEADER) ?? '');
	const subject = request.headers.get(ACCESS_SUBJECT_HEADER) ?? '';
	if (!email) return jsonError(403, 'access_required', 'Sign in through Cloudflare Access to use the admin console.');
	const account = accountByEmail(s.db, email);
	const now = unix(s.now());
	const who: Staff['who'] = {
		host: 'admin',
		actorId: account?.id,
		actorEmail: email,
		actorSub: subject || `otp:${hashToken(email).slice(0, 16)}`,
		requestId: request.headers.get(REQUEST_ID_HEADER) ?? undefined
	};
	if (!account || rank(account.role) < rank('staff')) {
		audit(s.db, { ...who, action: 'access_refused', reason: 'not staff' }, now);
		return notStaff();
	}
	if (subject) {
		if (account.accessSubject === '') {
			const taken = s.db.get('SELECT 1 FROM accounts WHERE access_subject = ?', subject);
			if (taken) {
				audit(s.db, { ...who, action: 'access_refused', target: account.id, reason: 'subject pinned to another account' }, now);
				return notStaff();
			}
			pinAccessSubject(s.db, account.id, subject);
			audit(s.db, { ...who, action: 'access_pinned', target: account.id, after: subject }, now);
		} else if (account.accessSubject !== subject) {
			audit(s.db, { ...who, action: 'access_refused', target: account.id, reason: 'subject mismatch' }, now);
			return notStaff();
		}
	}
	return { account, actor: { id: account.id, authority: account.role as Role }, who };
}
