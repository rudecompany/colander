// Creator appeals (contract 6.5; Go's internal/api/appeals.go): filing, status by secret, and the
// creator's verification, which checks a YouTube channel description through the Data API when a
// key is configured and otherwise hands the appeal to staff.
import type { Appeal as WireAppeal, AppealStatus } from '@colander/shared/api';
import type { Platform } from '@colander/shared/verdicts';
import { utf8 } from '@colander/shared/bytes';
import { json, jsonError, tooMany } from '../http';
import { allow } from '../limits';
import { verifyAppeal as engineVerifyAppeal } from '../scoring/actions';
import { unix } from '../scoring/engine';
import {
	AppealAwaiting,
	AppealPendingManual,
	AppealUnderReview,
	createAppeal,
	getAppeal as storeGetAppeal,
	transitionAppeal,
	type Appeal
} from '../store/appeals';
import { ConflictError } from '../store/db';
import { getSource } from '../store/sources';
import { hashToken, newToken, normalizeEmail } from './auth';
import { validPlatform } from './ids';
import { findSource } from './public';
import { clientIP, decode, optString, optTime, pathValue, rfc3339, runeCount, trimSpace } from './respond';
import type { Api, Params } from './server';

/** An appeal on the wire. */
export function toAppeal(a: Appeal): WireAppeal {
	return {
		id: a.id,
		platform: a.platform as Platform,
		source_id: a.sourceId,
		source_name: optString(a.sourceName),
		code: a.code,
		status: a.status as AppealStatus,
		statement: a.statement,
		outcome: optString<'upheld' | 'denied'>(a.outcome),
		reasoning: optString(a.reasoning),
		created_at: rfc3339(a.createdAt),
		verified_at: optTime(a.verifiedAt),
		resolved_at: optTime(a.resolvedAt)
	};
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** "colander-" plus 8 characters that are hard to misread. */
export function appealCode(): string {
	return 'colander-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/**
 * POST /v1/appeals: files an appeal against a rated source, 5 per IP per day. The secret comes
 * back once; it lets the creator check the status and verify.
 */
export async function postAppeal(api: Api, request: Request): Promise<Response> {
	const body = await decode(request, 16 << 10, { platform: 'string', source_id: 'string', email: 'string', statement: 'string' } as const);
	if (body instanceof Response) return body;
	const statement = trimSpace(body.statement);
	const email = normalizeEmail(body.email);
	if (!validPlatform(body.platform)) return jsonError(400, 'invalid_platform', 'platform must be yt, tt, ig or fb.');
	if (email === undefined) return jsonError(400, 'invalid_email', 'Enter a valid email address.');
	const n = runeCount(statement);
	if (n < 1 || n > 2000) return jsonError(400, 'invalid_statement', 'Your statement must be 1 to 2,000 characters.');
	const { db, jobs } = api.store;
	const now = api.store.now();
	const secret = newToken();
	// The quota is spent on unknown and unrated sources too, as in Go; a failed write gives it back.
	const res = db.tx((): Response | Appeal => {
		const wait = allow(db, now, clientIP(request), 1, 'appeals');
		if (wait > 0) return tooMany(wait / 1000);
		const ref = findSource(api, body.platform, body.source_id);
		if (ref instanceof Response) return ref;
		const src = getSource(db, ref)!;
		if (src.state.verdict === '') return jsonError(404, 'not_rated', 'This source has no verdict to appeal.');
		const a = createAppeal(db, {
			platform: src.platform,
			sourceRef: ref,
			email,
			statement,
			code: appealCode(),
			secretHash: secret.hash,
			createdAt: unix(now)
		});
		jobs.touch([ref], now);
		return a;
	});
	if (res instanceof Response) return res;
	return json(201, { appeal: toAppeal(res), secret: secret.raw });
}

/** Loads an appeal and checks its secret. A wrong secret looks like a missing appeal. */
function appealWithSecret(api: Api, params: Params, secret: string): Appeal | Response {
	const a = storeGetAppeal(api.store.db, pathValue(params, 'id'));
	if (!a || secret === '' || !sameHash(hashToken(secret), a.secretHash)) {
		return jsonError(404, 'not_found', 'No appeal matches this link.');
	}
	return a;
}

/** Constant-time comparison of two hex hashes. */
function sameHash(a: string, b: string): boolean {
	const [x, y] = [utf8(a), utf8(b)];
	return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/** Answers 200 with the appeal as stored now. */
function respondAppeal(api: Api, id: string): Response {
	const a = storeGetAppeal(api.store.db, id);
	if (!a) throw new Error(`appeal ${id} vanished`);
	return json(200, { appeal: toAppeal(a) });
}

/** GET /v1/appeals/{id}?secret= */
export function getAppeal(api: Api, _request: Request, url: URL, params: Params): Response {
	const a = appealWithSecret(api, params, url.searchParams.get('secret') ?? '');
	if (a instanceof Response) return a;
	return json(200, { appeal: toAppeal(a) });
}

/**
 * POST /v1/appeals/{id}/verify {"secret"}: looks for the code in the YouTube channel description
 * when a key is configured; otherwise, or when the Data API fails, staff check it by hand.
 */
export async function verifyAppeal(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const body = await decode(request, 4 << 10, { secret: 'string' } as const);
	if (body instanceof Response) return body;
	const a = appealWithSecret(api, params, body.secret);
	if (a instanceof Response) return a;
	switch (a.status) {
		case AppealUnderReview:
		case AppealPendingManual:
			return json(200, { appeal: toAppeal(a) });
		case AppealAwaiting:
			break;
		default:
			return jsonError(409, 'appeal_closed', 'This appeal is already closed.');
	}
	const { store } = api;
	const youtube = store.engine.youtube;
	if (a.platform === 'yt' && youtube) {
		// The network call happens outside any transaction.
		let found: boolean | undefined;
		try {
			found = await youtube.descriptionContains(a.sourceId, a.code);
		} catch (err) {
			// The API is unavailable (quota or network): staff check by hand instead.
			console.warn(JSON.stringify({ message: 'youtube appeal check failed, falling back to manual review', error: String(err) }));
		}
		if (found) {
			engineVerifyAppeal(store.engine, a);
			return respondAppeal(api, a.id);
		}
		if (found === false) {
			return jsonError(422, 'code_not_found', `We could not find ${a.code} in the channel description yet. Add it, wait a minute and try again.`);
		}
	}
	store.db.tx(() => {
		try {
			transitionAppeal(store.db, a.id, [AppealAwaiting], AppealPendingManual, {});
		} catch (err) {
			if (!(err instanceof ConflictError)) throw err;
		}
		store.jobs.touch([a.sourceRef], store.now());
	});
	return respondAppeal(api, a.id);
}
