// The parts of Go's internal/auth, and the session check of account.go, that the extension, appeal
// and review routes use: hashed secrets, install IDs, email addresses, the CSRF header and the
// session cookie. Every secret is stored only as a SHA-256 hash.
import { b64url, hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { lowerSimple } from '@colander/shared/ids';
import { jsonError } from '../http';
import { reviewerAccount as storeReviewerAccount, sessionAccount as storeSessionAccount, type Account } from '../store/accounts';
import type { Db } from '../store/db';
import { trimSpace } from './respond';

/** The session cookie. */
export const CookieName = 'colander_session';

/** The stored form of a token. */
export const hashToken = (raw: string): string => hex(sha256(utf8(raw)));

/** A random URL-safe token and its hash. */
export function newToken(): { raw: string; hash: string } {
	const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
	return { raw, hash: hashToken(raw) };
}

/**
 * hex(SHA-256("colander-install:" + id)) for an install ID of 16 bytes as unpadded base64url
 * (contract 2.4), undefined for anything else. Any 22 characters of the alphabet are 16 bytes.
 */
export function hashInstall(id: string): string | undefined {
	return /^[A-Za-z0-9_-]{22}$/.test(id) ? hex(sha256(utf8('colander-install:' + id))) : undefined;
}

// Go's net/mail addr-spec, as NormalizeEmail accepts it: a dot-atom, "@", then a dot-atom or an
// IPv4 domain literal. Quoted local parts, display names and comments never equal the address
// Go parses out of them, so they are refused. Atoms take any non-ASCII rune (RFC 6532).
// ponytail: Go also takes an IPv4-mapped IPv6 literal ("[::ffff:1.2.3.4]"); nobody signs in or
// appeals from one, so it is refused here.
const ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\u0080-\\u{10FFFF}]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const EMAIL = new RegExp(`^${DOT_ATOM}@(?:${DOT_ATOM}|\\[${OCTET}(?:\\.${OCTET}){3}\\])$`, 'u');

/** Lowercases and validates a bare email address (Go's auth.NormalizeEmail). */
export function normalizeEmail(s: string): string | undefined {
	s = lowerSimple(trimSpace(s));
	if (utf8(s).length > 254 || !EMAIL.test(s)) return undefined;
	return s;
}

/**
 * Whether a cookie-authenticated request may proceed: reads always, writes only with the
 * X-Colander-CSRF: 1 header, which cross-site forms cannot send (Go's auth.CSRFOK).
 */
export function csrfOK(request: Request): boolean {
	const m = request.method;
	return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || request.headers.get('X-Colander-CSRF') === '1';
}

/** The session cookie's value as Go's Request.Cookie reads it, or "" when there is none. */
function sessionCookie(request: Request): string {
	for (let part of (request.headers.get('Cookie') ?? '').split(';')) {
		part = part.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
		const eq = part.indexOf('=');
		if ((eq < 0 ? part : part.slice(0, eq)) !== CookieName) continue;
		let v = eq < 0 ? '' : part.slice(eq + 1);
		if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		// Go skips a cookie whose value has bytes a cookie value may not hold.
		if (/^[\x20\x21\x23-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(v)) return v;
	}
	return '';
}

/** The signed-in account behind the session cookie (Go's Auth.SessionAccount). now is unix seconds. */
export function sessionAccount(db: Db, request: Request, now: number): Account | undefined {
	const v = sessionCookie(request);
	return v === '' ? undefined : storeSessionAccount(db, hashToken(v), now);
}

/** The account behind a raw reviewer token (Go's Auth.ReviewerAccount). */
export const reviewerAccount = (db: Db, token: string): Account | undefined => storeReviewerAccount(db, hashToken(token));

/**
 * The signed-in account, or the error response. Writes need the CSRF header as well as the
 * cookie (Go's session in account.go).
 */
export function session(db: Db, request: Request, now: number): Account | Response {
	if (!csrfOK(request)) return jsonError(403, 'csrf_required', 'Send the X-Colander-CSRF: 1 header with this request.');
	return sessionAccount(db, request, now) ?? jsonError(401, 'signed_out', 'Sign in to continue.');
}
