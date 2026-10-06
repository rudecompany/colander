// The Store: one SQLite-backed Durable Object ("primary") that is Colander's system of record
// (hosting plan sections 2 and 4). The edge Worker forwards every /v1 route it does not answer
// itself to fetch() here, with the client IP already reduced to a salted hash. The cron Worker
// calls the RPC methods below; the alarm runs the jobs (src/jobs.ts).
import { DurableObject } from 'cloudflare:workers';
import { b64decode } from '@colander/shared/bytes';
import { SigningKey } from '@colander/shared/signing';
import { Auth } from '../auth';
import { dump, exportAudit, nextAuditExport } from '../backup';
import { runHeldRequests } from '../erase';
import { Billing, billingConfig } from '../billing';
import { devRoutes, testNow } from '../dev';
import { jsonError, notFound, ROUTE_HEADER, setCache } from '../http';
import { Jobs, prune, STATUS, type DumpStatus, type PassStatus, type PublishStatus } from '../jobs';
import { Publisher, r2Sequence } from '../list/publisher';
import { Mailer } from '../mail';
import { storeOps, type OpsArgs, type OpsCaller } from '../ops';
import { accountRoutes } from '../routes/account';
import { adminRoutes } from '../routes/admin';
import { billingRoutes } from '../routes/billing';
import { routes as apiRoutes } from '../routes/server';
import { Engine } from '../scoring/engine';
import { DAILY_UNITS, YouTube } from '../youtube';
import { Db } from './db';
import { addListRequests, latestSequence, setListRequests, SNAPSHOT_KEY, type Sequence } from './list';
import { migrate } from './migrations';

interface Route {
	method: string;
	pattern: string;
	match: URLPattern;
	handler: (request: Request, url: URL, params: Record<string, string | undefined>) => Response | Promise<Response>;
}

/** Sign-in codes sent in a unix hour and in the hour before it. */
export interface SignInMail {
	hour: number;
	count: number;
	previous: number;
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
	/** sign-in codes sent, by hour */
	signInMail: SignInMail | null;
}

/** The one Store instance that holds the data and runs the jobs. */
export function primary(env: Env): DurableObjectStub<Store> {
	return env.STORE.getByName('primary', { locationHint: 'enam' });
}

/**
 * The signing key from its Worker secret. `wrangler secret put COLANDER_SIGNING_KEY < key-file`
 * stores the file's trailing newline too, which base64 decoding refuses, so the secret is trimmed;
 * a bad secret is a rejected promise, never a throw the caller does not expect.
 */
export async function signingKeyFromSecret(secret: string): Promise<SigningKey> {
	return SigningKey.fromSeed(b64decode(secret.trim()));
}

export class Store extends DurableObject<Env> {
	readonly db: Db;
	readonly jobs: Jobs;
	readonly publisher: Publisher;
	readonly engine: Engine;
	readonly auth: Auth;
	/** The backup bucket: dumps, erasure records and the audit log's daily copies. */
	readonly backups: R2Bucket;
	/** Tests replace the mailer and billing, as Go's tests set Server.Mail and Server.Billing. */
	mailer: Mailer;
	billing: Billing;
	/** The clock in unix milliseconds. Tests replace it. */
	now = (): number => Date.now();
	private key?: Promise<SigningKey>;
	/** The internal router's table; the Cache-Control test checks it covers every route. */
	readonly routes: Route[];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new Db(ctx.storage);
		// A test that freezes the clock settles the jobs itself (src/dev.ts).
		const frozen = testNow(env);
		if (frozen !== undefined) this.now = () => frozen;
		this.jobs = new Jobs(this.db, ctx.storage, ctx.id.name === 'primary' && frozen === undefined);
		this.publisher = new Publisher(this.db, env.LISTS, this.signingKey);
		this.jobs.definePublish((now) => this.publisher.publish(now));
		this.jobs.define('prune', (_, now) => prune(this.db, now), (now) => now);
		this.jobs.defineDump((now) => dump(ctx, this.db, env.BACKUPS, now));
		this.backups = env.BACKUPS;
		// Held account requests (deletions, passkey removals, email changes) run hourly once due; the
		// audit log goes to R2 daily.
		this.jobs.define('requests', (_, now) => runHeldRequests(this, now), (now) => now);
		this.jobs.define('audit', (_, now) => exportAudit(this.db, ctx.storage.kv, env.BACKUPS, now), nextAuditExport);
		// Scoring (Go's Engine.Run): the full pass every 5 minutes in chunks, and the debounced rescore
		// of the sources the routes hand to jobs.touch() after reports and appeal changes.
		this.engine = new Engine(this.db, this.jobs, () => this.now());
		this.jobs.definePass(this.engine);
		this.jobs.define('rescore', (ref) => (this.engine.rescore(Number(ref)), null));
		const youtubeKey = (env as Env & { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY;
		const budget = Number(env.YOUTUBE_DAILY_UNITS || DAILY_UNITS);
		if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('YOUTUBE_DAILY_UNITS must be a whole number of units');
		if (youtubeKey) this.engine.youtube = new YouTube(youtubeKey, this.db, () => this.now(), budget);
		this.engine.derived = env.YOUTUBE_DERIVED_USE === '1';
		this.auth = new Auth(this.db, () => this.now(), env.COLANDER_DEV === '1');
		this.mailer = new Mailer(env);
		this.billing = new Billing(this.db, billingConfig(env));
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
		// Every API route of contract section 6, and the dev-only /__dev/* routes, which the edge
		// forwards only when COLANDER_DEV=1.
		this.routes = [
			route('GET', '/v1/list/delta', (_, url) => this.listDelta(url)),
			route('GET', '/v1/list/snapshot', () => this.listSnapshot()),
			...[
				...apiRoutes({ store: this, key: this.signingKey, publicUrl: env.PUBLIC_URL.replace(/\/+$/, '') }),
				...accountRoutes(this, env),
				...adminRoutes(this, env),
				...billingRoutes(this),
				...devRoutes(this, ctx, env)
			].map(([method, pattern, handler]) => route(method, pattern, handler))
		];
	}

	/** Liveness for /healthz: the object started, migrated and answers SQL. Returns the schema version. */
	health(): number {
		return this.db.get<{ version: number }>('SELECT max(version) AS version FROM _migrations')!.version;
	}

	/**
	 * The internal router. HEAD runs the GET route; the edge drops the body. A session from before
	 * code sign-in that still arrives under the old cookie name moves to the new name here, with the
	 * same token, before any route reads it.
	 */
	async fetch(request: Request): Promise<Response> {
		const moved = this.auth.legacyMove(request);
		if (moved) {
			const headers = new Headers(request.headers);
			headers.set('Cookie', `${headers.get('Cookie')}; ${this.auth.names.session}=${moved.token}`);
			request = new Request(request, { headers });
		}
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
		if (moved) for (const c of moved.cookies) res.headers.append('Set-Cookie', c);
		return res;
	}

	/** Counts a sign-in email for the watchdog's send-rate alert, per unix hour. */
	countSignInMail(now: number): void {
		const hour = Math.floor(now / 3_600_000);
		const kv = this.ctx.storage.kv;
		const c = kv.get<SignInMail>(STATUS.signInMail);
		kv.put(STATUS.signInMail, { hour, count: c?.hour === hour ? c.count + 1 : 1, previous: c?.hour === hour ? c.previous : c?.hour === hour - 1 ? c.count : 0 });
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
			since,
			signInMail: kv.get<SignInMail>(STATUS.signInMail) ?? null
		};
	}

	/** Remembers which alerts were mailed, so each is sent once while it lasts. */
	recordAlerts(keys: string[]): void {
		this.ctx.storage.kv.put(STATUS.alerts, keys);
	}

	/** The ops channel's commands that run in the Store (src/ops.ts), with JSON arguments, caller and answer. */
	async ops(command: string, args: string, caller?: string): Promise<{ status: number; json: string }> {
		const a = await storeOps(this, this.ctx, this.env, command, JSON.parse(args) as OpsArgs, caller ? (JSON.parse(caller) as OpsCaller) : undefined);
		return { status: a.status, json: JSON.stringify(a.body) };
	}

	/** Dev mode's stand-in for edge analytics: one list request in the current unix hour (Go's hitCounter). */
	countListRequest(): void {
		addListRequests(this.db, Math.floor(this.now() / 3_600_000), 1);
	}

	/**
	 * The hourly analytics pull: list requests per unix hour, replacing what was there. It covers
	 * whole hours only, so the active install estimate counts up to the last hour it set.
	 */
	setListRequests(counts: { hour: number; count: number }[]): void {
		if (counts.length === 0) return;
		const kv = this.ctx.storage.kv;
		this.db.tx(() => {
			for (const c of counts) setListRequests(this.db, c.hour, c.count);
			kv.put(STATUS.listRequests, Math.max(kv.get<number>(STATUS.listRequests) ?? 0, ...counts.map((c) => c.hour)));
		});
	}

	/** The last whole unix hour the analytics pull counted, or undefined while list requests are counted live (dev mode) or not yet. */
	listRequestsThrough(): number | undefined {
		return this.ctx.storage.kv.get<number>(STATUS.listRequests);
	}

	readonly signingKey = (): Promise<SigningKey> =>
		(this.key ??= signingKeyFromSecret(this.env.COLANDER_SIGNING_KEY).catch((err) => {
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
