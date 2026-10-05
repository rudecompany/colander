// Sessions, sign-in flows, reviewer tokens, install IDs and the CSRF rule (docs/contracts.md 6.1
// and 6.6). Every secret is stored only as a SHA-256 hash. Everything here is synchronous, so it
// runs inside the caller's transaction.
import { b64url, hex, utf8 } from '@colander/shared/bytes';
import { lowerSimple } from '@colander/shared/ids';
import { sha256 } from '@colander/shared/sha256';
import { HOST_HEADER, jsonError } from './http';
import { trimSpace } from './routes/respond';
import {
	createSession,
	deleteSession,
	getSession,
	passkeyCount,
	reviewerToken,
	setReviewerToken,
	touchReviewerToken,
	touchSession,
	type Account,
	type Session
} from './store/accounts';
import type { Db } from './store/db';
import type { Host } from './permissions';

/** A random URL-safe token and its hash. */
export function newToken(prefix = ''): { raw: string; hash: string } {
	const raw = prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));
	return { raw, hash: hashToken(raw) };
}

/** The stored form of a token. */
export const hashToken = (raw: string): string => hex(sha256(utf8(raw)));

/** Reviewer tokens start with this, so they are easy to spot in a leak scan. */
export const REVIEWER_PREFIX = 'colander_rt_';

/**
 * A 6-digit code, uniform over 000000 to 999999: 32-bit draws at or above the largest multiple
 * of a million are thrown away (rejection sampling), so no code is likelier than another.
 */
export function newCode(): string {
	const limit = Math.floor(2 ** 32 / 1e6) * 1e6;
	const buf = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buf);
		if (buf[0]! < limit) return String(buf[0]! % 1e6).padStart(6, '0');
	}
}

/**
 * Validates an install ID (16 bytes as unpadded base64url) and returns
 * hex(SHA-256("colander-install:" + id)), or undefined for a malformed ID (Go's ErrBadInstall).
 */
export function hashInstall(id: string): string | undefined {
	// Go's non-strict RawURLEncoding decodes any 22 characters of the alphabet to 16 bytes.
	if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return undefined;
	return hex(sha256(utf8('colander-install:' + id)));
}

// RFC 5322 atext as Go's net/mail reads it: printable ASCII except the specials, plus any non-ASCII.
const ATOM = String.raw`[!#$%&'*+\-/0-9=?A-Z^_\x60a-z{|}~\u{80}-\u{10FFFF}]+`;
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
// A domain literal must hold an IPv4 address: after lowercasing, Go never sees the "IPv6:" prefix.
const EMAIL = new RegExp(`^${DOT_ATOM}@(?:${DOT_ATOM}|\\[${OCTET}(?:\\.${OCTET}){3}\\])$`, 'u');

/**
 * Lowercases and validates a bare email address, or returns undefined. Go accepted what
 * mail.ParseAddress parses back to the same string with no name: a dot-atom local part and a
 * dot-atom domain or IPv4 literal, at most 254 bytes. Account emails, Access emails and ops
 * arguments all go through this, so they compare equal.
 */
export function normalizeEmail(s: string): string | undefined {
	s = lowerSimple(trimSpace(s));
	if (utf8(s).length > 254 || !EMAIL.test(s)) return undefined;
	return s;
}

/** Keeps a post-sign-in redirect on this site: a path, never another origin. */
export function safeNext(next: string): string {
	if (
		next === '' ||
		!next.startsWith('/') ||
		next.startsWith('//') ||
		next.startsWith('/\\') ||
		/[\r\n]/.test(next) ||
		utf8(next).length > 512
	) {
		return '/account';
	}
	return next;
}

/** A cookie's value as Go's Request.Cookie reads it, or "" when there is none. */
export function readCookie(request: Request, name: string): string {
	for (let part of (request.headers.get('Cookie') ?? '').split(';')) {
		part = part.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
		const eq = part.indexOf('=');
		if ((eq < 0 ? part : part.slice(0, eq)) !== name) continue;
		let v = eq < 0 ? '' : part.slice(eq + 1);
		if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		// Go skips a cookie whose value has bytes a cookie value may not hold.
		if (/^[\x20\x21\x23-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(v)) return v;
	}
	return '';
}

/** Where a request arrived, as the edge marked it. Without the mark it counts as the main host. */
export const hostOf = (request: Request): Host => (request.headers.get(HOST_HEADER) === 'admin' ? 'admin' : 'main');

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The times of contracts 6.6, in seconds. */
export const TTL = {
	session: 30 * DAY,
	code: 10 * MINUTE,
	challenge: 5 * MINUTE,
	invite: DAY,
	reviewerToken: 7 * DAY,
	/** export, deletion, passkey changes and reviewer tokens need a sign-in this recent */
	recentAuth: 10 * MINUTE,
	/** review on the main host needs a passkey sign-in this recent */
	curatorFresh: 12 * HOUR,
	/** what an account with a passkey asks for with only a code waits this long */
	held: 72 * HOUR,
	/** an email change by support waits this long */
	emailChange: 7 * DAY
} as const;

/** The cookie names: __Host- outside dev, so no other host can plant them; plain on http://localhost. */
export function cookieNames(dev: boolean): { session: string; flow: string } {
	return dev ? { session: 'colander_session', flow: 'colander_flow' } : { session: '__Host-colander_session', flow: '__Host-colander_flow' };
}

/** The cookie name from before code sign-in, still read for sessions from then (contracts 6.6). */
export const LEGACY_COOKIE = 'colander_session';

/** Issues and checks sessions, flows and reviewer tokens. Times are unix seconds. */
export class Auth {
	readonly names: { session: string; flow: string };

	constructor(
		private readonly db: Db,
		/** The clock in unix milliseconds. */
		private readonly now: () => number,
		/** Cookies without Secure and without the __Host- prefix, for http://localhost. */
		readonly dev: boolean
	) {
		this.names = cookieNames(dev);
	}

	unix(): number {
		return Math.floor(this.now() / 1000);
	}

	/** A Set-Cookie value; an empty value clears the cookie. */
	cookie(name: string, value: string, maxAge: number): string {
		const life = value === '' ? 'Max-Age=0' : `Max-Age=${maxAge}`;
		return `${name}=${value}; Path=/; ${life}; HttpOnly${this.dev ? '' : '; Secure'}; SameSite=Strict`;
	}

	/**
	 * Starts a session for the account and returns its Set-Cookie value and the session. A request
	 * that already had a session gets a new token: the old one ends (rotation on every sign-in and
	 * step-up).
	 */
	startSession(request: Request, accountId: string, method: 'email' | 'passkey', passkeyId = ''): { cookie: string; session: Session } {
		const previous = readCookie(request, this.names.session);
		if (previous) deleteSession(this.db, hashToken(previous));
		const { raw, hash } = newToken();
		const now = this.unix();
		createSession(this.db, { tokenHash: hash, accountId, method, passkeyId, now, expires: now + TTL.session });
		return { cookie: this.cookie(this.names.session, raw, TTL.session), session: getSession(this.db, hash, now)! };
	}

	/** Deletes the request's session and returns the Set-Cookie value that clears the cookie. */
	signOut(request: Request): string {
		const value = readCookie(request, this.names.session);
		if (value !== '') deleteSession(this.db, hashToken(value));
		return this.cookie(this.names.session, '', 0);
	}

	/** The request's session, or undefined. The admin host never uses the product cookie. */
	session(request: Request): Session | undefined {
		if (hostOf(request) === 'admin') return undefined;
		const value = readCookie(request, this.names.session);
		if (value === '') return undefined;
		const s = getSession(this.db, hashToken(value), this.unix());
		if (s) touchSession(this.db, s, this.unix());
		return s;
	}

	/**
	 * The legacy cookie of a session from before code sign-in, read only outside dev, only when no
	 * __Host- cookie came with the request, and only for a session created before the migration
	 * (the old name has no __Host- prefix, so any subdomain could have set it). Returns the
	 * Set-Cookie values that move it to the new name with the same token, or undefined.
	 */
	legacyMove(request: Request): { token: string; cookies: string[] } | undefined {
		if (this.dev || readCookie(request, this.names.session) !== '') return undefined;
		const value = readCookie(request, LEGACY_COOKIE);
		if (value === '') return undefined;
		const s = getSession(this.db, hashToken(value), this.unix());
		if (!s?.legacy) return undefined;
		return {
			token: value,
			cookies: [this.cookie(this.names.session, value, s.expiresAt - this.unix()), `${LEGACY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`]
		};
	}

	/** Replaces the account's reviewer token and returns the new raw token and its expiry. */
	issueReviewerToken(accountId: string): { token: string; expiresAt: number } {
		const { raw, hash } = newToken(REVIEWER_PREFIX);
		const now = this.unix();
		setReviewerToken(this.db, accountId, hash, now, now + TTL.reviewerToken);
		return { token: raw, expiresAt: now + TTL.reviewerToken };
	}

	/** The account behind a raw reviewer token, 'expired', or undefined. */
	reviewerAccount(token: string): Account | 'expired' | undefined {
		const hash = hashToken(token);
		const t = reviewerToken(this.db, hash);
		if (!t) return undefined;
		const now = this.unix();
		if (t.expiresAt <= now) return 'expired';
		touchReviewerToken(this.db, hash, t, now);
		return t.account;
	}

	/** Whether the session signed in within the last 10 minutes. */
	recent(s: Session): boolean {
		return this.unix() - s.authenticatedAt <= TTL.recentAuth;
	}

	/** Whether the session signed in with a passkey that still exists. */
	passkey(s: Session): boolean {
		return s.passkeyId !== '';
	}

	/**
	 * The step-up rule for export, deletion, removing a passkey, adding one to an account that
	 * already holds one, and reviewer tokens: a sign-in within 10 minutes, and with a passkey
	 * whenever the account holds one. Null when the session passes, else the 403 to answer.
	 */
	stepUp(s: Session, opts: { passkey?: boolean } = {}): Response | null {
		const needsPasskey = opts.passkey ?? passkeyCount(this.db, s.account.id) > 0;
		if (needsPasskey && !this.passkey(s)) {
			return jsonError(403, 'passkey_required', 'Confirm it is you with a passkey to do this.');
		}
		if (!this.recent(s)) return jsonError(403, 'recent_auth_required', 'Confirm it is you to do this. For your safety we ask again after 10 minutes.');
		return null;
	}
}

/**
 * Whether a cookie- or Access-authenticated request may proceed: reads always; writes only with
 * the X-Colander-CSRF: 1 header, which cross-site forms cannot send and CORS never allows, and
 * with Sec-Fetch-Site: same-origin, because getcolander.com, staging and the admin host are one
 * site to the browser and SameSite=Strict does not separate them.
 */
export function csrfOk(request: Request): boolean {
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
	return request.headers.get('X-Colander-CSRF') === '1' && request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

export const csrfRequired = (): Response =>
	jsonError(403, 'csrf_required', 'Send this request from the Colander website: it needs the X-Colander-CSRF: 1 header and a same-origin fetch.');

/** The signed-in session, or the error response. Writes need the CSRF rule as well as the cookie. */
export function signedIn(auth: Auth, request: Request): Session | Response {
	if (!csrfOk(request)) return csrfRequired();
	return auth.session(request) ?? jsonError(401, 'signed_out', 'Sign in to continue.');
}

/** The signed-in account, or the error response (Go's Server.session). */
export function session(auth: Auth, request: Request): Account | Response {
	const s = signedIn(auth, request);
	return s instanceof Response ? s : s.account;
}
