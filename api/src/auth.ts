// Email sign-in links, sessions, reviewer tokens, install IDs and the CSRF header (Go's
// internal/auth). Every secret is stored only as a SHA-256 hash. Everything here is synchronous,
// so it runs inside the caller's transaction.
import { b64url, hex, utf8 } from '@colander/shared/bytes';
import { lowerSimple } from '@colander/shared/ids';
import { sha256 } from '@colander/shared/sha256';
import { jsonError } from './http';
import { trimSpace } from './request';
import { createMagicLink, createSession, deleteSession, reviewerAccount, sessionAccount, setReviewerToken, useMagicLink, type Account } from './store/accounts';
import type { Db } from './store/db';

/** The session cookie. */
export const COOKIE_NAME = 'colander_session';

/** A random URL-safe token and its hash. */
export function newToken(): { raw: string; hash: string } {
	const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
	return { raw, hash: hashToken(raw) };
}

/** The stored form of a token. */
export const hashToken = (raw: string): string => hex(sha256(utf8(raw)));

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
 * dot-atom domain or IPv4 literal, at most 254 bytes.
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

/** The value of the session cookie, or "" (Go's Request.Cookie). */
function sessionCookie(request: Request): string {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name!.trim() !== COOKIE_NAME) continue;
		const value = rest.join('=');
		return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	}
	return '';
}

/** Issues and checks sign-in links, sessions and reviewer tokens. Times are unix seconds. */
export class Auth {
	/** 20-minute links (contract 6.6). */
	linkTTL = 20 * 60;
	/** 30-day sessions (contract 6.6). */
	sessionTTL = 30 * 24 * 3600;

	constructor(
		private readonly db: Db,
		/** The clock in unix milliseconds. */
		private readonly now: () => number,
		/** Cookies without Secure, for http://localhost. */
		readonly dev: boolean
	) {}

	private unix(): number {
		return Math.floor(this.now() / 1000);
	}

	/** Stores a single-use sign-in link for email and returns its raw token. */
	startSignIn(email: string, next: string): string {
		const { raw, hash } = newToken();
		const now = this.unix();
		createMagicLink(this.db, hash, email, safeNext(next), now, now + this.linkTTL);
		return raw;
	}

	/**
	 * Consumes a sign-in link and creates a session in one transaction (hosting plan section 1.2).
	 * Returns the account and the Set-Cookie value, or undefined for a used or expired link.
	 */
	finishSignIn(token: string): { account: Account; cookie: string } | undefined {
		const now = this.unix();
		const { raw, hash } = newToken();
		const expires = now + this.sessionTTL;
		const account = this.db.tx(() => {
			const a = useMagicLink(this.db, hashToken(token), now);
			if (a) createSession(this.db, hash, a.id, now, expires);
			return a;
		});
		return account && { account, cookie: this.cookie(raw, expires) };
	}

	/** The Set-Cookie value; an empty value clears the cookie. Attribute order follows Go's http.Cookie. */
	private cookie(value: string, expires: number): string {
		const life = value === '' ? 'Max-Age=0' : `Expires=${new Date(expires * 1000).toUTCString()}; Max-Age=${expires - this.unix()}`;
		return `${COOKIE_NAME}=${value}; Path=/; ${life}; HttpOnly${this.dev ? '' : '; Secure'}; SameSite=Lax`;
	}

	/** Deletes the request's session and returns the Set-Cookie value that clears the cookie. */
	signOut(request: Request): string {
		const value = sessionCookie(request);
		if (value !== '') deleteSession(this.db, hashToken(value));
		return this.cookie('', 0);
	}

	/** The signed-in account, or undefined when there is none. */
	sessionAccount(request: Request): Account | undefined {
		const value = sessionCookie(request);
		return value === '' ? undefined : sessionAccount(this.db, hashToken(value), this.unix());
	}

	/** Replaces the account's reviewer token and returns the new raw token. */
	issueReviewerToken(accountId: string): string {
		const { raw, hash } = newToken();
		setReviewerToken(this.db, accountId, hash, this.unix());
		return raw;
	}

	/** The account behind a raw reviewer token. */
	reviewerAccount(token: string): Account | undefined {
		return reviewerAccount(this.db, hashToken(token));
	}
}

/**
 * Whether a cookie-authenticated request may proceed: reads always, writes only with the
 * X-Colander-CSRF: 1 header, which cross-site forms cannot send.
 */
export function csrfOk(request: Request): boolean {
	return ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.headers.get('X-Colander-CSRF') === '1';
}

/**
 * The signed-in account, or the error response (Go's Server.session). Writes need the CSRF header
 * as well as the cookie.
 */
export function session(auth: Auth, request: Request): Account | Response {
	if (!csrfOk(request)) return jsonError(403, 'csrf_required', 'Send the X-Colander-CSRF: 1 header with this request.');
	return auth.sessionAccount(request) ?? jsonError(401, 'signed_out', 'Sign in to continue.');
}
