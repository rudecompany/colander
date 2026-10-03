// The Store: one SQLite-backed Durable Object ("primary") that is Colander's system of record
// (hosting plan sections 2 and 4). The edge Worker forwards every /v1 route it does not answer
// itself to fetch() here, with the client IP already reduced to a salted hash.
import { DurableObject } from 'cloudflare:workers';
import { b64decode } from '@colander/shared/bytes';
import { SigningKey } from '@colander/shared/signing';
import { jsonError, notFound, ROUTE_HEADER } from '../http';
import { Db } from './db';
import { listDelta } from './list';
import { migrate } from './migrations';

interface Route {
	method: string;
	pattern: string;
	match: URLPattern;
	handler: (request: Request, url: URL, params: Record<string, string | undefined>) => Response | Promise<Response>;
}

export class Store extends DurableObject<Env> {
	readonly db: Db;
	private key?: Promise<SigningKey>;
	private readonly routes: Route[];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new Db(ctx.storage);
		// Runs before any request or RPC is delivered. A failure resets the object, so no request
		// ever sees a half-migrated schema.
		void ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, Date.now());
		});
		const route = (method: string, pattern: string, handler: Route['handler']): Route => ({
			method,
			pattern,
			match: new URLPattern({ pathname: pattern }),
			handler
		});
		// The port adds the rest of the API here, and dev-only /__dev/* routes, which the edge
		// forwards only when COLANDER_DEV=1.
		this.routes = [route('GET', '/v1/list/delta', (_, url) => this.listDelta(url))];
	}

	/** Liveness for /healthz: the object started, migrated and answers SQL. Returns the schema version. */
	health(): number {
		return this.db.get<{ version: number }>('SELECT max(version) AS version FROM _migrations')!.version;
	}

	/** The internal router. HEAD runs the GET route; the edge drops the body. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method === 'HEAD' ? 'GET' : request.method;
		for (const r of this.routes) {
			const m = r.method === method ? r.match.exec({ pathname: url.pathname }) : null;
			if (!m) continue;
			const name = `${r.method} ${r.pattern}`;
			let res: Response;
			try {
				res = await r.handler(request, url, m.pathname.groups);
			} catch (err) {
				console.error(JSON.stringify({ message: 'internal error', route: name, error: String(err) }));
				res = jsonError(500, 'internal', 'Something went wrong on our side. Please try again.');
			}
			res.headers.set(ROUTE_HEADER, name);
			return res;
		}
		const res = notFound();
		res.headers.set(ROUTE_HEADER, `${request.method} (unmatched)`);
		return res;
	}

	private signingKey = (): Promise<SigningKey> =>
		(this.key ??= SigningKey.fromSeed(b64decode(this.env.COLANDER_SIGNING_KEY)).catch((err) => {
			this.key = undefined;
			throw err;
		}));

	private listDelta(url: URL): Promise<Response> | Response {
		// The edge already checked the form; this guards the Store on its own.
		const since = Number(url.searchParams.get('since'));
		if (!Number.isSafeInteger(since) || since < 0) {
			return jsonError(400, 'invalid_since', 'The since parameter must be a list sequence number.');
		}
		return listDelta(this.db, this.signingKey, since, Math.floor(Date.now() / 1000));
	}
}
