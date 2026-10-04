// The data changes of migration 0005, in code because they rewrite text. migrate() runs them once
// after 0005_compliance.sql, and loadDump runs them again on rows restored from a dump taken before
// 0005, so every step must be idempotent.
import { hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import type { Db } from './db';

/** What takes the place of a seed list's name in the public log. */
export const WITHHELD = '[withheld]';

/** The seed list clause the old rules opened a scoring reason with ("Likely slop. Listed on the X seed list, ..."). */
const SEED_CLAUSE = /^([^.]*\. )Listed on the .*? seed list/;
/** Its replacement, a clause that fits the same list of reasons and names no kind of evidence. */
const RETIRED_RULE = '$1It met a rule Colander no longer uses';

/** now is unix seconds. */
export function complianceData(db: Db, now: number): void {
	// First, so their names are in seed_imports for the redaction.
	clearLegacyImports(db, now);
	// The scoring pass wrote these reasons; the words of reviewers and appeals lose only the names.
	for (const r of db.all<{ id: number; reason: string }>(
		"SELECT id, reason FROM decision_log WHERE actor = 'community' AND (instr(reason, ' seed list') > 0 OR instr(reason, 'the imported entry') > 0)"
	)) {
		redact(db, r.id, r.reason, r.reason.replace(SEED_CLAUSE, RETIRED_RULE).replace(' until staff review the imported entry.', ' until staff review it.'));
	}
	redactSeedNames(db, seedListNames(db));
	// Names come from reports or, for YouTube, from the Data API. A name no report on the source gave
	// is the API title, which may not be kept 30 days: it goes from the source and its log rows.
	db.run(`UPDATE decision_log SET source_name = NULL
		WHERE source_name IS NOT NULL
		AND source_id IN (SELECT id FROM sources WHERE youtube_checked_at IS NOT NULL)
		AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.source_id = decision_log.source_id AND r.source_name = decision_log.source_name)`);
	db.run(`UPDATE sources SET name = NULL
		WHERE name IS NOT NULL
		AND youtube_checked_at IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.source_id = sources.id AND r.source_name = sources.name)`);
	// The API figures go too; every YouTube source is looked up again at the bounded rate.
	db.run(`UPDATE sources SET subscribers = NULL, uploads_per_day = NULL, youtube_checked_at = NULL
		WHERE subscribers IS NOT NULL OR uploads_per_day IS NOT NULL OR youtube_checked_at IS NOT NULL`);
}

/**
 * Entries of imports from before the license check, which took lists of any license, are not kept
 * (seed list review A3): each list keeps one seed_imports row with their count and a hash of their
 * IDs, marked cleared_at, and the sources lose the import.
 */
function clearLegacyImports(db: Db, now: number): void {
	const legacy = 'import_batch IS NULL AND (import_list IS NOT NULL OR import_source IS NOT NULL OR import_license IS NOT NULL OR imported_at IS NOT NULL)';
	for (const g of db.all<{ name: string; list: string; license: string; at: number; ids: string }>(
		`SELECT ifnull(import_source, '') AS name, ifnull(import_list, '') AS list, ifnull(import_license, '') AS license,
		max(ifnull(imported_at, 0)) AS at, group_concat(platform || ':' || canonical_id, char(10)) AS ids
		FROM sources WHERE ${legacy} GROUP BY 1, 2, 3`
	)) {
		const ids = g.ids.split('\n').sort();
		db.run(
			'INSERT INTO seed_imports (source_name, list, license, sha256, entries, imported_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			g.name,
			g.list,
			g.license,
			hex(sha256(utf8(ids.join('\n')))),
			ids.length,
			g.at,
			now
		);
	}
	db.run(`UPDATE sources SET import_list = NULL, import_source = NULL, import_license = NULL, imported_at = NULL WHERE ${legacy}`);
}

/** The names of every seed list Colander imported, checked or cleared. Staff only. */
export function seedListNames(db: Db): string[] {
	return db.all<{ name: string }>("SELECT DISTINCT source_name AS name FROM seed_imports WHERE source_name != ''").map((r) => r.name);
}

/**
 * Takes the names out of the public decision log wherever a reviewer or an appeal wrote one
 * (contracts 6.4), matching as namedSeedList does, case-insensitively. The scoring pass never
 * writes a name.
 */
export function redactSeedNames(db: Db, names: string[]): void {
	for (const name of names) {
		const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
		for (const r of db.all<{ id: number; reason: string }>(
			"SELECT id, reason FROM decision_log WHERE actor != 'community' AND instr(lower(reason), lower(?)) > 0",
			name
		)) {
			redact(db, r.id, r.reason, r.reason.replace(re, WITHHELD));
		}
	}
}

/** Replaces a log reason, keeping the text as first written in the staff-only reason_original. */
function redact(db: Db, id: number, reason: string, redacted: string): void {
	if (redacted === reason) return;
	db.run('UPDATE decision_log SET reason_original = coalesce(reason_original, reason), reason = ? WHERE id = ?', redacted, id);
}
