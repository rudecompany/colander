// Adapter configs, trials, settings sync, the YouTube cache and public counts (Go's store/misc.go).
import { ConflictError, type Db } from './db';
import { touchInstall } from './tags';

/** Stores a signed adapter configuration envelope (JSON text). */
export function saveAdapterConfig(db: Db, version: number, envelope: string, now: number): void {
	db.run('INSERT INTO adapter_configs (version, envelope, created_at) VALUES (?, ?, ?)', version, envelope, now);
}

/** Returns the newest stored envelope. */
export function latestAdapterConfig(db: Db): string | undefined {
	return db.get<{ envelope: string }>('SELECT envelope FROM adapter_configs ORDER BY id DESC LIMIT 1')?.envelope;
}

/** Records the one trial an install may take. Throws ConflictError when one was taken before. */
export function startTrial(db: Db, install: string, sub: string, now: number, expires: number): void {
	db.tx(() => {
		touchInstall(db, install, now);
		const n = db.run(
			`INSERT INTO trials (install_hash, sub, issued_at, expires_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (install_hash) DO NOTHING`,
			install,
			sub,
			now,
			expires
		);
		if (n === 0) throw new ConflictError();
	});
}

/** A Plus user's synced settings. */
export interface SyncBlob {
	version: number;
	/** a JSON object, "" when nothing was stored yet */
	data: string;
	updatedAt: number;
}

/** Returns the blob for sub, or a zero blob (version 0) when none exists. */
export function getSync(db: Db, sub: string): SyncBlob {
	const r = db.get<{ version: number; data: string; updated_at: number }>('SELECT version, data, updated_at FROM sync_blobs WHERE sub = ?', sub);
	return r ? { version: r.version, data: r.data, updatedAt: r.updated_at } : { version: 0, data: '', updatedAt: 0 };
}

/**
 * Stores data when base equals the current version and returns the new blob. On a stale base it
 * returns the current blob with conflict set (Go's ErrConflict) and changes nothing.
 */
export function putSync(db: Db, sub: string, base: number, data: string, now: number): { blob: SyncBlob; conflict: boolean } {
	return db.tx(() => {
		const cur = getSync(db, sub);
		if (cur.version !== base) return { blob: cur, conflict: true };
		const blob = { version: cur.version + 1, data, updatedAt: now };
		db.run(
			`INSERT INTO sync_blobs (sub, version, data, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (sub) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at`,
			sub,
			blob.version,
			data,
			now
		);
		return { blob, conflict: false };
	});
}

/** Returns a cached YouTube response fetched at or after notBefore. */
export function cacheGet(db: Db, key: string, notBefore: number): Uint8Array | undefined {
	const r = db.get<{ body: ArrayBuffer }>('SELECT body FROM youtube_cache WHERE key = ? AND fetched_at >= ?', key, notBefore);
	return r && new Uint8Array(r.body);
}

/** Stores a YouTube response. */
export function cachePut(db: Db, key: string, body: Uint8Array, now: number): void {
	db.run(
		`INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
		key,
		body.slice().buffer,
		now
	);
}

/** Counts rated sources per verdict and rated items. */
export function verdictCounts(db: Db): { counts: Record<string, number>; items: number } {
	const counts: Record<string, number> = { slop: 0, likely_slop: 0, ai_made: 0, disputed: 0, clear: 0 };
	for (const r of db.all<{ verdict: string; n: number }>('SELECT verdict, count(*) AS n FROM sources WHERE verdict IS NOT NULL GROUP BY verdict')) {
		counts[r.verdict] = r.n;
	}
	const { items } = db.get<{ items: number }>('SELECT count(*) AS items FROM items WHERE verdict IS NOT NULL')!;
	return { counts, items };
}

/** Counts decision log entries at or after a time. */
export function logCountSince(db: Db, since: number): number {
	return db.get<{ n: number }>('SELECT count(*) AS n FROM decision_log WHERE at >= ?', since)!.n;
}
