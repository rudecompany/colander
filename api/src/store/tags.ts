// Installs, tags and reports (Go's store/tags.go).
import { bit, ConflictError, newId, NotFoundError, nullInt, nullString, type Db } from './db';
import { ensureItem, ensureSource } from './sources';

/** Records an install hash the first time it is seen. */
export function touchInstall(db: Db, hash: string, now: number): void {
	db.run('INSERT INTO installs (hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING', hash, now);
}

/** One validated tag with canonical IDs. */
export interface TagInput {
	clientId: string;
	platform: string;
	/** source | item */
	targetType: string;
	targetId: string;
	/** the item's source; the target itself for source tags */
	sourceId: string;
	/** slop | ai_fine | not_slop */
	verdict: string;
	slopType: string;
	tests: number;
	platformLabel: boolean;
	createdAt: number;
	extVersion: string;
}

/**
 * Stores tags from one install. A tag replaces the install's earlier tag on the same target unless
 * the stored one is newer; replaying the same tag changes nothing. Returns the touched source refs.
 */
export function saveTags(db: Db, install: string, tags: TagInput[], now: number): number[] {
	return db.tx(() => {
		const refs: number[] = [];
		touchInstall(db, install, now);
		for (const t of tags) {
			let sourceRef = ensureSource(db, t.platform, t.sourceId, '', now);
			let itemRef = 0;
			if (t.targetType === 'item') {
				itemRef = ensureItem(db, t.platform, t.targetId, sourceRef, now);
				// An item keeps its first source, so evidence rolls up to that one.
				sourceRef = db.get<{ source_id: number }>('SELECT source_id FROM items WHERE id = ?', itemRef)!.source_id;
			}
			db.run(
				`INSERT INTO tags (install_hash, platform, target_type, target_id, source_id, item_id,
				client_id, verdict, slop_type, tests, platform_label, created_at, received_at, ext_version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (install_hash, platform, target_type, target_id) DO UPDATE SET
					source_id = excluded.source_id, item_id = excluded.item_id, client_id = excluded.client_id,
					verdict = excluded.verdict, slop_type = excluded.slop_type, tests = excluded.tests,
					platform_label = excluded.platform_label, created_at = excluded.created_at,
					received_at = excluded.received_at, ext_version = excluded.ext_version
				WHERE excluded.client_id != tags.client_id AND excluded.created_at >= tags.created_at`,
				install,
				t.platform,
				t.targetType,
				t.targetId,
				sourceRef,
				nullInt(itemRef),
				t.clientId,
				t.verdict,
				nullString(t.slopType),
				t.tests,
				bit(t.platformLabel),
				t.createdAt,
				now,
				nullString(t.extVersion)
			);
			refs.push(sourceRef);
		}
		db.run('UPDATE installs SET first_tag_at = ? WHERE hash = ? AND first_tag_at IS NULL', now, install);
		return refs;
	});
}

/** One validated report. */
export interface ReportInput {
	installHash: string;
	clientId: string;
	platform: string;
	/** canonical, as reported */
	sourceId: string;
	sourceName: string;
	/** null is Go's nil slice, stored as JSON null like the Go server does */
	examples: string[] | null;
	reason: string;
	slopType: string;
	tests: number;
	extVersion: string;
}

/** A stored report. */
export interface Report {
	id: string;
	platform: string;
	sourceRef: number;
	reportedId: string;
	sourceName: string;
	examples: string[] | null;
	reason: string;
	slopType: string;
	tests: number;
	/** open | decided | dismissed */
	status: string;
	verdict: string;
	closeReason: string;
	createdAt: number;
	updatedAt: number;
}

type ReportRow = {
	id: string;
	platform: string;
	source_id: number;
	reported_id: string;
	source_name: string;
	examples: string;
	reason: string;
	slop_type: string;
	tests: number;
	status: string;
	verdict: string;
	close_reason: string;
	created_at: number;
	updated_at: number;
};

const reportCols = `id, platform, source_id, reported_id, ifnull(source_name, '') AS source_name, examples, reason,
	ifnull(slop_type, '') AS slop_type, tests, status, ifnull(verdict, '') AS verdict, ifnull(close_reason, '') AS close_reason,
	created_at, updated_at`;

function scanReport(r: ReportRow): Report {
	return {
		id: r.id,
		platform: r.platform,
		sourceRef: r.source_id,
		reportedId: r.reported_id,
		sourceName: r.source_name,
		examples: JSON.parse(r.examples) as string[] | null,
		reason: r.reason,
		slopType: r.slop_type,
		tests: r.tests,
		status: r.status,
		verdict: r.verdict,
		closeReason: r.close_reason,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}

function reports(db: Db, where: string, ...args: SqlStorageValue[]): Report[] {
	return db.all<ReportRow>(`SELECT ${reportCols} FROM reports WHERE ${where}`, ...args).map(scanReport);
}

/**
 * Stores a report, creating its source when unknown. Sending the same client_id again returns the
 * stored report and created = false.
 */
export function createReport(db: Db, input: ReportInput, now: number): { report: Report; created: boolean } {
	const examples = JSON.stringify(input.examples);
	return db.tx(() => {
		const existing = db.get<{ id: string }>('SELECT id FROM reports WHERE install_hash = ? AND client_id = ?', input.installHash, input.clientId);
		if (existing) return { report: getReport(db, existing.id)!, created: false };
		touchInstall(db, input.installHash, now);
		const ref = ensureSource(db, input.platform, input.sourceId, input.sourceName, now);
		const id = newId('rpt');
		db.run(
			`INSERT INTO reports (id, install_hash, client_id, platform, source_id, reported_id,
			source_name, examples, reason, slop_type, tests, ext_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.installHash,
			input.clientId,
			input.platform,
			ref,
			input.sourceId,
			nullString(input.sourceName),
			examples,
			input.reason,
			nullString(input.slopType),
			input.tests,
			nullString(input.extVersion),
			now,
			now
		);
		return { report: getReport(db, id)!, created: true };
	});
}

/** Loads one report. */
export function getReport(db: Db, id: string): Report | undefined {
	return reports(db, 'id = ?', id)[0];
}

/** Lists an install's reports, newest first. */
export function reportsByInstall(db: Db, install: string): Report[] {
	return reports(db, 'install_hash = ? ORDER BY created_at DESC, rowid DESC', install);
}

/** Lists a source's reports, open ones first, then newest first. */
export function reportsBySource(db: Db, sourceRef: number): Report[] {
	return reports(db, "source_id = ? ORDER BY status != 'open', created_at DESC, rowid DESC", sourceRef);
}

/** Lists every open report, oldest first. */
export function openReports(db: Db): Report[] {
	return reports(db, "status = 'open' ORDER BY created_at, rowid");
}

/**
 * Closes an open report with no verdict change. Throws NotFoundError for an unknown report and
 * ConflictError when it is not open.
 */
export function dismissReport(db: Db, id: string, reason: string, now: number): void {
	db.tx(() => {
		const n = db.run(
			`UPDATE reports SET status = 'dismissed', close_reason = ?, updated_at = ?
			WHERE id = ? AND status = 'open'`,
			reason,
			now,
			id
		);
		if (n === 0) throw getReport(db, id) ? new ConflictError() : new NotFoundError();
	});
}

/** Closes a source's open reports with the verdict a reviewer set ("" dismisses them). */
export function closeReports(db: Db, sourceRef: number, verdict: string, reason: string, now: number): void {
	const status = verdict === '' ? 'dismissed' : 'decided';
	db.run(
		`UPDATE reports SET status = ?, verdict = ?, close_reason = ?, updated_at = ?
		WHERE source_id = ? AND status = 'open'`,
		status,
		nullString(verdict),
		reason,
		now,
		sourceRef
	);
}
