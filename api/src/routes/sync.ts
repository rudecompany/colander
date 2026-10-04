// Plus settings sync (contract 6.8; Go's internal/api/sync.go), authenticated by a plan token. A
// paid token is only as good as the plan behind it, so the subscription is checked as well.
import { importKeys, verifyPlanToken, type SigningKey, type TrustedKey } from '@colander/shared/signing';
import type { PlanTokenPayload } from '@colander/shared/api';
import { utf8 } from '@colander/shared/bytes';
import { jsonError } from '../http';
import { unix } from '../scoring/engine';
import { current, type Subscription } from '../store/billing';
import { getSync as storeGetSync, putSync as storePutSync, type SyncBlob } from '../store/misc';
import { trialPrefix } from './extension';
import { compact, decode, optTime } from './respond';
import type { Api } from './server';

/** How long a plan token outlives the paid period (contracts section 5; Go's billing.Grace). */
const GRACE = 3 * 24 * 3600;

/** When plan tokens for this subscription stop working, 0 when it does not run (Go's Subscription.TokenExpiry). */
function tokenExpiry(s: Subscription): number {
	switch (s.status) {
		case 'active':
		case 'trialing':
			return s.periodEnd + GRACE;
		case 'past_due':
			return s.periodStart + GRACE;
	}
	return 0;
}

const trusted = new WeakMap<SigningKey, Promise<TrustedKey[]>>();

/**
 * Verifies "Authorization: Plan <token>" with the server's own key and, for a paid token, that the
 * account's plan still runs. Returns the claims or the error response.
 */
async function plan(api: Api, request: Request): Promise<PlanTokenPayload | Response> {
	const auth = request.headers.get('Authorization') ?? '';
	if (!auth.startsWith('Plan ')) return jsonError(401, 'plan_required', 'Settings sync needs a Plus plan token.');
	const key = await api.key();
	let keys = trusted.get(key);
	if (!keys) trusted.set(key, (keys = importKeys([key.publicBase64])));
	const c = await verifyPlanToken(auth.slice('Plan '.length), await keys);
	if (!c || !c.sub) return jsonError(401, 'invalid_plan', 'The plan token is not valid.');
	const now = unix(api.store.now());
	if (now >= c.exp) return jsonError(401, 'plan_expired', 'The Plus plan behind this token has ended.');
	// A refund or an ended subscription stops sync at once, not when the token expires. Install
	// trials have no plan and run until they expire.
	if (!c.sub.startsWith(trialPrefix + '_')) {
		const sub = current(api.store.db, c.sub);
		if (!sub || tokenExpiry(sub) <= now) return jsonError(403, 'no_plan', 'The Plus plan behind this token has ended.');
	}
	return c;
}

const SYNC_LIMIT = 64 << 10;

/** The sync body with data as the stored JSON text (Go's json.RawMessage), keys in Go's map order. */
function syncResponse(status: number, b: SyncBlob, error?: { code: string; message: string }): Response {
	const parts = [`"data":${b.data === '' ? 'null' : b.data}`];
	if (error) parts.push(`"error":${JSON.stringify(error)}`);
	parts.push(`"updated_at":${JSON.stringify(optTime(b.updatedAt))}`, `"version":${b.version}`);
	return new Response(`{${parts.join(',')}}\n`, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** GET /v1/sync. */
export async function getSync(api: Api, request: Request): Promise<Response> {
	const c = await plan(api, request);
	if (c instanceof Response) return c;
	return syncResponse(200, storeGetSync(api.store.db, c.sub));
}

/** PUT /v1/sync: a compare-and-set on version; a stale version gets 409 and the current blob. */
export async function putSync(api: Api, request: Request): Promise<Response> {
	const c = await plan(api, request);
	if (c instanceof Response) return c;
	const body = await decode(request, SYNC_LIMIT + 1024, { version: 'int?', data: 'raw' } as const);
	if (body instanceof Response) return body;
	if (body.version === undefined || body.version < 0) {
		return jsonError(400, 'invalid_version', 'version must be the version you last saw (0 when none).');
	}
	if (!body.data.startsWith('{')) return jsonError(400, 'invalid_data', 'data must be a JSON object.');
	if (utf8(body.data).length > SYNC_LIMIT) return jsonError(413, 'too_large', 'Synced settings must be at most 64 KB.');
	const { blob, conflict } = storePutSync(api.store.db, c.sub, body.version, compact(body.data), unix(api.store.now()));
	if (conflict) {
		return syncResponse(409, blob, { code: 'version_conflict', message: 'Settings changed elsewhere. Merge with the current copy and try again.' });
	}
	return syncResponse(200, blob);
}
