// What scoring reads and writes: votes, decisions, reputation, the decision log, state updates
// and escalations (Go's store/verdicts.go).
import { bit, nullInt, nullString, type Db } from './db';
import { getSource, itemsBySource, type Item, type Source, type State } from './sources';
import { closeReports } from './tags';

/** One install's latest tag on a source or one of its items, as scoring reads it. */
export interface Vote {
	install: string;
	/** 0 for a tag on the source itself */
	itemRef: number;
	verdict: string;
	slopType: string;
	tests: number;
	platformLabel: boolean;
	createdAt: number;
	receivedAt: number;
	installCreatedAt: number;
}

/** A staff, curator or appeal decision on a source or item. */
export interface Decision {
	id: number;
	sourceRef: number;
	itemRef: number;
	/** a verdict, or "none" */
	verdict: string;
	reason: string;
	signals: number;
	detail: number;
	/** curator | staff | appeal */
	actor: string;
	accountId: string;
	actorName: string;
	createdAt: number;
	expiresAt: number;
}

/** Everything scoring needs about one source. */
export interface SourceData {
	source: Source;
	items: Item[];
	votes: Vote[];
	/** the active decision per item ref, 0 for the source */
	decisions: Map<number, Decision>;
	/** a verified appeal is under review */
	appealOpen: boolean;
	openReports: number;
	/** when the oldest appeal waiting for staff to check its code was filed, 0 when none */
	pendingManualSince: number;
}

/** Loads a source with its items, tags, active decisions, appeal and report state. */
export function loadSourceData(db: Db, ref: number, now: number): SourceData | undefined {
	const source = getSource(db, ref);
	if (!source) return undefined;
	const votes = db
		.all<{
			install_hash: string;
			item_id: number;
			verdict: string;
			slop_type: string;
			tests: number;
			platform_label: number;
			created_at: number;
			received_at: number;
			install_created_at: number;
		}>(
			`SELECT t.install_hash, ifnull(t.item_id, 0) AS item_id, t.verdict, ifnull(t.slop_type, '') AS slop_type,
			t.tests, t.platform_label, t.created_at, t.received_at, i.created_at AS install_created_at
			FROM tags t JOIN installs i ON i.hash = t.install_hash WHERE t.source_id = ?`,
			ref
		)
		.map((r) => ({
			install: r.install_hash,
			itemRef: r.item_id,
			verdict: r.verdict,
			slopType: r.slop_type,
			tests: r.tests,
			platformLabel: r.platform_label !== 0,
			createdAt: r.created_at,
			receivedAt: r.received_at,
			installCreatedAt: r.install_created_at
		}));
	const decisionMap = new Map<number, Decision>();
	for (const d of decisions(db, 'source_id = ? AND expires_at > ? ORDER BY id', ref, now)) {
		decisionMap.set(d.itemRef, d); // later decisions replace earlier ones
	}
	const counts = db.get<{ appeal_open: number; open_reports: number; pending_manual_since: number }>(
		`SELECT
		(SELECT count(*) FROM appeals WHERE source_id = ? AND status = 'under_review') AS appeal_open,
		(SELECT count(*) FROM reports WHERE source_id = ? AND status = 'open') AS open_reports,
		(SELECT ifnull(min(created_at), 0) FROM appeals WHERE source_id = ? AND status = 'pending_manual') AS pending_manual_since`,
		ref,
		ref,
		ref
	)!;
	return {
		source,
		items: itemsBySource(db, ref),
		votes,
		decisions: decisionMap,
		appealOpen: counts.appeal_open !== 0,
		openReports: counts.open_reports,
		pendingManualSince: counts.pending_manual_since
	};
}

type DecisionRow = {
	id: number;
	source_id: number;
	item_id: number;
	verdict: string;
	reason: string;
	signals: number;
	detail: number;
	actor: string;
	account_id: string;
	actor_name: string;
	created_at: number;
	expires_at: number;
};

function decisions(db: Db, where: string, ...args: SqlStorageValue[]): Decision[] {
	return db
		.all<DecisionRow>(
			`SELECT id, source_id, ifnull(item_id, 0) AS item_id, verdict, reason, signals, detail, actor,
			ifnull(account_id, '') AS account_id, ifnull(actor_name, '') AS actor_name, created_at, expires_at
			FROM decisions WHERE ${where}`,
			...args
		)
		.map((r) => ({
			id: r.id,
			sourceRef: r.source_id,
			itemRef: r.item_id,
			verdict: r.verdict,
			reason: r.reason,
			signals: r.signals,
			detail: r.detail,
			actor: r.actor,
			accountId: r.account_id,
			actorName: r.actor_name,
			createdAt: r.created_at,
			expiresAt: r.expires_at
		}));
}

/** The raw input to one install's reputation (contracts 9.1). */
export interface Rep {
	firstTagAt: number;
	decided: number;
	agree: number;
}

/**
 * Returns reputation inputs per install. With sourceRef set, only installs that tagged that source
 * or its items are returned. A target counts as decided when it holds a staff or appeal decision
 * (the staff reviewed flag), a slop verdict the community consensus layer agreed on, or a Clear
 * from not-slop consensus. An AI-made verdict that merely carries the consensus signal does not
 * count, or slop taggers would lose weight for the consensus they formed and verdicts would flip
 * back and forth between passes. An item without its own verdict holds its source's.
 */
export function reputation(db: Db, sourceRef: number): Map<string, Rep> {
	const filter = sourceRef !== 0 ? 'WHERE t.install_hash IN (SELECT install_hash FROM tags WHERE source_id = ?)' : '';
	const args = sourceRef !== 0 ? [sourceRef] : [];
	const rows = db.all<{ hash: string; first_tag_at: number; decided: number; agree: number }>(
		`WITH t AS (
		SELECT t.install_hash AS h, t.verdict AS tv,
			CASE WHEN it.verdict IS NOT NULL THEN it.verdict ELSE src.verdict END AS v,
			CASE WHEN it.verdict IS NOT NULL THEN it.flags ELSE src.flags END AS f,
			CASE WHEN it.verdict IS NOT NULL THEN it.signals ELSE src.signals END AS sg
		FROM tags t JOIN sources src ON src.id = t.source_id LEFT JOIN items it ON it.id = t.item_id ${filter}
	), d AS (
		SELECT h, tv, v, (v IN ('slop', 'likely_slop', 'ai_made', 'clear') AND (f & 64) != 0)
			OR (v IN ('slop', 'likely_slop') AND (sg & 4096) != 0)
			OR (v = 'clear' AND (sg & 32768) != 0) AS decided FROM t
	)
	SELECT i.hash, ifnull(i.first_tag_at, i.created_at) AS first_tag_at, sum(d.decided) AS decided,
		sum(d.decided AND ((tv = 'slop' AND v IN ('slop', 'likely_slop')) OR (tv = 'not_slop' AND v = 'clear') OR (tv = 'ai_fine' AND v = 'ai_made'))) AS agree
	FROM d JOIN installs i ON i.hash = d.h GROUP BY i.hash`,
		...args
	);
	return new Map(rows.map((r) => [r.hash, { firstTagAt: r.first_tag_at, decided: r.decided, agree: r.agree }]));
}

/** One row of the public decision log. */
export interface LogEntry {
	id: number;
	at: number;
	platform: string;
	targetType: string;
	targetId: string;
	sourceRef: number;
	sourceKey: string;
	sourceName: string;
	from: string;
	to: string;
	reason: string;
	signals: number;
	actor: string;
	actorName: string;
}

function addLog(db: Db, e: LogEntry): void {
	db.run(
		`INSERT INTO decision_log (at, platform, target_type, target_id, source_id, source_key,
		source_name, from_verdict, to_verdict, reason, signals, actor, actor_name)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.at,
		e.platform,
		e.targetType,
		e.targetId,
		nullInt(e.sourceRef),
		e.sourceKey,
		nullString(e.sourceName),
		nullString(e.from),
		nullString(e.to),
		e.reason,
		e.signals,
		e.actor,
		nullString(e.actorName)
	);
}

/** Narrows a decision log query. Results are newest first. */
export interface LogFilter {
	/** cursor: only entries with a smaller id */
	before?: number;
	platform?: string;
	/** matches the verdict the entry moved to */
	verdict?: string;
	sourceRef?: number;
	limit: number;
}

/** Lists decision log entries (Go's Store.Log). */
export function log(db: Db, f: LogFilter): LogEntry[] {
	const where: string[] = [];
	const args: SqlStorageValue[] = [];
	if (f.before && f.before > 0) where.push('id < ?'), args.push(f.before);
	if (f.platform) where.push('platform = ?'), args.push(f.platform);
	if (f.verdict) where.push('to_verdict = ?'), args.push(f.verdict);
	if (f.sourceRef) where.push('source_id = ?'), args.push(f.sourceRef);
	let q = `SELECT id, at, platform, target_type, target_id, ifnull(source_id, 0) AS source_id, source_key,
		ifnull(source_name, '') AS source_name, ifnull(from_verdict, '') AS from_verdict, ifnull(to_verdict, '') AS to_verdict,
		reason, signals, actor, ifnull(actor_name, '') AS actor_name FROM decision_log`;
	if (where.length > 0) q += ' WHERE ' + where.join(' AND ');
	q += ' ORDER BY id DESC LIMIT ' + Math.max(Math.trunc(f.limit), 1);
	return db
		.all<{
			id: number;
			at: number;
			platform: string;
			target_type: string;
			target_id: string;
			source_id: number;
			source_key: string;
			source_name: string;
			from_verdict: string;
			to_verdict: string;
			reason: string;
			signals: number;
			actor: string;
			actor_name: string;
		}>(q, ...args)
		.map((r) => ({
			id: r.id,
			at: r.at,
			platform: r.platform,
			targetType: r.target_type,
			targetId: r.target_id,
			sourceRef: r.source_id,
			sourceKey: r.source_key,
			sourceName: r.source_name,
			from: r.from_verdict,
			to: r.to_verdict,
			reason: r.reason,
			signals: r.signals,
			actor: r.actor,
			actorName: r.actor_name
		}));
}

/** A new state for a source (itemRef 0) or item, with an optional log entry. */
export interface Update {
	sourceRef: number;
	itemRef: number;
	/**
	 * The verdict the caller computed from. The update is skipped when the stored verdict changed in
	 * the meantime, so two scorers never log the same change twice.
	 */
	expect: string;
	state: State;
	log?: LogEntry;
}

/** Writes the state and log entry in one transaction. Returns false when skipped. */
export function applyUpdate(db: Db, u: Update): boolean {
	const [table, id] = u.itemRef !== 0 ? ['items', u.itemRef] : ['sources', u.sourceRef];
	return db.tx(() => {
		const row = db.get<{ verdict: string }>(`SELECT ifnull(verdict, '') AS verdict FROM ${table} WHERE id = ?`, id);
		if (!row || row.verdict !== u.expect) return false;
		const cur = row.verdict;
		const st = u.state;
		db.run(
			`UPDATE ${table} SET verdict = ?, signals = ?, detail = ?, flags = ?, changed_at = ?,
			rescore_at = ?, lapse_hold = ?, computed = ? WHERE id = ?`,
			nullString(st.verdict),
			st.signals,
			st.detail,
			st.flags,
			nullInt(st.changedAt),
			nullInt(st.rescoreAt),
			bit(st.lapseHold),
			nullString(st.computed),
			id
		);
		if (u.itemRef === 0) {
			db.run('UPDATE sources SET mixed = ? WHERE id = ?', bit(st.mixed), id);
			// A report follows its source: once the list verdict changes after it was filed, it shows that verdict (6.3).
			if (st.verdict !== '' && st.verdict !== cur && u.log) closeReports(db, u.sourceRef, st.verdict, u.log.reason, u.log.at);
		}
		if (u.log) addLog(db, u.log);
		return true;
	});
}

/**
 * Records a reviewer or appeal decision. A source decision marks the source reviewed, lifts any
 * lapse hold, closes its open reports and resolves its escalations; large, when set, records the
 * staff view of the source's size. An item decision does the same for the item. Returns its id.
 */
export function addDecision(db: Db, d: Omit<Decision, 'id'>, large?: boolean): number {
	return db.tx(() => {
		const { id } = db.get<{ id: number }>(
			`INSERT INTO decisions (source_id, item_id, verdict, reason, signals, detail, actor,
			account_id, actor_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			d.sourceRef,
			nullInt(d.itemRef),
			d.verdict,
			d.reason,
			d.signals,
			d.detail,
			d.actor,
			nullString(d.accountId),
			nullString(d.actorName),
			d.createdAt,
			d.expiresAt
		)!;
		if (d.itemRef !== 0) {
			db.run('UPDATE items SET lapse_hold = 0 WHERE id = ?', d.itemRef);
			db.run('UPDATE escalations SET resolved_at = ? WHERE item_id = ? AND resolved_at IS NULL', d.createdAt, d.itemRef);
			return id;
		}
		db.run('UPDATE sources SET reviewed_at = ?, lapse_hold = 0 WHERE id = ?', d.createdAt, d.sourceRef);
		if (large !== undefined) {
			db.run('UPDATE sources SET large_staff = ?, size_reviewed_at = ? WHERE id = ?', bit(large), d.createdAt, d.sourceRef);
		}
		closeReports(db, d.sourceRef, d.verdict === 'none' ? '' : d.verdict, d.reason, d.createdAt);
		db.run(
			'UPDATE escalations SET resolved_at = ? WHERE source_id = ? AND item_id IS NULL AND resolved_at IS NULL',
			d.createdAt,
			d.sourceRef
		);
		return id;
	});
}

/**
 * Ends the curator decisions on a source itself made at or after since, so a denied appeal never
 * restores a curator verdict set while the appeal was open. reviewed_at falls back to the latest
 * decision still standing.
 */
export function voidCuratorDecisions(db: Db, sourceRef: number, since: number, now: number): void {
	db.tx(() => {
		const n = db.run(
			`UPDATE decisions SET expires_at = created_at WHERE source_id = ? AND item_id IS NULL
			AND actor = 'curator' AND created_at >= ? AND expires_at > ?`,
			sourceRef,
			since,
			now
		);
		if (n === 0) return;
		db.run(
			`UPDATE sources SET reviewed_at = (SELECT max(created_at) FROM decisions
			WHERE source_id = ? AND item_id IS NULL AND expires_at > created_at) WHERE id = ?`,
			sourceRef,
			sourceRef
		);
	});
}

/** Lists the latest decision per target of a source, active or not. */
export function latestDecisions(db: Db, sourceRef: number): Decision[] {
	return decisions(db, 'id IN (SELECT max(id) FROM decisions WHERE source_id = ? GROUP BY ifnull(item_id, 0))', sourceRef);
}

/** An open item in the review queue raised by scoring. */
export interface Escalation {
	id: number;
	sourceRef: number;
	itemRef: number;
	/** capped | lapsed | reports | burst | appeal */
	kind: string;
	summary: string;
	createdAt: number;
}

/** Makes the open escalations of kinds in managed, on one target, match want (kind to summary). */
export function syncEscalations(
	db: Db,
	sourceRef: number,
	itemRef: number,
	managed: string[],
	want: Record<string, string>,
	now: number
): void {
	db.tx(() => {
		const open = db
			.all<{ kind: string }>(
				'SELECT kind FROM escalations WHERE source_id = ? AND ifnull(item_id, 0) = ? AND resolved_at IS NULL',
				sourceRef,
				itemRef
			)
			.map((r) => r.kind);
		for (const [k, summary] of Object.entries(want)) {
			if (open.includes(k)) continue;
			db.run(
				`INSERT OR IGNORE INTO escalations (source_id, item_id, kind, summary, created_at)
				VALUES (?, ?, ?, ?, ?)`,
				sourceRef,
				nullInt(itemRef),
				k,
				summary,
				now
			);
		}
		for (const k of open) {
			if (Object.hasOwn(want, k) || !managed.includes(k)) continue;
			db.run(
				`UPDATE escalations SET resolved_at = ? WHERE source_id = ? AND ifnull(item_id, 0) = ?
				AND kind = ? AND resolved_at IS NULL`,
				now,
				sourceRef,
				itemRef,
				k
			);
		}
	});
}

/** Lists unresolved escalations, oldest first. */
export function openEscalations(db: Db): Escalation[] {
	return db
		.all<{ id: number; source_id: number; item_id: number; kind: string; summary: string; created_at: number }>(
			`SELECT id, source_id, ifnull(item_id, 0) AS item_id, kind, summary, created_at
			FROM escalations WHERE resolved_at IS NULL ORDER BY created_at, id`
		)
		.map((r) => ({ id: r.id, sourceRef: r.source_id, itemRef: r.item_id, kind: r.kind, summary: r.summary, createdAt: r.created_at }));
}
