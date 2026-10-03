// The API routes of the extension, the public site, appeals and review (Go's internal/api
// server.go Handler, for these routes), served by the Store. The edge (src/index.ts) has already
// answered preflights, checked `since`, rate-limited misses and hashed the client address; it adds
// CORS, the security headers and `no-store` where no cache policy was set (src/http.ts).
// Unmatched paths under /v1 are 404 not_found from the Store's router.
import type { SigningKey } from '@colander/shared/signing';
import type { Store } from '../store/store';
import { getAppeal, postAppeal, verifyAppeal } from './appeals';
import { getReports, postReport, postTags, postTrial } from './extension';
import { adapterConfig } from './list';
import { getLog, getSource, getStats } from './public';
import {
	reviewDismissReport,
	reviewItemDecision,
	reviewQueue,
	reviewResolveAppeal,
	reviewSource,
	reviewSourceDecision,
	reviewVerifyAppeal
} from './review';
import { getSync, putSync } from './sync';

/** What a handler works with: the Store it runs in and the signing key. */
export interface Api {
	store: Store;
	key: () => Promise<SigningKey>;
}

/** URLPattern groups, still percent-encoded; read them with pathValue. */
export type Params = Record<string, string | undefined>;

export type Handler = (api: Api, request: Request, url: URL, params: Params) => Response | Promise<Response>;

const ROUTES: [method: string, pattern: string, handler: Handler][] = [
	['GET', '/v1/config/adapters', adapterConfig],

	['POST', '/v1/tags', postTags],
	['POST', '/v1/reports', postReport],
	['GET', '/v1/reports', getReports],
	['POST', '/v1/trial', postTrial],
	['GET', '/v1/sync', getSync],
	['PUT', '/v1/sync', putSync],

	['GET', '/v1/sources/:platform/:source_id', getSource],
	['GET', '/v1/log', getLog],
	['GET', '/v1/stats', getStats],

	['POST', '/v1/appeals', postAppeal],
	['GET', '/v1/appeals/:id', getAppeal],
	['POST', '/v1/appeals/:id/verify', verifyAppeal],

	['GET', '/v1/review/queue', reviewQueue],
	['GET', '/v1/review/sources/:platform/:source_id', reviewSource],
	['POST', '/v1/review/sources/:platform/:source_id/decision', reviewSourceDecision],
	['POST', '/v1/review/items/:platform/:item_id/decision', reviewItemDecision],
	['POST', '/v1/review/reports/:id/dismiss', reviewDismissReport],
	['POST', '/v1/review/appeals/:id/verify', reviewVerifyAppeal],
	['POST', '/v1/review/appeals/:id/resolve', reviewResolveAppeal]
];

/** These routes bound to one Store, for its router. */
export function routes(api: Api): [string, string, (request: Request, url: URL, params: Params) => Response | Promise<Response>][] {
	return ROUTES.map(([method, pattern, handler]) => [method, pattern, (request, url, params) => handler(api, request, url, params)]);
}
