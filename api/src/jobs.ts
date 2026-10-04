// The Store's background work (hosting plan sections 2 to 4): one row per job in the `jobs` table
// and one Durable Object alarm set to the earliest due time. It replaces the Go server's
// goroutines: the 5-minute scoring pass (now resumable chunks), the 5-second rescore debounce,
// the 10-second publish floor, the 6-hourly dump and hourly pruning. Only the "primary" Store
// runs jobs, so a restore drill's scratch Store never acts on the rows it loaded.
//
// A job name is its kind, or kind:arg for jobs that exist once per target (rescore:<source ref>).
// A kind runs only once its handler is defined: schedule() ignores kinds without one, and the
// alarm drops rows of unknown kinds (a rollback), so nothing fires without code to run it.
import { pruneLimits } from './limits';
import { Default } from './scoring/rules';
import type { Db } from './store/db';
import { RETENTION_SECONDS } from './store/list';
import { purgeYouTube } from './store/misc';
import { sourceRefsAfter } from './store/sources';
import { pacificDay, RETENTION } from './youtube';

/** One turn of a job: returns when to run it again (unix ms), or null when it is done. */
export type Handler = (arg: string, now: number) => Promise<number | null> | number | null;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The full scoring pass runs every 5 minutes (contracts 9.5; the value lives in the scoring Thresholds)... */
export const PASS_INTERVAL = Default.passInterval;
/** ...in chunks of this many sources per alarm turn, so requests interleave. */
export const PASS_CHUNK = 1_000;
/** Touched sources are rescored this long after the first touch (contracts 9.5; from the scoring Thresholds). */
export const DEBOUNCE = Default.debounce;
/** At most one publication per 10 seconds (contract 3.2). */
export const PUBLISH_FLOOR = 10_000;
export const PRUNE_INTERVAL = HOUR;
/** A job whose instance died mid-run (eviction, deploy) runs again after this. */
const LEASE = MINUTE;
/** A job that threw runs again after this. */
const RETRY = 30_000;

/** Where the watchdog reads job status, in the Store's synchronous KV storage. */
export const STATUS = {
	pass: 'status:pass',
	publish: 'status:publish',
	dump: 'status:dump',
	/** the pass in progress: its cursor row */
	passProgress: 'job:pass',
	/** alert keys already mailed and still active */
	alerts: 'status:alerts',
	/** when the watchdog first ran */
	since: 'status:since',
	/** the dump attempt that has not succeeded yet: { failures, at } */
	dumpTry: 'status:dump_try',
	/** the last whole unix hour the analytics pull counted list requests for */
	listRequests: 'status:list_requests'
} as const;

/** The last completed full scoring pass. */
export interface PassStatus {
	at: number;
	/** from the first chunk to the last, across alarm turns */
	ms: number;
	sources: number;
	changes: number;
	rowsRead: number;
}

/** The last successful publication. */
export interface PublishStatus {
	at: number;
	seq: number;
}

/** The last successful dump. */
export interface DumpStatus {
	at: number;
	/** how long the dump blocked the Store */
	ms: number;
	/** the SQL, uncompressed */
	bytes: number;
	/** the gzip object, which sits in memory while the dump blocks */
	size: number;
}

/** What one dump reports back to the job. */
export type DumpResult = Omit<DumpStatus, 'at'>;

/** A dump that failed is tried again after 2, 4, 8 ... minutes, at most an hour apart. */
export const dumpBackoff = (failures: number): number => Math.min(2 ** failures * MINUTE, HOUR);

interface PassProgress {
	cursor: number;
	startedAt: number;
	sources: number;
	changes: number;
	rowsRead: number;
}

/** What the full scoring pass needs from the scoring engine (Go's Engine.FullPass, split up). */
export interface PassScorer {
	/** The start of a pass: expire appeals and load reputation (the YouTube port adds its refresh here, outside any transaction). */
	startPass(now: number): Promise<void>;
	/** Scores one source and its items; returns how many targets' stored state changed (Go's scoreSource). */
	scoreSource(ref: number, now: number): number;
}

interface Kind {
	handler: Handler;
	/** Recurring kinds: when the first run is due. */
	first?: (now: number) => number;
}

const kindOf = (name: string): string => name.split(':', 1)[0]!;
const argOf = (name: string): string => name.slice(kindOf(name).length + 1);

/** The next dump slot strictly after now: 03:17, 09:17, 15:17 or 21:17 UTC (hosting plan section 3). */
export function nextDump(now: number): number {
	const slot = 6 * HOUR;
	const offset = 3 * HOUR + 17 * MINUTE;
	return Math.floor((now - offset) / slot) * slot + offset + slot;
}

/**
 * The hourly cleanup: expired magic links and sessions (Go pruned them while signing in), list
 * sequences past the delta window (their changes cascade; the head always stays), refilled rate
 * limit buckets, the synced settings of ended install trials, which no token can read again, and
 * YouTube Data API data before it is 30 days old (with quota ledger days older than that).
 * The trial rows stay, so each install still gets one trial.
 */
export function prune(db: Db, now: number): number {
	const s = Math.floor(now / 1000);
	db.tx(() => {
		db.run('DELETE FROM magic_links WHERE expires_at < ?', s);
		db.run('DELETE FROM sessions WHERE expires_at <= ?', s);
		db.run('DELETE FROM sync_blobs WHERE sub IN (SELECT sub FROM trials WHERE expires_at <= ?)', s);
		db.run(
			'DELETE FROM list_sequences WHERE created_at < ? AND seq < (SELECT ifnull(max(seq), 0) FROM list_sequences)',
			s - RETENTION_SECONDS
		);
		pruneLimits(db, now);
		purgeYouTube(db, Math.floor((now - RETENTION) / 1000), pacificDay(now - RETENTION));
	});
	return now + PRUNE_INTERVAL;
}

export class Jobs {
	private readonly defined = new Map<string, Kind>();
	/** When the running or last publication started, for the publish floor. */
	private publishStartedAt = 0;
	/** Set when schedule() wrote a row: the Store arms the alarm before it answers. */
	dirty = false;

	constructor(
		private readonly db: Db,
		private readonly storage: DurableObjectStorage,
		/** Only the primary Store runs jobs. */
		readonly enabled: boolean
	) {}

	/** Registers a job kind. With first, it recurs: ensure() creates it when missing, due at first(now). */
	define(kind: string, handler: Handler, first?: (now: number) => number): void {
		this.defined.set(kind, { handler, first });
	}

	/** The kinds that have a handler. */
	kinds(): string[] {
		return [...this.defined.keys()].sort();
	}

	/** Whether this Store has run jobs before: it then reconciles with R2 on start. */
	hasJobs(): boolean {
		return this.enabled && this.db.get('SELECT 1 FROM jobs LIMIT 1') !== undefined;
	}

	/** Runs name at dueAt, or earlier when it is already due earlier. Kinds without a handler are ignored. */
	schedule(name: string, dueAt: number): void {
		if (!this.enabled || !this.defined.has(kindOf(name))) return;
		this.db.run(
			'INSERT INTO jobs (name, due_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET due_at = min(due_at, excluded.due_at)',
			name,
			dueAt
		);
		this.dirty = true;
	}

	/** Creates every recurring job that is missing. */
	ensure(now: number): void {
		if (!this.enabled) return;
		for (const [kind, { first }] of this.defined) {
			if (first) this.db.run('INSERT INTO jobs (name, due_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', kind, first(now));
		}
		this.dirty = true;
	}

	/** Go's Engine.Touch: rescores the sources 5 seconds after their first touch, together. */
	touch(refs: number[], now: number): void {
		for (const ref of new Set(refs)) this.schedule(`rescore:${ref}`, now + DEBOUNCE);
	}

	/** Go's Publisher.Request: a publication at most once per PUBLISH_FLOOR; requests coalesce. */
	requestPublish(now: number): void {
		const last = Math.max(this.publishStartedAt, this.storage.kv.get<PublishStatus>(STATUS.publish)?.at ?? 0);
		this.schedule('publish', Math.max(now, last + PUBLISH_FLOOR));
	}

	/** Registers publication. publish returns the head sequence, 0 when it refused to publish. */
	definePublish(publish: (now: number) => Promise<{ seq: number }>): void {
		this.define('publish', async (_, now) => {
			this.publishStartedAt = now;
			const { seq } = await publish(now);
			if (seq > 0) this.storage.kv.put<PublishStatus>(STATUS.publish, { at: now, seq });
			return null;
		});
	}

	/**
	 * Registers the full scoring pass: every PASS_INTERVAL, all sources in PASS_CHUNK chunks, one
	 * chunk per alarm turn, with the cursor kept in storage so a restart resumes where it stopped.
	 * ponytail: every pass rescores every source. Ship the incremental planner (dirty, due or
	 * reputation-affected sources plus an hourly full reconcile) when the rows-read alert fires.
	 */
	definePass(scorer: PassScorer): void {
		this.define('pass', (_, now) => this.passTurn(scorer, now), (now) => now);
	}

	private async passTurn(scorer: PassScorer, now: number): Promise<number> {
		const kv = this.storage.kv;
		let p = kv.get<PassProgress>(STATUS.passProgress);
		if (!p) {
			const before = this.db.rowsRead;
			await scorer.startPass(now);
			p = { cursor: 0, startedAt: now, sources: 0, changes: 0, rowsRead: this.db.rowsRead - before };
		}
		const before = this.db.rowsRead;
		const refs = sourceRefsAfter(this.db, p.cursor, PASS_CHUNK);
		for (const ref of refs) p.changes += scorer.scoreSource(ref, now);
		p.rowsRead += this.db.rowsRead - before;
		p.sources += refs.length;
		p.cursor = refs.at(-1) ?? p.cursor;
		if (refs.length === PASS_CHUNK) {
			// More sources wait: let requests in, then continue at the next alarm turn.
			kv.put(STATUS.passProgress, p);
			return now;
		}
		kv.delete(STATUS.passProgress);
		const status: PassStatus = { at: now, ms: now - p.startedAt, sources: p.sources, changes: p.changes, rowsRead: p.rowsRead };
		kv.put(STATUS.pass, status);
		console.log(JSON.stringify({ message: 'scoring pass', ...status }));
		// Always ask: the publisher only writes a sequence when the list really differs.
		this.requestPublish(now);
		return p.startedAt + PASS_INTERVAL;
	}

	/**
	 * Registers the 6-hourly dump. dump runs it; how long it blocked and its sizes are recorded for
	 * the watchdog. Each try blocks the Store, so failures back off (dumpBackoff) instead of the
	 * 30-second retry. A try is counted before it starts, so one the platform cut short (a reset
	 * past the 30-second cap) backs off too, when the lease brings it back.
	 */
	defineDump(dump: (now: number) => Promise<DumpResult>): void {
		this.define(
			'dump',
			async (_, now) => {
				const kv = this.storage.kv;
				const tried = kv.get<{ failures: number; at: number }>(STATUS.dumpTry);
				if (tried && now < tried.at + dumpBackoff(tried.failures)) return tried.at + dumpBackoff(tried.failures);
				const failures = (tried?.failures ?? 0) + 1;
				kv.put(STATUS.dumpTry, { failures, at: now });
				let d: DumpResult;
				try {
					d = await dump(now);
				} catch (err) {
					console.error(JSON.stringify({ message: 'dump failed', failures, error: String(err) }));
					return now + dumpBackoff(failures);
				}
				kv.delete(STATUS.dumpTry);
				kv.put<DumpStatus>(STATUS.dump, { at: now, ...d });
				return nextDump(now);
			},
			nextDump
		);
	}

	private earliest(): number | null {
		return this.db.get<{ due: number | null }>('SELECT min(due_at) AS due FROM jobs')?.due ?? null;
	}

	/** Sets the alarm to the earliest due job, or clears it when there is none. Returns that time. */
	async arm(): Promise<number | null> {
		this.dirty = false;
		if (!this.enabled) return null;
		const next = this.earliest();
		const current = await this.storage.getAlarm();
		if (next === null) {
			if (current !== null) await this.storage.deleteAlarm();
		} else if (current !== next) {
			await this.storage.setAlarm(next);
		}
		return next;
	}

	/**
	 * The watchdog's repair: notes whether the alarm was lost (a job over a minute overdue with no
	 * alarm before it), creates missing recurring jobs and arms the alarm again.
	 */
	async rearm(now: number): Promise<{ alarmLost: boolean; overdueMs: number }> {
		const earliest = this.earliest();
		const alarm = await this.storage.getAlarm();
		const overdueMs = earliest === null ? 0 : Math.max(0, now - earliest);
		const alarmLost = earliest !== null && overdueMs > MINUTE && (alarm === null || alarm > earliest);
		this.ensure(now);
		await this.arm();
		return { alarmLost, overdueMs };
	}

	/** The alarm handler: runs every due job once, then arms the alarm for the next one. */
	async run(now: number): Promise<void> {
		if (!this.enabled) {
			await this.storage.deleteAlarm();
			return;
		}
		for (const { name } of this.db.all<{ name: string }>('SELECT name FROM jobs WHERE due_at <= ? ORDER BY due_at, name', now)) {
			const kind = this.defined.get(kindOf(name));
			if (!kind) {
				this.db.run('DELETE FROM jobs WHERE name = ?', name);
				console.warn(JSON.stringify({ message: 'job dropped: no handler', job: kindOf(name) }));
				continue;
			}
			// The lease: a request that schedules this job while it runs moves due_at off it.
			const lease = now + LEASE;
			this.db.run('UPDATE jobs SET due_at = ? WHERE name = ?', lease, name);
			let next: number | null;
			try {
				next = await kind.handler(argOf(name), now);
			} catch (err) {
				console.error(JSON.stringify({ message: 'job failed', job: kindOf(name), error: String(err) }));
				next = now + RETRY;
			}
			const due = this.db.get<{ due_at: number }>('SELECT due_at FROM jobs WHERE name = ?', name)?.due_at;
			if (due === lease) {
				if (next === null) this.db.run('DELETE FROM jobs WHERE name = ?', name);
				else this.db.run('UPDATE jobs SET due_at = ? WHERE name = ?', next, name);
			} else if (next !== null) {
				this.schedule(name, next);
			}
		}
		await this.arm();
	}
}
