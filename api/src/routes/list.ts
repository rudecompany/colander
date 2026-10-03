// Go's internal/api/list.go: the adapter configuration and the active install estimate. The list
// snapshot and delta are served by the edge (src/index.ts) and the Store's publisher, and list
// requests are counted from edge analytics by the hourly cron (src/scheduled.ts), so cache hits
// count too (contracts 9.6).
import { jsonError, setCache } from '../http';
import { unix } from '../scoring/engine';
import type { Db } from '../store/db';
import { listRequestsSince } from '../store/list';
import { latestAdapterConfig } from '../store/misc';
import type { Api } from './server';

/** Active installs: list requests in the last 24 hours / 24, rounded. now is unix milliseconds. */
export function activeInstalls(db: Db, now: number): number {
	const hour = Math.floor(unix(now) / 3600);
	return Math.floor((listRequestsSince(db, hour - 23) + 12) / 24);
}

/** GET /v1/config/adapters: the newest signed envelope, or 404 so the extension keeps its bundled one. */
export function adapterConfig(api: Api): Response {
	const envelope = latestAdapterConfig(api.store.db);
	if (envelope === undefined) return jsonError(404, 'no_config', 'There is no remote adapter configuration. Keep the bundled one.');
	return new Response(envelope, { headers: setCache(new Headers({ 'Content-Type': 'application/json' }), 'config') });
}
