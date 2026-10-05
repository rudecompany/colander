// Pairing codes (contracts 7): the one handoff from the website to the extension in every browser.
// A signed-in account asks for a short code, the person types it into their extension, and the
// extension's claim gets a plan token or a reviewer token. Codes last 10 minutes, work once and are
// stored only as SHA-256; claims are limited per IP, because the code is all a claim carries.
import { normalizePairCode, PAIR_BROWSERS, type PairBrowser, type PlanTokenPayload } from '@colander/shared/api';
import { issuePlanToken } from '@colander/shared/signing';
import { hashToken, session } from '../auth';
import { NoPlanError } from '../billing';
import { IP_HASH_HEADER, json, jsonError, tooMany } from '../http';
import { allow } from '../limits';
import { unix } from '../scoring/engine';
import { getAccount } from '../store/accounts';
import { claimPairing, createPairing, getPairing } from '../store/pairings';
import type { Store } from '../store/store';
import { mayReview, type RouteSpec } from './account';
import { decode, rfc3339 } from './respond';

/** 10 minutes (contracts 7). */
export const PAIR_TTL = 10 * 60;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function pairRoutes(s: Store): RouteSpec[] {
	return [
		['POST', '/v1/pair', (r) => createCode(s, r)],
		['POST', '/v1/pair/claim', (r) => claim(s, r)],
		['GET', '/v1/pair/:id', (r) => status(s, r)]
	];
}

/** 8 random Crockford base32 characters (40 bits). */
function newCode(): string {
	const b = crypto.getRandomValues(new Uint8Array(5));
	let n = 0n;
	for (const x of b) n = (n << 8n) | BigInt(x);
	let out = '';
	for (let i = 0; i < 8; i++, n >>= 5n) out = ALPHABET[Number(n & 31n)] + out;
	return out;
}

const codeHash = (code: string) => hashToken(`colander-pair:${code}`);
const noPlan = () => jsonError(404, 'no_plan', 'There is no active Plus plan on this account to connect.');

async function createCode(s: Store, request: Request): Promise<Response> {
	const a = session(s.auth, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 1 << 10, { kind: 'string' });
	if (body instanceof Response) return body;
	if (body.kind !== 'plan' && body.kind !== 'reviewer') return jsonError(400, 'invalid_kind', 'kind must be plan or reviewer.');
	const now = unix(s.now());
	if (body.kind === 'reviewer' && !mayReview(a)) return jsonError(403, 'forbidden', 'Only curators and staff can connect the review side panel.');
	if (body.kind === 'plan') {
		try {
			s.billing.planClaims(a.id, now);
		} catch (err) {
			if (err instanceof NoPlanError) return noPlan();
			throw err;
		}
	}
	const wait = allow(s.db, s.now(), a.id, 1, 'pair_create');
	if (wait > 0) return tooMany(wait / 1000);
	const code = newCode();
	const id = createPairing(s.db, a.id, body.kind, codeHash(code), now, now + PAIR_TTL);
	return json(201, { id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: rfc3339(now + PAIR_TTL) });
}

function status(s: Store, request: Request): Response {
	const a = session(s.auth, request);
	if (a instanceof Response) return a;
	const id = new URL(request.url).pathname.slice('/v1/pair/'.length);
	const p = getPairing(s.db, a.id, id);
	if (!p) return jsonError(404, 'not_found', 'There is no such code on this account.');
	const state = p.claimedAt ? 'claimed' : p.expiresAt > unix(s.now()) ? 'pending' : 'expired';
	return json(200, { status: state, ext_version: p.extVersion || null, browser: p.browser || null });
}

async function claim(s: Store, request: Request): Promise<Response> {
	const body = await decode(request, 1 << 10, { code: 'string', ext_version: 'string', browser: 'string' });
	if (body instanceof Response) return body;
	if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(body.ext_version) || !(PAIR_BROWSERS as readonly string[]).includes(body.browser)) {
		return jsonError(400, 'invalid_field', 'ext_version must be the extension version and browser one of the known browsers.');
	}
	const wait = allow(s.db, s.now(), request.headers.get(IP_HASH_HEADER) ?? '', 1, 'pair_claim_ip');
	if (wait > 0) return tooMany(wait / 1000);
	const code = normalizePairCode(body.code);
	const invalid = () => jsonError(404, 'invalid_code', 'This code is not valid. It may have expired or been used already. Make a new one on the website.');
	if (!code) return invalid();
	const now = unix(s.now());
	// Using the code and minting what it hands over commit together; a refusal rolls the use back,
	// so the website never shows a code as connected when the extension got nothing.
	let got: { reviewer: string } | { claims: PlanTokenPayload };
	try {
		got = s.db.tx(() => {
			const p = claimPairing(s.db, codeHash(code), body.ext_version, body.browser as PairBrowser, now);
			if (!p) throw new Refused(invalid());
			if (p.kind === 'reviewer') {
				const account = getAccount(s.db, p.accountId);
				if (!account || !mayReview(account)) throw new Refused(jsonError(403, 'forbidden', 'This account can no longer review.'));
				return { reviewer: s.auth.issueReviewerToken(p.accountId) };
			}
			try {
				return { claims: s.billing.planClaims(p.accountId, now) };
			} catch (err) {
				throw err instanceof NoPlanError ? new Refused(noPlan()) : err;
			}
		});
	} catch (err) {
		if (err instanceof Refused) return err.response;
		throw err;
	}
	if ('reviewer' in got) return json(200, { kind: 'reviewer', token: got.reviewer });
	return json(200, { kind: 'plan', token: await issuePlanToken(await s.signingKey(), got.claims) });
}

/** A claim that is answered with an error and leaves the code as it was. */
class Refused extends Error {
	constructor(readonly response: Response) {
		super('refused');
	}
}
