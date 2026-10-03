// The published list's tables and the list request counters (Go's store/list.go). The publisher
// (src/list/publisher.ts) turns them into signed snapshots and deltas.
import { hex } from '@colander/shared/bytes';
import type { Db } from './db';
import type { State } from './sources';

/** The R2 key of the signed snapshot, written with `customMetadata.seq`; the edge serves it. */
export const SNAPSHOT_KEY = 'list/snapshot.bin';

/** Deltas are served from sequences published within this window (contract 3.2). */
export const RETENTION_SECONDS = 30 * 24 * 3600;

/** A rated source alias or item, the raw material of a list entry. */
export interface ListTarget {
	platform: string;
	/** source | item */
	targetType: string;
	/** the alias or item ID */
	id: string;
	state: Pick<State, 'verdict' | 'signals' | 'detail' | 'flags' | 'changedAt'>;
	/** for items: their source's verdict */
	sourceVerdict: string;
	/** for items: their source is mixed, so they keep their own entries */
	sourceMixed: boolean;
}

/** Returns one row per alias of every rated source and one per rated item. */
export function listTargets(db: Db): ListTarget[] {
	return db
		.all<{
			platform: string;
			target_type: string;
			id: string;
			verdict: string;
			signals: number;
			detail: number;
			flags: number;
			changed_at: number;
			source_verdict: string;
			source_mixed: number;
		}>(
			`SELECT a.platform, 'source' AS target_type, a.alias AS id, s.verdict, s.signals, s.detail, s.flags,
			ifnull(s.changed_at, 0) AS changed_at, '' AS source_verdict, 0 AS source_mixed
			FROM sources s JOIN source_aliases a ON a.source_id = s.id WHERE s.verdict IS NOT NULL
			UNION ALL
			SELECT i.platform, 'item', i.item_id, i.verdict, i.signals, i.detail, i.flags, ifnull(i.changed_at, 0),
			ifnull(s.verdict, ''), s.mixed
			FROM items i JOIN sources s ON s.id = i.source_id WHERE i.verdict IS NOT NULL`
		)
		.map((r) => ({
			platform: r.platform,
			targetType: r.target_type,
			id: r.id,
			state: { verdict: r.verdict, signals: r.signals, detail: r.detail, flags: r.flags, changedAt: r.changed_at },
			sourceVerdict: r.source_verdict,
			sourceMixed: r.source_mixed !== 0
		}));
}

/** One published entry: the 16 encoded bytes and the target key it came from. */
export interface ListEntry {
	hash: Uint8Array;
	entry: Uint8Array;
	key: string;
}

/** One published list version. */
export interface Sequence {
	seq: number;
	createdAt: number;
}

const blob = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

/**
 * Makes the published entries equal want (keyed by hex hash). When anything differs, or when
 * nothing was published yet, or when floor is above the head, it records a new sequence
 * holding every change (removed returns the encoded removal for a dropped entry) and prunes
 * sequences created before pruneBefore, always keeping the latest.
 *
 * The new sequence is max(head + 1, now, floor + 1): floored to unix seconds, so a restored
 * database never reissues a number an install already holds (hosting plan section 3), and above
 * floor, the sequence of the snapshot in R2. Go numbered head + 1.
 */
export function publishList(
	db: Db,
	want: Map<string, ListEntry>,
	removed: (old: Uint8Array) => Uint8Array,
	now: number,
	pruneBefore: number,
	floor = 0
): { seq: Sequence; changed: boolean } {
	return db.tx(() => {
		const have = new Map<string, Uint8Array>();
		for (const r of db.all<{ hash: ArrayBuffer; entry: ArrayBuffer }>('SELECT hash, entry FROM list_entries')) {
			have.set(hex(new Uint8Array(r.hash)), new Uint8Array(r.entry));
		}
		let seq = latestSequence(db);
		const changes: { hash: Uint8Array; entry: Uint8Array; key: string; drop: boolean }[] = [];
		for (const [h, w] of want) {
			const old = have.get(h);
			if (!old || hex(old) !== hex(w.entry)) changes.push({ hash: w.hash, entry: w.entry, key: w.key, drop: false });
		}
		for (const [h, old] of have) {
			if (!want.has(h)) changes.push({ hash: old.slice(0, 8), entry: removed(old), key: '', drop: true });
		}
		if (changes.length === 0 && seq.seq > 0 && seq.seq >= floor) return { seq, changed: false };
		seq = { seq: Math.max(seq.seq + 1, now, floor + 1), createdAt: now };
		db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', seq.seq, now);
		for (const c of changes) {
			if (c.drop) {
				db.run('DELETE FROM list_entries WHERE hash = ?', blob(c.hash));
			} else {
				db.run(
					`INSERT INTO list_entries (hash, entry, target_key) VALUES (?, ?, ?)
					ON CONFLICT (hash) DO UPDATE SET entry = excluded.entry, target_key = excluded.target_key`,
					blob(c.hash),
					blob(c.entry),
					c.key
				);
			}
			db.run('INSERT INTO list_changes (seq, hash, entry) VALUES (?, ?, ?)', seq.seq, blob(c.hash), blob(c.entry));
		}
		db.run('DELETE FROM list_sequences WHERE created_at < ? AND seq < ?', pruneBefore, seq.seq);
		return { seq, changed: true };
	});
}

/**
 * Returns the newest published sequence (zero when nothing was published). Go took max(seq) and
 * max(created_at) separately; once the clock can run behind the head they differ, and the head's
 * own time is the one its files carry.
 */
export function latestSequence(db: Db): Sequence {
	const r = db.get<{ seq: number; created_at: number }>('SELECT seq, created_at FROM list_sequences ORDER BY seq DESC LIMIT 1');
	return { seq: r?.seq ?? 0, createdAt: r?.created_at ?? 0 };
}

/** Returns every published entry with the sequence they belong to, in one read. */
export function publishedEntries(db: Db): { seq: Sequence; entries: Uint8Array[] } {
	// Synchronous reads with no await between them see one consistent state.
	const seq = latestSequence(db);
	const entries = db.all<{ entry: ArrayBuffer }>('SELECT entry FROM list_entries').map((r) => new Uint8Array(r.entry));
	return { seq, entries };
}

/** Returns when a sequence was published, or undefined when it is unknown or pruned. */
export function sequenceCreated(db: Db, seq: number): number | undefined {
	return db.get<{ created_at: number }>('SELECT created_at FROM list_sequences WHERE seq = ?', seq)?.created_at;
}

/** Returns the final state of every hash changed after since, up to and including upTo. */
export function changesSince(db: Db, since: number, upTo: number): Uint8Array[] {
	const latest = new Map<string, Uint8Array>();
	for (const r of db.all<{ hash: ArrayBuffer; entry: ArrayBuffer }>(
		'SELECT hash, entry FROM list_changes WHERE seq > ? AND seq <= ? ORDER BY seq',
		since,
		upTo
	)) {
		latest.set(hex(new Uint8Array(r.hash)), new Uint8Array(r.entry));
	}
	return [...latest.values()];
}

/** Adds n anonymous list requests to the given hour bucket (unix hour) and prunes week-old buckets. */
export function addListRequests(db: Db, hour: number, n: number): void {
	db.run('INSERT INTO list_requests (hour, count) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET count = count + excluded.count', hour, n);
	db.run('DELETE FROM list_requests WHERE hour < ?', hour - 24 * 7);
}

/**
 * Sets the hour bucket to n and prunes week-old buckets. The hourly analytics pull uses it instead
 * of addListRequests: it reads whole hours from edge analytics, so a repeated or overlapping pull
 * must replace counts, never add them twice.
 */
export function setListRequests(db: Db, hour: number, n: number): void {
	db.run('INSERT INTO list_requests (hour, count) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET count = excluded.count', hour, n);
	db.run('DELETE FROM list_requests WHERE hour < ?', hour - 24 * 7);
}

/** Sums list requests in hour buckets at or after fromHour. */
export function listRequestsSince(db: Db, fromHour: number): number {
	return db.get<{ n: number }>('SELECT ifnull(sum(count), 0) AS n FROM list_requests WHERE hour >= ?', fromHour)!.n;
}
