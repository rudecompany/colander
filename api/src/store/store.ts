// The Store: one SQLite-backed Durable Object ("primary") that is Colander's system of record
// (hosting plan sections 2 and 4). The edge Worker forwards every /v1 route it does not answer
// itself to fetch() here, with the client IP already reduced to a salted hash. The cron Worker
// calls the RPC methods below; the alarm runs the jobs (src/jobs.ts).
import { DurableObject } from 'cloudflare:workers';
import { b64decode } from '@colander/shared/bytes';
import { SigningKey } from '@colander/shared/signing';
import { jsonError, notFound, ROUTE_HEADER, setCache } from '../http';
import { Jobs, prune, STATUS, type DumpStatus, type PassStatus, type PublishStatus } from '../jobs';
import { Publisher, r2Sequence } from '../list/publisher';
import { Db } from './db';
import { latestSequence, setListRequests, SNAPSHOT_KEY, type Sequence } from './list';
import { migrate } from './migrations';

interface Route {
	method: string;
	pattern: string;
	match: URLPattern;
	handler: (request: Request, url: URL, params: Record<string, string | undefined>) => Response | Promise<Response>;
}

/** What the watchdog cron reads every 5 minutes (src/scheduled.ts decides what to alert on). */
export interface WatchdogStatus {
	/** unix ms */
	now: number;
	/** job kinds with a handler */
	jobs: string[];
	/** a job was over a minute overdue with no alarm before it; the watchdog armed it again */
	alarmLost: boolean;
	overdueMs: number;
	pass: PassStatus | null;
	publish: PublishStatus | null;
	/** the local head, created in unix seconds */
	head: Sequence;
	/** the R2 snapshot's sequence and created time (unix seconds), null when missing */
	r2: { seq: number; created: number } | null;
	dump: DumpStatus | null;
	/** alert keys already mailed and still active */
	alerted: string[];
	/** when the watchdog first ran here (unix ms): job ages count from it until a job reports */
	since: number;
}

/** The one Store instance that holds the data and runs the jobs. */
export function primary(env: Env): DurableObjectStub<Store> {
	return env.STORE.getByName('primary', { locationHint: 'enam' });
}

export class Store extends DurableObject<Env> {
	readonly db: Db;
	readonly jobs: Jobs;
	readonly publisher: Publisher;
	/** The clock in unix milliseconds. Tests replace it. */
	now = (): number => Date.now();
	private key?: Promise<SigningKey>;
	private readonly routes: Route[];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new Db(ctx.storage);
		this.jobs = new Jobs(this.db, ctx.storage, ctx.id.name === 'primary');
		this.publisher = new Publisher(this.db, env.LISTS, this.signingKey);
		this.jobs.definePublish((now) => this.publisher.publish(now));
		this.jobs.define('prune', (_, now) => prune(this.db, now), (now) => now);
		// Runs before any request or RPC is delivered. A failure resets the object, so no request
		// ever sees a half-migrated schema.
		void ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, Date.now());
			// A Store that runs jobs checks its list against R2 on every start: a lagging R2 gets the
			// head again, and an R2 ahead of the head (after a restore) gets a sequence above it
			// (hosting plan section 3). The publish job does both; R2 is only read once it runs.
			if (this.jobs.hasJobs()) {
				this.jobs.schedule('publish', this.now());
				await this.jobs.arm();
			}
		});
		const route = (method: string, pattern: string, handler: Route['handler']): Route => ({
			method,
			pattern,
			match: new URLPattern({ pathname: pattern }),
			handler
		});
		// The port adds the rest of the API here, and dev-only /__dev/* routes, which the edge
		// forwards only when COLANDER_DEV=1.
		this.routes = [
			route('GET', '/v1/list/delta', (_, url) => this.listDelta(url)),
			route('GET', '/v1/list/snapshot', () => this.listSnapshot())
		];
	}

	/** Liveness for /healthz: the object started, migrated and answers SQL. Returns the schema version. */
	health(): number {
		return this.db.get<{ version: number }>('SELECT max(version) AS version FROM _migrations')!.version;
	}

	/** The internal router. HEAD runs the GET route; the edge drops the body. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method === 'HEAD' ? 'GET' : request.method;
		let res: Response | undefined;
		let name = `${request.method} (unmatched)`;
		for (const r of this.routes) {
			const m = r.method === method ? r.match.exec({ pathname: url.pathname }) : null;
			if (!m) continue;
			name = `${r.method} ${r.pattern}`;
			try {
				res = await r.handler(request, url, m.pathname.groups);
			} catch (err) {
				console.error(JSON.stringify({ message: 'internal error', route: name, error: String(err) }));
				res = jsonError(500, 'internal', 'Something went wrong on our side. Please try again.');
			}
			break;
		}
		res ??= notFound();
		// Jobs a handler scheduled get their alarm before the answer leaves. If that fails, the
		// write already happened and the watchdog re-arms within 5 minutes.
		if (this.jobs.dirty) {
			await this.jobs.arm().catch((err: unknown) => console.error(JSON.stringify({ message: 'arming the alarm failed', error: String(err) })));
		}
		res.headers.set(ROUTE_HEADER, name);
		return res;
	}

	/** Runs the due jobs. Each job catches its own failure, so the alarm itself only fails on storage errors. */
	async alarm(): Promise<void> {
		await this.jobs.run(this.now());
	}

	/**
	 * The watchdog cron's RPC: creates missing recurring jobs, re-arms a lost alarm, asks for a
	 * publication when R2 does not hold the head, and reports the status the alerts come from.
	 */
	async watchdog(): Promise<WatchdogStatus> {
		const now = this.now();
		const { alarmLost, overdueMs } = await this.jobs.rearm(now);
		const head = latestSequence(this.db);
		const obj = await this.env.LISTS.head(SNAPSHOT_KEY);
		const r2 = obj ? { seq: r2Sequence(obj), created: Number(obj.customMetadata?.created ?? 0) } : null;
		if (head.seq === 0 || r2?.seq !== head.seq) {
			this.jobs.requestPublish(now);
			await this.jobs.arm();
		}
		const kv = this.ctx.storage.kv;
		const since = kv.get<number>(STATUS.since) ?? now;
		kv.put(STATUS.since, since);
		return {
			now,
			jobs: this.jobs.kinds(),
			alarmLost,
			overdueMs,
			pass: kv.get<PassStatus>(STATUS.pass) ?? null,
			publish: kv.get<PublishStatus>(STATUS.publish) ?? null,
			head,
			r2,
			dump: kv.get<DumpStatus>(STATUS.dump) ?? null,
			alerted: kv.get<string[]>(STATUS.alerts) ?? [],
			since
		};
	}

	/** Remembers which alerts were mailed, so each is sent once while it lasts. */
	recordAlerts(keys: string[]): void {
		this.ctx.storage.kv.put(STATUS.alerts, keys);
	}

	/** The hourly analytics pull: list requests per unix hour, replacing what was there. */
	setListRequests(counts: { hour: number; count: number }[]): void {
		this.db.tx(() => {
			for (const c of counts) setListRequests(this.db, c.hour, c.count);
		});
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
		return this.publisher.delta(since, Math.floor(this.now() / 1000));
	}

	/** Snapshot requests reach the Store only when R2 has no valid snapshot (hosting plan section 2). */
	private async listSnapshot(): Promise<Response> {
		const snap = await this.publisher.currentSnapshot();
		if (!snap) {
			return jsonError(503, 'list_unavailable', 'The list has not been published yet. Try again shortly.', { 'Retry-After': '30' });
		}
		const headers = setCache(new Headers({ 'Content-Type': 'application/octet-stream', 'X-Colander-Sequence': String(snap.seq) }), 'list');
		return new Response(snap.bytes, { headers });
	}
}
