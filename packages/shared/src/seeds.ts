// The seed source registry (docs/contracts.md section 14): every outside dataset Colander may read,
// with its license, its use and the owner's clearance. The entries live in seed-registry.json next
// to this file; the Worker bundles them through seed-registry.ts, the website's /credits page
// prerenders credits() from them, and scripts/check-seeds.ts validates them in CI.
//
// This module has no imports, so Node runs it as is in CI. Only the Worker, the prerendered
// /credits page and the CI check may load the registry itself: public pages and the extension
// never name a dataset, except /credits.

export const PLATFORMS = ['yt', 'tt', 'ig', 'fb'] as const;

/**
 * What a dataset may do. `lead` and `seed` entries put the sources they list in the staff review
 * queue and are never evidence: no layer counts them and they never give a verdict. A `seed` list
 * passed blind calibration (CALIBRATION), so its leads rank with reports. A `frame` is a sampling
 * pool for the calibration set, never imported as leads and never evidence.
 */
export const USES = ['lead', 'seed', 'frame'] as const;

/** How the list file is read: one ID per line, uBlock Origin rules, or Soul Over AI's artist JSON. */
export const FORMATS = ['lines', 'ubo', 'soul-over-ai'] as const;

export const CLEARANCES = ['pending', 'cleared', 'refused', 'revoked'] as const;

/** Licenses a paid product may use a dataset under, by SPDX identifier. Nothing else can be cleared. */
export const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'MIT', 'LicenseRef-written-grant', 'LicenseRef-Colander-internal'] as const;

/** Licenses whose terms require a credit: the entry must carry the exact attribution text. */
const ATTRIBUTION_LICENSES = new Set(['CC-BY-4.0', 'MIT']);

/** Colander's own data: no license URL, no credit, and no third party to clear with. */
export const INTERNAL = 'LicenseRef-Colander-internal';

/**
 * The GitHub logins that may clear a dataset, and the only ones whose pull requests may change a
 * cleared entry or any clearance (scripts/check-seeds.ts). CODEOWNERS guards this file too.
 */
export const SEED_OWNERS = ['slantview'];

/**
 * Blind calibration a `seed` list must pass in every group it reports (seed list review 16): at
 * least 100 labeled sources overall and 30 per group, a 95% Wilson lower bound of 0.90 on the
 * share that is AI-made and of 0.80 on the share that is slop.
 */
export const CALIBRATION = { n: 100, groupN: 30, ai: 0.9, slop: 0.8 } as const;

/** A pinned snapshot stops counting as a calibrated `seed` list this long after its upstream date. */
export const SEED_MAX_DAYS = 180;

export type SeedPlatform = (typeof PLATFORMS)[number];
export type SeedUse = (typeof USES)[number];
export type SeedFormat = (typeof FORMATS)[number];
export type ClearanceStatus = (typeof CLEARANCES)[number];

/** Labeled counts of one calibration group: n sources judged, ai of them AI-made, slop of them slop. */
export interface CalibrationGroup {
	group: string;
	n: number;
	ai: number;
	slop: number;
}

export interface SeedEntry {
	/** stable ID, also the private object key seeds/<id>.json */
	id: string;
	/** the dataset's own name, as /credits shows it */
	name: string;
	homepage: string;
	platforms: SeedPlatform[];
	/** SPDX identifier, or a LicenseRef- for a written grant or Colander's own data */
	license: string;
	license_url: string | null;
	/** the exact credit the license requires, or null when it requires none */
	attribution: string | null;
	/** how the maintainer collected the list, citing their README or a statement from them */
	collection: string;
	/** whether the list was scraped from a platform; null until the maintainer has said */
	scraped: boolean | null;
	use: SeedUse;
	format: SeedFormat;
	/** hex SHA-256 of the file text in the private bucket; imports must match it */
	sha256: string | null;
	/** the upstream version imported, and its date (YYYY-MM-DD), from which expiry counts */
	upstream: { ref: string | null; date: string | null };
	/** entries stop counting this many days after the upstream date of the batch that listed them */
	expires_after_days: number;
	/** blind calibration counts; required for use "seed" */
	calibration: { report: string; groups: CalibrationGroup[] } | null;
	/** fictional data for `make dev` and tests, never usable outside dev mode */
	dev_only: boolean;
	/** the owner's legal clearance; only SEED_OWNERS set "cleared" */
	clearance: { status: ClearanceStatus; by: string | null; at: string | null };
}

export interface Registry {
	$schema?: string;
	entries: SeedEntry[];
}

/** What /credits shows for one dataset. */
export interface Credit {
	name: string;
	homepage: string;
	license: string;
	license_url: string | null;
	attribution: string;
}

const KEYS = [
	'id',
	'name',
	'homepage',
	'platforms',
	'license',
	'license_url',
	'attribution',
	'collection',
	'scraped',
	'use',
	'format',
	'sha256',
	'upstream',
	'expires_after_days',
	'calibration',
	'dev_only',
	'clearance'
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v === v.trim();
const isUrl = (v: unknown): boolean => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The 95% Wilson score lower bound of k successes in n trials (0 when n is 0). */
export function wilsonLower(k: number, n: number): number {
	if (n === 0) return 0;
	const z = 1.959963984540054;
	const p = k / n;
	const z2 = z * z;
	return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Problems with one calibration block for use "seed", empty when every group passes. */
function calibrationProblems(c: unknown): string[] {
	if (typeof c !== 'object' || c === null || !isDate((c as { report?: unknown }).report) || !Array.isArray((c as { groups?: unknown }).groups)) {
		return ['use "seed" needs a calibration block: {"report": "YYYY-MM-DD", "groups": [{"group", "n", "ai", "slop"}]}'];
	}
	const groups = (c as { groups: unknown[] }).groups;
	const out: string[] = [];
	if (!groups.some((g) => (g as CalibrationGroup)?.group === 'all')) out.push('calibration needs a group "all" over every labeled source');
	for (const g of groups as CalibrationGroup[]) {
		if (!isText(g?.group) || !isCount(g.n) || !isCount(g.ai) || !isCount(g.slop) || g.ai > g.n || g.slop > g.ai) {
			out.push('each calibration group needs a name and counts with slop <= ai <= n');
			continue;
		}
		const min = g.group === 'all' ? CALIBRATION.n : CALIBRATION.groupN;
		if (g.n < min) out.push(`calibration group ${g.group} has ${g.n} labeled sources, under ${min}`);
		const ai = wilsonLower(g.ai, g.n);
		const slop = wilsonLower(g.slop, g.n);
		if (ai < CALIBRATION.ai) out.push(`calibration group ${g.group}: the AI-made lower bound ${ai.toFixed(3)} is under ${CALIBRATION.ai}`);
		if (slop < CALIBRATION.slop) out.push(`calibration group ${g.group}: the slop lower bound ${slop.toFixed(3)} is under ${CALIBRATION.slop}`);
	}
	return out;
}

/**
 * Every rule an entry breaks (docs/contracts.md 14.2), empty when it is valid. CI runs it on the
 * whole registry and the Worker again before an import.
 */
export function validateEntry(value: unknown, owners: readonly string[] = SEED_OWNERS): string[] {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['an entry must be a JSON object'];
	const e = value as SeedEntry;
	const p: string[] = [];
	const extra = Object.keys(e).filter((k) => !KEYS.includes(k));
	const missing = KEYS.filter((k) => !(k in e));
	if (extra.length) p.push(`unknown fields: ${extra.join(', ')}`);
	if (missing.length) p.push(`missing fields: ${missing.join(', ')}`);
	if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(e.id)) p.push('id must be 3 to 63 lowercase letters, digits and dashes');
	if (!isText(e.name)) p.push('name is required');
	if (!isUrl(e.homepage)) p.push('homepage must be an https URL');
	if (!Array.isArray(e.platforms) || e.platforms.length === 0 || e.platforms.some((x) => !PLATFORMS.includes(x)) || new Set(e.platforms).size !== e.platforms.length) {
		p.push(`platforms must list some of ${PLATFORMS.join(', ')}, each once`);
	}
	if (!isText(e.license)) p.push('license is required: an SPDX identifier or a LicenseRef-');
	if (e.license_url !== null && !isUrl(e.license_url)) p.push('license_url must be an https URL or null');
	if (e.attribution !== null && !isText(e.attribution)) p.push('attribution must be text or null');
	if (!isText(e.collection)) p.push("collection is required: how the maintainer collected the list, citing their README or a statement");
	if (e.scraped !== null && typeof e.scraped !== 'boolean') p.push('scraped must be true, false or null (unknown)');
	if (!USES.includes(e.use)) p.push(`use must be one of ${USES.join(', ')}`);
	if (!FORMATS.includes(e.format)) p.push(`format must be one of ${FORMATS.join(', ')}`);
	if (e.format === 'lines' && Array.isArray(e.platforms) && e.platforms.length !== 1) p.push('a lines file holds one platform');
	if (e.sha256 !== null && !(typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256))) p.push('sha256 must be 64 lowercase hex digits or null');
	if (typeof e.upstream !== 'object' || e.upstream === null || (e.upstream.ref !== null && !isText(e.upstream.ref)) || (e.upstream.date !== null && !isDate(e.upstream.date))) {
		p.push('upstream must be {"ref": text or null, "date": "YYYY-MM-DD" or null}');
	}
	if (!Number.isSafeInteger(e.expires_after_days) || e.expires_after_days < 1 || e.expires_after_days > 730) p.push('expires_after_days must be a whole number from 1 to 730');
	if (typeof e.dev_only !== 'boolean') p.push('dev_only must be true or false');
	const c = e.clearance;
	if (typeof c !== 'object' || c === null || !CLEARANCES.includes(c.status) || (c.by !== null && !isText(c.by)) || (c.at !== null && !isDate(c.at))) {
		p.push(`clearance must be {"status": ${CLEARANCES.join(' | ')}, "by": login or null, "at": "YYYY-MM-DD" or null}`);
		return p;
	}

	const internal = e.license === INTERNAL;
	if (ATTRIBUTION_LICENSES.has(e.license) && e.attribution === null) p.push(`${e.license} requires attribution: the exact credit its license asks for`);
	if (internal && e.attribution !== null) p.push('Colander-internal data takes no attribution');
	if (!internal && e.license !== 'LicenseRef-written-grant' && e.license_url === null) p.push('license_url is required for a public license');
	if (e.use === 'seed') {
		p.push(...calibrationProblems(e.calibration));
		if (e.expires_after_days > SEED_MAX_DAYS) p.push(`a seed list stops counting within ${SEED_MAX_DAYS} days of its upstream date`);
	}
	if (e.dev_only) {
		// Fictional demo data: it never reaches production, so it is never cleared.
		if (!internal) p.push(`a dev_only entry is fictional and licensed ${INTERNAL}`);
		if (c.status !== 'pending') p.push('a dev_only entry stays pending: it is never cleared');
	}
	if (c.status === 'cleared') {
		if (!(LICENSES as readonly string[]).includes(e.license)) {
			p.push(`only ${LICENSES.join(', ')} can be cleared; non-commercial, no-derivatives, share-alike, GPL and unlicensed lists never are`);
		}
		if (c.by === null || !owners.includes(c.by)) p.push(`clearance.by must be one of the owners: ${owners.join(', ')}`);
		if (c.at === null) p.push('clearance.at is required once cleared');
		if (e.sha256 === null) p.push('sha256 is required once cleared: imports must match the file that was cleared');
		if (e.upstream?.date === null) p.push('upstream.date is required once cleared');
		if (e.scraped !== false) p.push('only a list the maintainer says was not scraped can be cleared');
	}
	return p;
}

/** Problems with a whole registry: each entry's, and duplicate IDs. */
export function validateRegistry(r: unknown, owners: readonly string[] = SEED_OWNERS): string[] {
	if (typeof r !== 'object' || r === null || !Array.isArray((r as Registry).entries)) return ['the registry must be {"entries": [...]}'];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const e of (r as Registry).entries) {
		const id = typeof (e as SeedEntry)?.id === 'string' ? (e as SeedEntry).id : '(no id)';
		if (seen.has(id)) out.push(`${id}: duplicate id`);
		seen.add(id);
		for (const problem of validateEntry(e, owners)) out.push(`${id}: ${problem}`);
	}
	return out;
}

/**
 * Whether an entry's data may be used now: cleared and valid, or, in dev mode only, a dev_only
 * entry. A dev_only entry is never usable outside dev mode.
 */
export function usable(e: SeedEntry, dev: boolean): boolean {
	if (validateEntry(e).length > 0) return false;
	return e.dev_only ? dev : e.clearance.status === 'cleared';
}

/** The upstream date as unix seconds, or undefined. */
export const upstreamUnix = (e: SeedEntry): number | undefined => (e.upstream.date === null ? undefined : Date.parse(e.upstream.date + 'T00:00:00Z') / 1000);

/**
 * The datasets /credits names: cleared third-party entries whose license requires a credit. Lists
 * with no attribution duty (CC0, Colander's own) are not named anywhere public.
 */
export function credits(entries: readonly SeedEntry[]): Credit[] {
	return entries
		.filter((e) => !e.dev_only && e.license !== INTERNAL && e.attribution !== null && usable(e, false))
		.map((e) => ({ name: e.name, homepage: e.homepage, license: e.license, license_url: e.license_url, attribution: e.attribution! }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The entries a pull request may only change when an owner makes it: any entry cleared before or
 * after, any whose clearance changed, and any added or taken out other than as pending. Returns
 * their IDs.
 */
export function ownerOnlyChanges(base: readonly SeedEntry[], head: readonly SeedEntry[]): string[] {
	const before = new Map(base.map((e) => [e.id, e]));
	const after = new Map(head.map((e) => [e.id, e]));
	const out: string[] = [];
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		const b = before.get(id);
		const a = after.get(id);
		if (JSON.stringify(b) === JSON.stringify(a)) continue;
		const cleared = b?.clearance?.status === 'cleared' || a?.clearance?.status === 'cleared';
		// A new pending entry, or a pending one taken out, needs no owner: nothing may use it.
		const clearance = b && a ? JSON.stringify(b.clearance) !== JSON.stringify(a.clearance) : (a ?? b)!.clearance?.status !== 'pending';
		if (cleared || clearance) out.push(id);
	}
	return out.sort();
}
