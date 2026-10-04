// Forward-only schema migrations, run by the Store's constructor under blockConcurrencyWhile.
// The runner only knows the migrations listed here and ignores any newer ones already applied,
// so rolling back to older code still starts. Each migration must finish well under the 30 s
// blockConcurrencyWhile cap; large data changes belong in chunked jobs.
import init from './migrations/0001_init.sql';
import billing from './migrations/0002_billing.sql';
import scoringState from './migrations/0003_scoring_state.sql';
import store from './migrations/0004_store.sql';
import compliance from './migrations/0005_compliance.sql';
import { complianceData } from './compliance';
import type { Db } from './db';

export interface Migration {
	version: number;
	name: string;
	sql: string;
	/**
	 * Data changes in code, run after sql in the same transaction, and again on the rows of a dump
	 * taken before this migration when one is restored (restoredData). now is unix seconds.
	 */
	data?: (db: Db, now: number) => void;
}

export const MIGRATIONS: Migration[] = [
	{ version: 1, name: '0001_init.sql', sql: init },
	{ version: 2, name: '0002_billing.sql', sql: billing },
	{ version: 3, name: '0003_scoring_state.sql', sql: scoringState },
	{ version: 4, name: '0004_store.sql', sql: store },
	{ version: 5, name: '0005_compliance.sql', sql: compliance, data: complianceData }
];

/** Applies pending migrations, each in its own transaction, and returns the schema version. */
export function migrate(db: Db, nowMs: number): number {
	db.run(`CREATE TABLE IF NOT EXISTS _migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	) STRICT`);
	const applied = new Set(db.all<{ version: number }>('SELECT version FROM _migrations').map((r) => r.version));
	for (const m of MIGRATIONS) {
		if (applied.has(m.version)) continue;
		db.tx(() => {
			db.run(m.sql);
			m.data?.(db, Math.floor(nowMs / 1000));
			db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Math.floor(nowMs / 1000));
		});
	}
	return MIGRATIONS.at(-1)!.version;
}

/**
 * Runs the data changes of every migration newer than a restored dump's schema version on its
 * rows, which the Store's schema took in but no migration changed. now is unix seconds.
 */
export function restoredData(db: Db, dumpVersion: number, now: number): void {
	for (const m of MIGRATIONS) if (m.version > dumpVersion) m.data?.(db, now);
}
