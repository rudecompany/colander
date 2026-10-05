// The seed list ops commands (docs/deploy.md, "The ops channel"; docs/contracts.md section 14):
// import-seed, revoke-seed, calibration-sample and calibration-export, and the parsers for the
// list formats the registry names. The ops run log is public: arguments name a registry entry,
// which the public registry lists anyway, and answers carry counts only, never a channel.
import { hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { INTERNAL, validateEntry, type SeedEntry } from '@colander/shared/seeds';
import { canonicalSource } from './routes/ids';
import { runeCount, trimSpace } from './routes/respond';
import { unix } from './scoring/engine';
import { addCalibrationItems, communitySources, exportCalibration, sampled } from './store/calibration';
import { findSource } from './store/sources';
import { applyImport, frameSources, listedAt, planImport, revokeSeed, seedSources, type Alias } from './store/seeds';
import type { Store } from './store/store';

/** A command's answer, as src/ops.ts sends it. */
interface Answer {
	status: number;
	body: Record<string, unknown>;
}
type Args = Record<string, unknown>;

const ok = (body: Record<string, unknown>): Answer => ({ status: 200, body });
const fail = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const only = (a: Args, ...keys: string[]) => Object.keys(a).every((k) => keys.includes(k));

/** List files and frames live in the private backup bucket under this prefix, one object per registry entry. */
export const SEED_PREFIX = 'seeds/';
export const seedKey = (id: string): string => `${SEED_PREFIX}${id}.json`;

/** What a list file holds, read by the entry's format. */
export interface Parsed {
	aliases: Alias[];
	/** lines or records that name no valid ID, and lines of Colander's own lists without a note */
	skipped: number;
	/**
	 * records the format leaves out on purpose: Soul Over AI's AI-assisted and removed artists, and
	 * uBlock Origin rules that name a channel only by handle
	 */
	excluded: number;
}

/** A handle in a uBlock Origin or Adblock Plus rule: after a quote, a slash or an equals sign. */
const RULE_HANDLE = /["'/=]@[^\s"'/?\])\\,|]+/;

/**
 * Reads a list file by the entry's format, keeping only the entry's platforms:
 * - lines: one ID per line, for the entry's one platform; `!` and `#` start comment lines. For
 *   Colander's own lists the ID needs a note after it of where staff saw it (seed list review 18),
 *   kept for staff; a line without one is skipped. Other lists' notes are ignored.
 * - ubo: uBlock Origin or Adblock Plus rules; every YouTube channel ID in a rule is an entry. A rule
 *   that names a channel only by handle is excluded, since a handle can pass to another owner (seed
 *   list review 9); `[Adblock Plus 2.0]` style headers are comments.
 * - soul-over-ai: Soul Over AI's artist JSON array; only artists whose own disclosure says fully
 *   AI-generated, not removed (seed list review 8).
 */
export function parseSeed(entry: SeedEntry, file: string): Parsed {
	const out: Parsed = { aliases: [], skipped: 0, excluded: 0 };
	const add = (platform: string, raw: string, note?: string): boolean => {
		const alias = entry.platforms.includes(platform as never) ? canonicalSource(platform, raw) : undefined;
		if (alias !== undefined) out.aliases.push(note === undefined ? { platform, alias } : { platform, alias, note });
		return alias !== undefined;
	};
	const ownList = entry.license === INTERNAL;
	if (entry.format === 'soul-over-ai') {
		let artists: unknown;
		try {
			artists = JSON.parse(file);
		} catch {
			throw new Error('the file is not JSON');
		}
		if (!Array.isArray(artists)) throw new Error('the file is not a JSON array of artists');
		for (const a of artists as Record<string, unknown>[]) {
			if (typeof a !== 'object' || a === null) {
				out.skipped++;
				continue;
			}
			if (a.removed === true || a.disclosure !== 'full') {
				out.excluded++;
				continue;
			}
			const ids = { yt: a.youtube, tt: a.tiktok, ig: a.instagram } as Record<string, unknown>;
			const named = entry.platforms.filter((p) => typeof ids[p] === 'string');
			if (named.map((p) => add(p, ids[p] as string)).filter(Boolean).length === 0) out.skipped++;
		}
		return out;
	}
	for (const raw of file.split('\n')) {
		const line = trimSpace(raw);
		if (line === '' || line.startsWith('!') || line.startsWith('#')) continue;
		if (entry.format === 'lines') {
			const id = line.split(/\s/, 1)[0]!;
			const note = [...trimSpace(line.slice(id.length))].slice(0, 500).join('');
			if (ownList && note === '') out.skipped++;
			else if (!add(entry.platforms[0]!, id, ownList ? note : undefined)) out.skipped++;
			continue;
		}
		if (line.startsWith('[')) continue; // [Adblock Plus 2.0]
		const ids = [...line.matchAll(/UC[\w-]{22}/g)].map((m) => m[0]);
		if (ids.length === 0) {
			if (RULE_HANDLE.test(line)) out.excluded++;
			else out.skipped++;
		} else if (ids.map((t) => add('yt', t)).filter(Boolean).length === 0) out.skipped++;
	}
	return out;
}

/** Reads and checks the private object of an entry: its file must match the registry's hash. */
async function seedObject(env: Env, entry: SeedEntry): Promise<{ file: string; records: Record<string, string> } | Answer> {
	const key = seedKey(entry.id);
	const obj = await env.BACKUPS.get(key);
	if (!obj) return fail(404, 'no_seed_object', `There is no object ${key} in the backup bucket. Put the file there first (docs/deploy.md, "Import a seed list").`);
	const o = await obj.json<unknown>().catch(() => undefined);
	if (typeof o !== 'object' || o === null || typeof (o as { file?: unknown }).file !== 'string') {
		return fail(400, 'invalid_seed_object', `${key} must hold a JSON object with the list text in file.`);
	}
	const file = (o as { file: string }).file;
	if (entry.sha256 !== null && hex(sha256(utf8(file))) !== entry.sha256) {
		return fail(409, 'seed_hash_mismatch', `The file in ${key} is not the one the registry cleared: its SHA-256 differs from the registry's.`);
	}
	const raw = (o as { records?: unknown }).records;
	const records: Record<string, string> = {};
	if (typeof raw === 'object' && raw !== null) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v.trim() !== '') records[k] = v.trim();
	return { file, records };
}

/**
 * The records an import needs before any processing (seed list review A4), kept in the private
 * object, never in the public repository: the DPIA and the legitimate interest assessment for
 * every list but fictional dev data, and where the grant is kept for a written grant.
 */
function missingRecords(entry: SeedEntry, records: Record<string, string>): string[] {
	if (entry.dev_only) return [];
	const need = ['dpia', 'lia', ...(entry.license === 'LicenseRef-written-grant' ? ['permission_doc'] : [])];
	return need.filter((k) => !records[k]);
}

/** The entry an ops command names, or the refusal. */
function registryEntry(store: Store, id: string): SeedEntry | Answer {
	const entry = store.engine.seeds.get(id);
	if (!entry) return fail(404, 'unknown_seed', `${JSON.stringify(id)} is not in the seed registry (packages/shared/src/seed-registry.json).`);
	const problems = validateEntry(entry);
	if (problems.length) return fail(409, 'seed_invalid', `The registry entry is not valid: ${problems.join('; ')}.`);
	return entry;
}

/**
 * `import-seed {"seed", "apply"}`: lists a cleared registry entry's file as review leads. It reads
 * the entry's object in the private bucket, checks its hash and the clearance records, and answers
 * what would change; only with "apply": true does it write, in one transaction, and start a
 * scoring pass that puts the sources in the review queue. Entries never give a verdict.
 */
export async function importSeed(store: Store, env: Env, a: Args): Promise<Answer> {
	if (!only(a, 'seed', 'apply') || typeof a.seed !== 'string' || (a.apply !== undefined && typeof a.apply !== 'boolean')) {
		return fail(400, 'invalid_args', 'import-seed takes seed, a registry ID, and apply: true to write; without apply it is a dry run.');
	}
	const entry = registryEntry(store, a.seed);
	if ('status' in entry) return entry;
	const reg = store.engine.seeds;
	if (entry.dev_only && !reg.dev) return fail(409, 'seed_not_cleared', `${entry.id} is fictional dev data, imported only in dev mode.`);
	if (!entry.dev_only && entry.clearance.status !== 'cleared') {
		return fail(409, 'seed_not_cleared', `${entry.id} is ${entry.clearance.status}, not cleared: only the owner clears a dataset, in the registry, after counsel.`);
	}
	if (entry.use === 'frame') return fail(409, 'seed_is_frame', `${entry.id} is a calibration frame: it is never imported as leads. Sample it with calibration-sample.`);
	const obj = await seedObject(env, entry);
	if ('status' in obj) return obj;
	const missing = missingRecords(entry, obj.records);
	if (missing.length) {
		return fail(409, 'records_required', `The object for ${entry.id} needs records.${missing.join(', records.')}: where the assessment or grant is kept. Processing starts only after them.`);
	}
	let parsed: Parsed;
	try {
		parsed = parseSeed(entry, obj.file);
	} catch (err) {
		return fail(400, 'invalid_seed_file', `The file does not read as ${entry.format}: ${(err as Error).message}.`);
	}
	const db = store.db;
	const now = store.now();
	const plan = planImport(db, entry.id, parsed.aliases);
	const byPlatform: Record<string, number> = {};
	for (const x of [...plan.added, ...plan.kept]) byPlatform[x.platform] = (byPlatform[x.platform] ?? 0) + 1;
	const counts = {
		seed: entry.id,
		entries: plan.added.length + plan.kept.length,
		by_platform: byPlatform,
		added: plan.added.length,
		kept: plan.kept.length,
		dropped: plan.dropped.length,
		suppressed: plan.suppressed.length,
		skipped: parsed.skipped,
		excluded: parsed.excluded
	};
	if (a.apply !== true) {
		return ok({ ...counts, applied: false, message: `Dry run: nothing was written. Run again with "apply": true to list ${counts.entries} sources as review leads.` });
	}
	const { batch } = applyImport(
		db,
		entry,
		plan,
		{ sha256: hex(sha256(utf8(obj.file))), entries: counts.entries, records: obj.records, listedAt: listedAt(entry, unix(now)) },
		unix(now)
	);
	store.jobs.schedule('pass', now);
	return ok({
		...counts,
		applied: true,
		batch,
		message: `Listed ${counts.entries} sources as review leads (${counts.added} new, ${counts.dropped} dropped). They never give a verdict; the scoring pass now puts them in the review queue.`
	});
}

/**
 * `revoke-seed {"seed", "reason", "confirm"}`: deletes every entry of a seed and every calibration
 * item sampled from it at once, then its list file in the private bucket; confirm repeats the seed.
 * The run log is public, so the reason must never name a creator or hold legal advice.
 */
export async function revokeSeedOps(store: Store, env: Env, a: Args): Promise<Answer> {
	const seed = text(a.seed);
	const reason = trimSpace(text(a.reason));
	if (!only(a, 'seed', 'reason', 'confirm') || seed === '') return fail(400, 'invalid_args', 'revoke-seed takes seed, reason and confirm.');
	if (a.confirm !== seed) return fail(400, 'confirmation_required', 'This command is destructive: set confirm to exactly the seed ID.');
	if (runeCount(reason) < 1 || runeCount(reason) > 500) {
		return fail(400, 'invalid_reason', 'reason must be 1 to 500 characters. The ops run log is public, so never name a creator or give legal advice in it.');
	}
	const now = store.now();
	const { entries, sampled, refs } = revokeSeed(store.db, seed, reason, unix(now));
	store.jobs.schedule('pass', now);
	const key = seedKey(seed);
	let file = 'deleted';
	try {
		await env.BACKUPS.delete(key);
	} catch (err) {
		console.error(JSON.stringify({ message: 'seed object not deleted', key, error: String(err) }));
		file = 'kept';
	}
	const deleted = `Deleted ${entries} entries and ${sampled} calibration items of ${seed}. Their review leads close at the next scoring pass.`;
	return ok({
		seed,
		entries,
		sampled,
		sources: refs.length,
		file,
		message:
			file === 'deleted'
				? `${deleted} The list file ${key} is deleted.`
				: `${deleted} The list file ${key} could not be deleted, most likely because the bucket lock keeps it for 7 days after upload: delete it by hand then (docs/deploy.md, "Withdraw a seed list at once").`
	});
}

/** n distinct random picks from xs (Fisher-Yates on a copy). */
function sample<T>(xs: T[], n: number): T[] {
	const a = [...xs];
	const r = new Uint32Array(1);
	for (let i = a.length - 1; i > 0; i--) {
		crypto.getRandomValues(r);
		const j = r[0]! % (i + 1);
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a.slice(0, n);
}

/**
 * `calibration-sample {"frame", "n"}`: adds up to n random sources to the calibration set from a
 * frame: `seed:<id>` (a lead or seed list's live entries), `community` (sources with tags or
 * reports) or `random:<id>` (a cleared frame entry's file in the private bucket). Sources already
 * in the set or suppressed are left out.
 */
export async function calibrationSample(store: Store, env: Env, a: Args): Promise<Answer> {
	const frame = text(a.frame);
	const n = a.n;
	if (!only(a, 'frame', 'n') || !Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 1000) {
		return fail(400, 'invalid_args', 'calibration-sample takes frame (community, seed:<id> or random:<id>) and n, 1 to 1,000.');
	}
	const db = store.db;
	const now = unix(store.now());
	let pool: number[];
	if (frame === 'community') pool = communitySources(db);
	else if (frame.startsWith('seed:')) {
		const id = frame.slice('seed:'.length);
		if (!store.engine.seeds.lead(id)) return fail(409, 'seed_not_cleared', `${id} is no cleared lead or seed list.`);
		pool = seedSources(db, id);
	} else if (frame.startsWith('random:')) {
		const entry = registryEntry(store, frame.slice('random:'.length));
		if ('status' in entry) return entry;
		const usableFrame = entry.dev_only ? store.engine.seeds.dev : entry.clearance.status === 'cleared';
		if (entry.use !== 'frame' || !usableFrame) return fail(409, 'seed_not_cleared', `${entry.id} is no cleared calibration frame.`);
		const obj = await seedObject(env, entry);
		if ('status' in obj) return obj;
		const missing = missingRecords(entry, obj.records);
		if (missing.length) return fail(409, 'records_required', `The object for ${entry.id} needs records.${missing.join(', records.')}.`);
		let parsed: Parsed;
		try {
			parsed = parseSeed(entry, obj.file);
		} catch (err) {
			return fail(400, 'invalid_seed_file', `The file does not read as ${entry.format}: ${(err as Error).message}.`);
		}
		const fresh = parsed.aliases.filter((x) => {
			const ref = findSource(db, x.platform, x.alias);
			return ref === undefined || !sampled(db, ref);
		});
		const picked = frameSources(db, sample(fresh, n as number), now);
		const added = addCalibrationItems(db, picked, frame, now);
		return ok({ frame, sampled: added, available: fresh.length });
	} else return fail(400, 'invalid_frame', 'frame must be community, seed:<id> or random:<id>.');
	const added = addCalibrationItems(db, sample(pool, n as number), frame, now);
	return ok({ frame, sampled: added, available: pool.length });
}

/** Where calibration-export writes, in the private backup bucket. */
export const CALIBRATION_PREFIX = 'calibration/';

/**
 * `calibration-export {}`: writes every calibration item with its labels, verdicts and seed lists
 * to the private bucket for scripts/calibration-report.ts, and answers only where and how many:
 * the run log is public and the rows name channels.
 */
export async function calibrationExport(store: Store, env: Env, a: Args): Promise<Answer> {
	if (!only(a)) return fail(400, 'invalid_args', 'calibration-export takes no arguments.');
	const rows = exportCalibration(store.db);
	const key = `${CALIBRATION_PREFIX}${new Date(store.now()).toISOString()}.json`;
	await env.BACKUPS.put(key, JSON.stringify({ exported_at: new Date(store.now()).toISOString(), items: rows }), { httpMetadata: { contentType: 'application/json' } });
	return ok({ key, items: rows.length, labels: rows.reduce((s, r) => s + r.labels.length, 0) });
}
