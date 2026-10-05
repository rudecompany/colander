// The calibration set (seed design section 8): sources sampled from a frame and labeled blind by
// staff and curators, two labels each and a third from staff when they disagree. Labels are for
// measuring the lists and tuning thresholds, never evidence, and never published.
import { ConflictError, NotFoundError, nullString, type Db } from './db';
import { deleteOrphans } from './seeds';

/** What a labeler says after looking at the source on its platform, applying /definition. */
export const LABELS = ['slop', 'ai_not_slop', 'not_ai', 'gone', 'unsure'] as const;
export type Label = (typeof LABELS)[number];

/** Calibration rows go 24 months after the last label (seed list review 16). */
export const CALIBRATION_RETENTION = 730 * 86_400;

/** Labels per item, and a third from staff when the first two disagree. */
const LABELS_PER_ITEM = 2;

/** Adds sources to the calibration set under a frame; sources already in it keep their frame. Returns how many were added. */
export function addCalibrationItems(db: Db, refs: number[], frame: string, now: number): number {
	return db.tx(() => {
		let added = 0;
		for (const ref of refs) added += db.run('INSERT OR IGNORE INTO calibration_items (source_id, frame, sampled_at) VALUES (?, ?, ?)', ref, frame, now) > 0 ? 1 : 0;
		return added;
	});
}

/** Sources with tags or reports that are not in the set yet and not suppressed: the community frame. */
export function communitySources(db: Db): number[] {
	return db
		.all<{ id: number }>(
			`SELECT id FROM sources s WHERE canonical_id != '' AND seed_suppressed_at IS NULL
			AND (EXISTS (SELECT 1 FROM tags t WHERE t.source_id = s.id) OR EXISTS (SELECT 1 FROM reports r WHERE r.source_id = s.id))
			AND NOT EXISTS (SELECT 1 FROM calibration_items c WHERE c.source_id = s.id) ORDER BY id`
		)
		.map((r) => r.id);
}

/** Whether the alias's source is in the calibration set already. */
export function sampled(db: Db, ref: number): boolean {
	return db.get('SELECT 1 FROM calibration_items WHERE source_id = ?', ref) !== undefined;
}

/** The next item for a labeler: only what they need to find it on its platform. */
export interface CalibrationTask {
	ref: number;
	platform: string;
	canonicalId: string;
	labels: number;
}

/**
 * The next item this account has not labeled: items with one label first, so pairs finish, then
 * by sampling order. Staff also get the items whose two labels disagree, for the third label.
 */
export function nextCalibration(db: Db, accountId: string, staff: boolean): CalibrationTask | undefined {
	const r = db.get<{ ref: number; platform: string; canonical_id: string; labels: number }>(
		`SELECT c.source_id AS ref, s.platform, s.canonical_id, count(l.account_id) AS labels,
			count(DISTINCT l.label) AS kinds
		FROM calibration_items c JOIN sources s ON s.id = c.source_id LEFT JOIN calibration_labels l ON l.source_id = c.source_id
		WHERE s.seed_suppressed_at IS NULL AND s.canonical_id != ''
		AND NOT EXISTS (SELECT 1 FROM calibration_labels m WHERE m.source_id = c.source_id AND m.account_id = ?)
		GROUP BY c.source_id
		HAVING labels < ? OR (? AND labels = ? AND kinds > 1)
		ORDER BY labels = 1 DESC, labels DESC, c.sampled_at, c.source_id LIMIT 1`,
		accountId,
		LABELS_PER_ITEM,
		staff ? 1 : 0,
		LABELS_PER_ITEM
	);
	return r && { ref: r.ref, platform: r.platform, canonicalId: r.canonical_id, labels: r.labels };
}

export interface LabelInput {
	label: Label;
	/** test bits the labeler found (contracts 3, detail byte) */
	tests: number;
	/** provenance signal bits the labeler saw on the platform */
	evidence: number;
	note: string;
	/** a CALIBRATION_LANGUAGES code, or '' for gone and unsure */
	language: string;
	/** music or video, or '' for gone and unsure */
	kind: string;
}

/**
 * Records one account's label. Throws NotFoundError when the source is not in the set, and
 * ConflictError when this account labeled it already or it needs no more labels from them.
 */
export function addLabel(db: Db, ref: number, accountId: string, staff: boolean, l: LabelInput, now: number): void {
	db.tx(() => {
		if (!db.get('SELECT 1 FROM calibration_items c JOIN sources s ON s.id = c.source_id WHERE c.source_id = ? AND s.seed_suppressed_at IS NULL', ref)) throw new NotFoundError();
		const done = db.get<{ n: number; kinds: number; mine: number }>(
			'SELECT count(*) AS n, count(DISTINCT label) AS kinds, sum(account_id = ?) AS mine FROM calibration_labels WHERE source_id = ?',
			accountId,
			ref
		)!;
		const third = staff && done.n === LABELS_PER_ITEM && done.kinds > 1;
		if ((done.mine ?? 0) > 0 || (done.n >= LABELS_PER_ITEM && !third)) throw new ConflictError();
		db.run(
			'INSERT INTO calibration_labels (source_id, account_id, label, tests, evidence, note, language, kind, labeled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			ref,
			accountId,
			l.label,
			l.tests,
			l.evidence,
			nullString(l.note),
			nullString(l.language),
			nullString(l.kind),
			now
		);
	});
}

/** One item with its labels, for `calibration-export`. Staff only: it goes to the private bucket. */
export interface CalibrationRow {
	source_id: number;
	platform: string;
	id: string;
	frame: string;
	sampled_at: number;
	large: boolean;
	verdict: string | null;
	computed: string | null;
	seeds: string[];
	labels: { labeler: string; label: string; tests: number; evidence: number; language: string | null; kind: string | null; note: string | null; labeled_at: number }[];
}

export function exportCalibration(db: Db): CalibrationRow[] {
	const rows = db.all<{ ref: number; platform: string; canonical_id: string; frame: string; sampled_at: number; large: number; verdict: string | null; computed: string | null }>(
		`SELECT c.source_id AS ref, s.platform, s.canonical_id, c.frame, c.sampled_at, s.large_staff AS large, s.verdict, s.computed
		FROM calibration_items c JOIN sources s ON s.id = c.source_id ORDER BY c.source_id`
	);
	return rows.map((r) => ({
		source_id: r.ref,
		platform: r.platform,
		id: r.canonical_id,
		frame: r.frame,
		sampled_at: r.sampled_at,
		large: r.large !== 0,
		verdict: r.verdict,
		computed: r.computed,
		seeds: db.all<{ seed: string }>('SELECT DISTINCT seed FROM seed_entries WHERE source_id = ? ORDER BY seed', r.ref).map((s) => s.seed),
		labels: db.all<CalibrationRow['labels'][number]>(
			'SELECT account_id AS labeler, label, tests, evidence, language, kind, note, labeled_at FROM calibration_labels WHERE source_id = ? ORDER BY labeled_at, account_id',
			r.ref
		)
	}));
}

/** Deletes calibration items whose last label (or sampling, when unlabeled) is over 24 months old, and sources that existed only for them. */
export function pruneCalibration(db: Db, now: number): number {
	return db.tx(() => {
		const gone = db.all<{ source_id: number }>(
			`DELETE FROM calibration_items WHERE max(sampled_at, ifnull((SELECT max(labeled_at) FROM calibration_labels l WHERE l.source_id = calibration_items.source_id), 0)) < ?
			RETURNING source_id`,
			now - CALIBRATION_RETENTION
		);
		deleteOrphans(
			db,
			gone.map((r) => r.source_id)
		);
		return gone.length;
	});
}
