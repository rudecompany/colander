// Forward-only schema migrations, run by the Store's constructor under blockConcurrencyWhile.
// The runner only knows the migrations listed here and ignores any newer ones already applied,
// so rolling back to older code still starts. Each migration must finish well under the 30 s
// blockConcurrencyWhile cap; large data changes belong in chunked jobs.
import init from './migrations/0001_init.sql';
import billing from './migrations/0002_billing.sql';
import scoringState from './migrations/0003_scoring_state.sql';
import store from './migrations/0004_store.sql';
import compliance from './migrations/0005_compliance.sql';
import auth from './migrations/0006_auth.sql';
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
	{ version: 5, name: '0005_compliance.sql', sql: compliance, data: complianceData },
	{ version: 6, name: '0006_auth.sql', sql: auth, data: authData }
];

/** Reviewer tokens from before 0006 keep working this long, while curators enroll a passkey (contracts 6.6). */
export const LEGACY_TOKEN_SECONDS = 7 * 86_400;

/**
 * 0006's backfills: sessions from before it signed in by email link at their creation, and only
 * they may still arrive under the old cookie name; reviewer tokens from before it expire in 7
 * days; log entries learn which account decided them, from the decision or the appeal they
 * record. Each only touches rows that lack the value, so it also runs on a restored older dump.
 */
export function authData(db: Db, now: number): void {
	db.run('UPDATE sessions SET authenticated_at = created_at, legacy = 1 WHERE authenticated_at IS NULL');
	db.run('UPDATE reviewer_tokens SET expires_at = ? WHERE expires_at IS NULL', now + LEGACY_TOKEN_SECONDS);
	db.run(`UPDATE decision_log SET account_id = (
		SELECT d.account_id FROM decisions d
		WHERE d.source_id = decision_log.source_id AND d.created_at = decision_log.at AND d.actor = decision_log.actor AND d.account_id IS NOT NULL
		ORDER BY d.id DESC LIMIT 1
	) WHERE actor_name IS NOT NULL AND account_id IS NULL`);
	db.run(`UPDATE decision_log SET account_id = (
		SELECT a.resolved_by FROM appeals a WHERE a.source_id = decision_log.source_id AND a.resolved_at = decision_log.at
		ORDER BY a.id LIMIT 1
	) WHERE actor = 'appeal' AND actor_name IS NOT NULL AND account_id IS NULL`);
}

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
