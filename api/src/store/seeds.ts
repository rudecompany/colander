// Seed list entries in the Store (docs/contracts.md 9.3 and 14): the registry as this Worker uses
// it, the entries each import leaves, expiry, revocation, suppression and the cleanup of sources
// that exist only because a list named them. An entry is a review lead for staff and never
// evidence: nothing here feeds a scoring layer, and nothing here reaches a public response.
import { REGISTRY } from '@colander/shared/seed-registry';
import { datasetNames, upstreamUnix, usable, type SeedEntry } from '@colander/shared/seeds';
import { redactSeedNames } from './compliance';
import { nullString, type Db } from './db';
import { ensureSource, findSource } from './sources';

const DAY = 86_400;

/** The registry this Worker reads, with dev mode deciding whether dev_only entries count. */
export class SeedRegistry {
	private readonly byId: Map<string, SeedEntry>;
	/** usable entries whose entries are review leads: use lead or seed */
	private readonly leadIds: Set<string>;

	constructor(
		readonly entries: readonly SeedEntry[] = REGISTRY,
		readonly dev = false
	) {
		this.byId = new Map(entries.map((e) => [e.id, e]));
		this.leadIds = new Set(entries.filter((e) => e.use !== 'frame' && usable(e, dev)).map((e) => e.id));
	}

	get(id: string): SeedEntry | undefined {
		return this.byId.get(id);
	}

	/** The entry when its entries are review leads now, or undefined. */
	lead(id: string): SeedEntry | undefined {
		return this.leadIds.has(id) ? this.byId.get(id) : undefined;
	}

	/** Every name a public text may never contain: each dataset's datasetNames. */
	names(): string[] {
		return this.entries.flatMap(datasetNames);
	}

	/**
	 * Whether data from the entry may no longer be used at all: it left the registry, or it is not
	 * usable (refused, revoked, or no longer cleared). An expired entry is not withdrawn.
	 */
	withdrawn(id: string): boolean {
		const e = this.byId.get(id);
		return !e || !usable(e, this.dev);
	}
}

/** One platform ID a list file names. */
export type Alias = {
	platform: string;
	alias: string;
	/** for Colander's own lists, where staff saw it; staff only */
	note?: string;
};

/** A seed entry that puts its source in the review queue now. */
export type SeedLead = Omit<Alias, 'note'> & {
	entry: SeedEntry;
	batch: number;
	/** the upstream date of the batch that last listed it, unix seconds */
	listedAt: number;
	importedAt: number;
	/** when it stops being a lead, unix seconds */
	expiresAt: number;
	/** where staff saw it, for Colander's own lists */
	note: string | null;
};

const expiry = (e: SeedEntry, listedAt: number): number => listedAt + e.expires_after_days * DAY;

/** The entries on a source that are review leads at now (unix seconds): cleared, a lead or seed list, not expired. */
export function seedLeads(db: Db, reg: SeedRegistry, ref: number, now: number): SeedLead[] {
	const out: SeedLead[] = [];
	for (const r of db.all<{ seed: string; platform: string; alias: string; batch: number; listed_at: number; imported_at: number; note: string | null }>(
		`SELECT e.seed, e.platform, e.alias, e.batch, e.listed_at, b.imported_at, e.note FROM seed_entries e JOIN seed_imports b ON b.id = e.batch
		WHERE e.source_id = ? ORDER BY e.seed, e.platform, e.alias`,
		ref
	)) {
		const entry = reg.lead(r.seed);
		if (!entry || expiry(entry, r.listed_at) <= now) continue;
		out.push({
			platform: r.platform,
			alias: r.alias,
			entry,
			batch: r.batch,
			listedAt: r.listed_at,
			importedAt: r.imported_at,
			expiresAt: expiry(entry, r.listed_at),
			note: r.note
		});
	}
	return out;
}

/**
 * For the review queue, in one read: per source with live leads, how many lists name it and
 * whether a calibrated seed list names it by a channel ID (a handle can change hands).
 */
export function leadSummaries(db: Db, reg: SeedRegistry, now: number): Map<number, { lists: number; calibrated: boolean }> {
	const out = new Map<number, { lists: number; calibrated: boolean }>();
	const seen = new Map<number, Set<string>>();
	for (const r of db.all<{ source_id: number; seed: string; platform: string; alias: string; listed_at: number }>(
		'SELECT source_id, seed, platform, alias, listed_at FROM seed_entries'
	)) {
		const entry = reg.lead(r.seed);
		if (!entry || expiry(entry, r.listed_at) <= now) continue;
		const lists = seen.get(r.source_id) ?? new Set();
		lists.add(r.seed);
		seen.set(r.source_id, lists);
		const s = out.get(r.source_id) ?? { lists: 0, calibrated: false };
		s.lists = lists.size;
		s.calibrated ||= entry.use === 'seed' && r.platform === 'yt' && r.alias.startsWith('UC');
		out.set(r.source_id, s);
	}
	return out;
}

/** What an import changes, before anything is written. */
export interface ImportPlan {
	added: Alias[];
	kept: Alias[];
	/** listed before, not any more */
	dropped: Alias[];
	/** sources staff suppressed (an objection or an upheld case): never imported again */
	suppressed: Alias[];
}

const key = (a: Alias): string => `${a.platform}:${a.alias}`;

/** Compares a file's aliases with what the seed holds now. Writes nothing. */
export function planImport(db: Db, seed: string, aliases: Alias[]): ImportPlan {
	const current = new Map(db.all<Alias>('SELECT platform, alias FROM seed_entries WHERE seed = ?', seed).map((a) => [key(a), a]));
	const plan: ImportPlan = { added: [], kept: [], dropped: [], suppressed: [] };
	const listed = new Set<string>();
	for (const a of aliases) {
		if (listed.has(key(a))) continue;
		listed.add(key(a));
		const ref = findSource(db, a.platform, a.alias);
		if (ref !== undefined && db.get('SELECT 1 FROM sources WHERE id = ? AND seed_suppressed_at IS NOT NULL', ref)) plan.suppressed.push(a);
		else if (current.has(key(a))) plan.kept.push(a);
		else plan.added.push(a);
	}
	for (const [k, a] of current) if (!listed.has(k)) plan.dropped.push(a);
	return plan;
}

/** The import run as seed_imports records it. */
export interface Batch {
	sha256: string;
	entries: number;
	/** the private clearance records the bucket object held (DPIA, LIA, grant), staff only */
	records: Record<string, string>;
	/** unix seconds of the upstream date, or the import time when the entry has none */
	listedAt: number;
}

/**
 * Applies a plan in one transaction: records the batch, lists the added and kept aliases under it
 * (creating sources as needed), deletes the dropped ones and the sources that existed only for
 * them, and takes the list's name out of the public log. Returns the batch ID and every source
 * whose leads changed, for the caller to rescore.
 */
export function applyImport(db: Db, entry: SeedEntry, plan: ImportPlan, b: Batch, now: number): { batch: number; refs: number[] } {
	return db.tx(() => {
		const batch = db.get<{ id: number }>(
			`INSERT INTO seed_imports (seed, source_name, list, license, attribution, permission_doc, sha256, entries, imported_at, listed_at, added, dropped, records)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			entry.id,
			entry.name,
			entry.use,
			entry.license,
			entry.attribution,
			nullString(b.records.permission_doc ?? ''),
			b.sha256,
			b.entries,
			now,
			b.listedAt,
			plan.added.length,
			plan.dropped.length,
			JSON.stringify(b.records)
		)!.id;
		const refs: number[] = [];
		for (const a of [...plan.added, ...plan.kept]) {
			const ref = ensureSource(db, a.platform, a.alias, '', now);
			db.run(
				`INSERT INTO seed_entries (seed, platform, alias, source_id, batch, listed_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (seed, platform, alias) DO UPDATE SET source_id = excluded.source_id, batch = excluded.batch, listed_at = excluded.listed_at, note = excluded.note`,
				entry.id,
				a.platform,
				a.alias,
				ref,
				batch,
				b.listedAt,
				nullString(a.note ?? '')
			);
			refs.push(ref);
		}
		const gone: number[] = [];
		for (const a of plan.dropped) {
			const r = db.get<{ source_id: number }>('DELETE FROM seed_entries WHERE seed = ? AND platform = ? AND alias = ? RETURNING source_id', entry.id, a.platform, a.alias);
			if (r) gone.push(r.source_id);
		}
		deleteOrphans(db, gone);
		// A reviewer may have named the list before Colander imported it, by any of its names.
		redactSeedNames(db, datasetNames(entry));
		return { batch, refs: [...refs, ...gone] };
	});
}

/** The upstream date of an entry's file as unix seconds, or now for an entry without one (dev data). */
export const listedAt = (e: SeedEntry, now: number): number => upstreamUnix(e) ?? now;

/**
 * Deletes the calibration items sampled from a registry entry, under seed:<id> or random:<id>, with
 * their labels. Returns their sources.
 */
function dropSampled(db: Db, seed: string): number[] {
	return db.all<{ source_id: number }>('DELETE FROM calibration_items WHERE frame IN (?, ?) RETURNING source_id', `seed:${seed}`, `random:${seed}`).map((r) => r.source_id);
}

/**
 * `revoke-seed`: deletes every entry of a seed at once, and every calibration item sampled from it
 * as a lead list or a frame, and marks its batches revoked, for when its license or clearance falls
 * away. Returns the entries and items deleted and the sources they were on.
 */
export function revokeSeed(db: Db, seed: string, reason: string, now: number): { entries: number; sampled: number; refs: number[] } {
	return db.tx(() => {
		const rows = db.all<{ source_id: number }>('DELETE FROM seed_entries WHERE seed = ? RETURNING source_id', seed);
		const sampled = dropSampled(db, seed);
		db.run('UPDATE seed_imports SET revoked_at = ?, revoke_reason = ? WHERE seed = ? AND revoked_at IS NULL', now, reason, seed);
		const refs = [...new Set([...rows.map((r) => r.source_id), ...sampled])];
		deleteOrphans(db, refs);
		return { entries: rows.length, sampled: sampled.length, refs };
	});
}

/**
 * The daily seeds job's cleanup: deletes the entries that are no review lead any more (expired, or
 * their registry entry is not cleared, is no lead or seed list, or is gone after a deploy), the
 * calibration items sampled from a withdrawn entry (refused, revoked or gone, as opposed to
 * expired), and the sources that existed only for them. Returns the sources whose leads changed.
 */
export function expireSeeds(db: Db, reg: SeedRegistry, now: number): number[] {
	return db.tx(() => {
		const refs: number[] = [];
		for (const { seed } of db.all<{ seed: string }>('SELECT DISTINCT seed FROM seed_entries')) {
			const entry = reg.lead(seed);
			const rows = entry
				? db.all<{ source_id: number }>('DELETE FROM seed_entries WHERE seed = ? AND listed_at + ? <= ? RETURNING source_id', seed, entry.expires_after_days * DAY, now)
				: db.all<{ source_id: number }>('DELETE FROM seed_entries WHERE seed = ? RETURNING source_id', seed);
			for (const r of rows) refs.push(r.source_id);
		}
		const gone: number[] = [];
		for (const { seed } of db.all<{ seed: string }>(
			"SELECT DISTINCT substr(frame, instr(frame, ':') + 1) AS seed FROM calibration_items WHERE frame LIKE 'seed:%' OR frame LIKE 'random:%'"
		)) {
			if (reg.withdrawn(seed)) gone.push(...dropSampled(db, seed));
		}
		const unique = [...new Set(refs)];
		deleteOrphans(db, [...unique, ...gone]);
		return unique;
	});
}

/**
 * Deletes those of refs that exist only because a list named them: no verdict, tags, reports,
 * appeals, decisions, items, log rows, list entries, seed entries or calibration item, and no
 * suppression to remember. Their aliases and escalations go with them.
 */
export function deleteOrphans(db: Db, refs: number[]): void {
	if (refs.length === 0) return;
	db.run(
		`DELETE FROM sources WHERE id IN (SELECT value FROM json_each(?))
		AND verdict IS NULL AND seed_suppressed_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM seed_entries WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM calibration_items WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM tags WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM reports WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM appeals WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM decisions WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM items WHERE source_id = sources.id)
		AND NOT EXISTS (SELECT 1 FROM decision_log WHERE source_id = sources.id)`,
		JSON.stringify(refs)
	);
}

/**
 * Suppresses seed lists on a source (an objection under GDPR Article 21, or a case staff closed):
 * its entries and its calibration item go, no import lists it again, and no sampling picks it.
 * Lifting it lets the next import list the source again.
 */
export function setSeedSuppression(db: Db, ref: number, suppress: boolean, reason: string, now: number): void {
	db.tx(() => {
		if (suppress) {
			db.run('UPDATE sources SET seed_suppressed_at = ?, seed_suppress_reason = ? WHERE id = ?', now, reason, ref);
			db.run('DELETE FROM seed_entries WHERE source_id = ?', ref);
			db.run('DELETE FROM calibration_items WHERE source_id = ?', ref);
		} else {
			db.run('UPDATE sources SET seed_suppressed_at = NULL, seed_suppress_reason = ? WHERE id = ?', `Lifted: ${reason}`, ref);
		}
	});
}

/** The name of the registry dataset a text names by any of its datasetNames, case-insensitively, or undefined. */
export function namedDataset(reg: SeedRegistry, text: string): string | undefined {
	const t = text.toLowerCase();
	return reg.entries.find((e) => datasetNames(e).some((n) => t.includes(n.toLowerCase())))?.name;
}

/** Staff reads of seed provenance are kept as long as the calibration rows: 24 months. */
export const PROVENANCE_READ_RETENTION = 730 * DAY;

/**
 * Records that a staff account read which seed lists name a source (seed list review 30). Staff
 * only, never in a response; the daily seeds job deletes rows after 24 months.
 */
export function recordProvenanceRead(db: Db, accountId: string, platform: string, source: string, seeds: string[], now: number): void {
	db.run('INSERT INTO seed_provenance_reads (account_id, platform, source, seeds, read_at) VALUES (?, ?, ?, ?, ?)', accountId, platform, source, JSON.stringify(seeds), now);
}

/** Deletes provenance reads older than 24 months. Returns how many went. */
export function pruneProvenanceReads(db: Db, now: number): number {
	return db.run('DELETE FROM seed_provenance_reads WHERE read_at < ?', now - PROVENANCE_READ_RETENTION);
}

/** The sources a seed's live entries name, for calibration sampling: not suppressed, not sampled yet. */
export function seedSources(db: Db, seed: string): number[] {
	return db
		.all<{ source_id: number }>(
			`SELECT DISTINCT e.source_id FROM seed_entries e JOIN sources s ON s.id = e.source_id
			WHERE e.seed = ? AND s.seed_suppressed_at IS NULL
			AND NOT EXISTS (SELECT 1 FROM calibration_items c WHERE c.source_id = e.source_id) ORDER BY e.source_id`,
			seed
		)
		.map((r) => r.source_id);
}

/** Creates a source for each alias of a calibration frame, skipping suppressed ones. Returns their refs. */
export function frameSources(db: Db, aliases: Alias[], now: number): number[] {
	return db.tx(() => {
		const refs: number[] = [];
		for (const a of aliases) {
			const known = findSource(db, a.platform, a.alias);
			if (known !== undefined && db.get('SELECT 1 FROM sources WHERE id = ? AND seed_suppressed_at IS NOT NULL', known)) continue;
			refs.push(known ?? ensureSource(db, a.platform, a.alias, '', now));
		}
		return refs;
	});
}
