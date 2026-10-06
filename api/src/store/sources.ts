// Sources, aliases and items (Go's store/sources.go).
import { lowerSimple } from '@colander/shared/ids';
import { nullString, type Db } from './db';

/** The current list state of a source or item. */
export interface State {
	/** "" when not rated */
	verdict: string;
	signals: number;
	/** slop type code and test bits, as in a list entry */
	detail: number;
	/** list flag bits for large and staff reviewed */
	flags: number;
	changedAt: number;
	rescoreAt: number;
	lapseHold: boolean;
	computed: string;
	/** sources only: the source is mixed, so its items keep their own list entries */
	mixed: boolean;
}

/**
 * A channel, profile or page. The source with an empty canonical ID on a platform holds the items
 * tagged where the card does not show their source; it is never rated and nothing rolls up to it
 * (contracts 6.2).
 */
export interface Source {
	ref: number;
	platform: string;
	canonicalId: string;
	name: string;
	aliases: string[];
	reviewedAt: number;
	largeStaff: boolean;
	/** when staff last recorded the source's size, 0 when never */
	sizeReviewedAt: number;
	/** when Colander last looked the channel up, found or not */
	youtubeCheckedAt: number;
	frozenUntil: number;
	/** when staff suppressed seed lists on it (src/store/seeds.ts), 0 when not */
	seedSuppressedAt: number;
	seedSuppressReason: string;
	state: State;
	createdAt: number;
}

/** A video, Short, Reel or image post. */
export interface Item {
	ref: number;
	platform: string;
	itemId: string;
	sourceRef: number;
	state: State;
	createdAt: number;
}

type StateRow = {
	verdict: string;
	signals: number;
	detail: number;
	flags: number;
	changed_at: number;
	rescore_at: number;
	lapse_hold: number;
	computed: string;
};

type SourceRow = StateRow & {
	id: number;
	platform: string;
	canonical_id: string;
	name: string;
	reviewed_at: number;
	large_staff: number;
	size_reviewed_at: number;
	youtube_checked_at: number;
	frozen_until: number;
	seed_suppressed_at: number;
	seed_suppress_reason: string;
	mixed: number;
	created_at: number;
};

type ItemRow = StateRow & { id: number; platform: string; item_id: string; source_id: number; created_at: number };

// No YouTube Data API figure is read: they never feed scoring (contracts 9.7).
// The import_* columns of imports from before the seed registry stay unread (migration 0008).
const sourceCols = `id, platform, canonical_id, ifnull(name, '') AS name, ifnull(reviewed_at, 0) AS reviewed_at, large_staff,
	ifnull(size_reviewed_at, 0) AS size_reviewed_at,
	ifnull(youtube_checked_at, 0) AS youtube_checked_at, ifnull(frozen_until, 0) AS frozen_until,
	ifnull(seed_suppressed_at, 0) AS seed_suppressed_at, ifnull(seed_suppress_reason, '') AS seed_suppress_reason,
	ifnull(verdict, '') AS verdict, signals, detail, flags, ifnull(changed_at, 0) AS changed_at,
	ifnull(rescore_at, 0) AS rescore_at, lapse_hold, ifnull(computed, '') AS computed, mixed, created_at`;

const itemCols = `id, platform, item_id, source_id, ifnull(verdict, '') AS verdict, signals, detail, flags,
	ifnull(changed_at, 0) AS changed_at, ifnull(rescore_at, 0) AS rescore_at, lapse_hold,
	ifnull(computed, '') AS computed, created_at`;

function scanState(r: StateRow, mixed: number): State {
	return {
		verdict: r.verdict,
		signals: r.signals,
		detail: r.detail,
		flags: r.flags,
		changedAt: r.changed_at,
		rescoreAt: r.rescore_at,
		lapseHold: r.lapse_hold !== 0,
		computed: r.computed,
		mixed: mixed !== 0
	};
}

function scanSource(r: SourceRow): Source {
	return {
		ref: r.id,
		platform: r.platform,
		canonicalId: r.canonical_id,
		name: r.name,
		aliases: [],
		reviewedAt: r.reviewed_at,
		largeStaff: r.large_staff !== 0,
		sizeReviewedAt: r.size_reviewed_at,
		youtubeCheckedAt: r.youtube_checked_at,
		frozenUntil: r.frozen_until,
		seedSuppressedAt: r.seed_suppressed_at,
		seedSuppressReason: r.seed_suppress_reason,
		state: scanState(r, r.mixed),
		createdAt: r.created_at
	};
}

function scanItem(r: ItemRow): Item {
	return { ref: r.id, platform: r.platform, itemId: r.item_id, sourceRef: r.source_id, state: scanState(r, 0), createdAt: r.created_at };
}

/** Returns the source ref that owns alias on platform. */
export function findSource(db: Db, platform: string, alias: string): number | undefined {
	return db.get<{ source_id: number }>('SELECT source_id FROM source_aliases WHERE platform = ? AND alias = ?', platform, alias)?.source_id;
}

/** Returns the source owning alias, creating it when unknown. A non-empty name fills a missing one. */
export function ensureSource(db: Db, platform: string, alias: string, name: string, now: number): number {
	return db.tx(() => {
		const ref = findSource(db, platform, alias);
		if (ref === undefined) {
			const { id } = db.get<{ id: number }>(
				'INSERT INTO sources (platform, canonical_id, name, created_at) VALUES (?, ?, ?, ?) RETURNING id',
				platform,
				alias,
				nullString(name),
				now
			)!;
			db.run('INSERT INTO source_aliases (platform, alias, source_id) VALUES (?, ?, ?)', platform, alias, id);
			return id;
		}
		if (name !== '') db.run('UPDATE sources SET name = ? WHERE id = ? AND name IS NULL', name, ref);
		return ref;
	});
}

/** Loads a source with its aliases, the canonical ID first. */
export function getSource(db: Db, ref: number): Source | undefined {
	const row = db.get<SourceRow>(`SELECT ${sourceCols} FROM sources WHERE id = ?`, ref);
	if (!row) return undefined;
	const src = scanSource(row);
	src.aliases = db.all<{ alias: string }>('SELECT alias FROM source_aliases WHERE source_id = ? ORDER BY alias', ref).map((r) => r.alias);
	// The canonical ID leads the alias list.
	const i = src.aliases.indexOf(src.canonicalId);
	if (i > 0) [src.aliases[0], src.aliases[i]] = [src.aliases[i]!, src.aliases[0]!];
	return src;
}

/**
 * Whether the public may know of the source: it has a verdict, or tags, reports, appeals,
 * decisions, items or log rows. A source that only seed lists or the calibration set brought in
 * has none, and public responses treat it as unknown.
 */
export function hasPublicRecord(db: Db, ref: number): boolean {
	return (
		db.get(
			`SELECT 1 FROM sources s WHERE s.id = ? AND (s.verdict IS NOT NULL
			OR EXISTS (SELECT 1 FROM tags WHERE source_id = s.id) OR EXISTS (SELECT 1 FROM reports WHERE source_id = s.id)
			OR EXISTS (SELECT 1 FROM appeals WHERE source_id = s.id) OR EXISTS (SELECT 1 FROM decisions WHERE source_id = s.id)
			OR EXISTS (SELECT 1 FROM items WHERE source_id = s.id) OR EXISTS (SELECT 1 FROM decision_log WHERE source_id = s.id))`,
			ref
		) !== undefined
	);
}

/** Lists every source ref, oldest first. */
export function sourceRefs(db: Db): number[] {
	return db.all<{ id: number }>('SELECT id FROM sources ORDER BY id').map((r) => r.id);
}

/** The next refs after `after`, oldest first: one chunk of a full scoring pass. */
export function sourceRefsAfter(db: Db, after: number, limit: number): number[] {
	return db.all<{ id: number }>('SELECT id FROM sources WHERE id > ? ORDER BY id LIMIT ?', after, limit).map((r) => r.id);
}

/**
 * Returns the item, creating it under sourceRef when unknown. An item keeps its first source,
 * except that an item first seen without one joins the first source a later tag names.
 */
export function ensureItem(db: Db, platform: string, itemId: string, sourceRef: number, now: number): number {
	return db.tx(() => {
		const cur = db.get<{ id: number; source_id: number; unattributed: number }>(
			`SELECT i.id, i.source_id, s.canonical_id = '' AS unattributed FROM items i JOIN sources s ON s.id = i.source_id
			WHERE i.platform = ? AND i.item_id = ?`,
			platform,
			itemId
		);
		if (cur) {
			if (cur.unattributed && cur.source_id !== sourceRef) {
				for (const stmt of [
					'UPDATE items SET source_id = ? WHERE id = ?',
					'UPDATE tags SET source_id = ? WHERE item_id = ?',
					'UPDATE decisions SET source_id = ? WHERE item_id = ?',
					'UPDATE OR IGNORE escalations SET source_id = ? WHERE item_id = ?'
				]) {
					db.run(stmt, sourceRef, cur.id);
				}
			}
			return cur.id;
		}
		return db.get<{ id: number }>(
			'INSERT INTO items (platform, item_id, source_id, created_at) VALUES (?, ?, ?, ?) RETURNING id',
			platform,
			itemId,
			sourceRef,
			now
		)!.id;
	});
}

/** Looks an item up by its platform ID. */
export function findItem(db: Db, platform: string, itemId: string): Item | undefined {
	const row = db.get<ItemRow>(`SELECT ${itemCols} FROM items WHERE platform = ? AND item_id = ?`, platform, itemId);
	return row && scanItem(row);
}

/** Lists a source's items, oldest first. */
export function itemsBySource(db: Db, sourceRef: number): Item[] {
	return db.all<ItemRow>(`SELECT ${itemCols} FROM items WHERE source_id = ? ORDER BY id`, sourceRef).map(scanItem);
}

/** Moves everything from drop onto keep and deletes drop. Runs inside the caller's tx. */
function mergeSources(db: Db, keep: number, drop: number): void {
	for (const stmt of [
		'UPDATE source_aliases SET source_id = ? WHERE source_id = ?',
		'UPDATE items SET source_id = ? WHERE source_id = ?',
		'UPDATE tags SET source_id = ? WHERE source_id = ?',
		'UPDATE reports SET source_id = ? WHERE source_id = ?',
		'UPDATE appeals SET source_id = ? WHERE source_id = ?',
		'UPDATE decisions SET source_id = ? WHERE source_id = ?',
		'UPDATE decision_log SET source_id = ? WHERE source_id = ?',
		'UPDATE OR IGNORE escalations SET source_id = ? WHERE source_id = ?',
		'UPDATE seed_entries SET source_id = ? WHERE source_id = ?',
		// Items first, so moved labels find theirs; whatever stays on drop goes with it.
		'UPDATE OR IGNORE calibration_items SET source_id = ? WHERE source_id = ?',
		'UPDATE OR IGNORE calibration_labels SET source_id = ? WHERE source_id = ?'
	]) {
		db.run(stmt, keep, drop);
	}
	db.run(
		`UPDATE sources SET
		name = coalesce(sources.name, d.name),
		import_list = CASE WHEN 'blocklist' IN (sources.import_list, d.import_list) THEN 'blocklist'
			ELSE coalesce(sources.import_list, d.import_list) END,
		import_source = coalesce(sources.import_source, d.import_source),
		import_license = coalesce(sources.import_license, d.import_license),
		imported_at = coalesce(sources.imported_at, d.imported_at),
		import_batch = coalesce(sources.import_batch, d.import_batch),
		reviewed_at = max(ifnull(sources.reviewed_at, 0), ifnull(d.reviewed_at, 0)),
		large_staff = max(sources.large_staff, d.large_staff),
		size_reviewed_at = max(ifnull(sources.size_reviewed_at, 0), ifnull(d.size_reviewed_at, 0)),
		frozen_until = max(ifnull(sources.frozen_until, 0), ifnull(d.frozen_until, 0)),
		seed_suppressed_at = coalesce(sources.seed_suppressed_at, d.seed_suppressed_at),
		seed_suppress_reason = CASE WHEN sources.seed_suppressed_at IS NULL THEN d.seed_suppress_reason ELSE sources.seed_suppress_reason END
		FROM (SELECT * FROM sources WHERE id = ?) AS d WHERE sources.id = ?`,
		drop,
		keep
	);
	db.run('DELETE FROM sources WHERE id = ?', drop);
	// A suppression on either half holds for the whole channel.
	db.run('DELETE FROM seed_entries WHERE source_id = ? AND EXISTS (SELECT 1 FROM sources WHERE id = ? AND seed_suppressed_at IS NOT NULL)', keep, keep);
}

/** What the YouTube Data API told us about a channel. The title is never kept: names come from reports. */
export interface YouTubeInfo {
	channelId: string;
	/** with @, lowercased, or "" */
	handle: string;
}

/**
 * Records a lookup for ref: adds the channel ID and handle as aliases and merges any other source
 * that already owned one of them. Returns the ref that survives.
 */
export function setYouTube(db: Db, ref: number, info: YouTubeInfo, now: number): number {
	return db.tx(() => {
		let keep = ref;
		for (const alias of [info.channelId, lowerSimple(info.handle)]) {
			if (alias === '') continue;
			const owner = findSource(db, 'yt', alias);
			if (owner === undefined) {
				db.run("INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', ?, ?)", alias, keep);
			} else if (owner !== keep) {
				// The older source keeps its history; the newer one folds into it.
				const [k, d] = [Math.min(owner, keep), Math.max(owner, keep)];
				mergeSources(db, k, d);
				keep = k;
			}
		}
		db.run('UPDATE sources SET canonical_id = ?, youtube_checked_at = ? WHERE id = ?', info.channelId, now, keep);
		return keep;
	});
}

/** Records a lookup that found nothing, so it is not retried before the cache expires. */
export function markYouTubeChecked(db: Db, ref: number, now: number): void {
	db.run('UPDATE sources SET youtube_checked_at = ? WHERE id = ?', now, ref);
}

/** Lists YouTube sources not checked since before, oldest first. */
export function youTubeStale(db: Db, before: number, limit: number): Source[] {
	const refs = db
		.all<{ id: number }>(
			`SELECT id FROM sources WHERE platform = 'yt' AND canonical_id != ''
			AND ifnull(youtube_checked_at, 0) < ? ORDER BY ifnull(youtube_checked_at, 0), id LIMIT ?`,
			before,
			limit
		)
		.map((r) => r.id);
	return refs.map((r) => getSource(db, r)!);
}

/**
 * The seed list a text names, case-insensitively, or undefined: public text must never name one.
 * seed_imports holds every list Colander imported, cleared imports from before the license check too.
 */
export function namedSeedList(db: Db, text: string): string | undefined {
	return db.get<{ name: string }>(
		`SELECT source_name AS name FROM seed_imports WHERE source_name != '' AND instr(lower(?), lower(source_name)) > 0 LIMIT 1`,
		text
	)?.name;
}

/** Freezes a source's consensus layer until the given time. */
export function setFrozen(db: Db, ref: number, until: number): void {
	db.run('UPDATE sources SET frozen_until = ? WHERE id = ?', until, ref);
}
