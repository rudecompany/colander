// User settings and the browser.storage.local layout. Content scripts read these keys directly
// (they cannot reach the extension origin's IndexedDB) and react to storage.onChanged.
import type { Platform, Strictness, TagVerdict } from '@colander/shared/verdicts';

export interface Topic {
	id: string;
	name: string;
	/** Keywords and #hashtags, matched as whole words, case-insensitive. */
	terms: string[];
	strictness: Strictness;
	/** Hide items that match even when no list or label applies to them. */
	hide: boolean;
}

export interface MyListEntry {
	/** Target key, e.g. `yt:s:@somechannel`. */
	key: string;
	name?: string;
	at: number;
}

export interface Settings {
	strictness: Strictness;
	/** Plus: per-platform strictness that replaces the global level on that platform. */
	perPlatform: Partial<Record<Platform, Strictness>>;
	/** Plus: keyword and hashtag topics with their own strictness. */
	topics: Topic[];
	/** Platforms the user switched on. Site access must also be granted for scripts to run. */
	platforms: Record<Platform, boolean>;
	pausedSites: Platform[];
	allows: MyListEntry[];
	blocks: MyListEntry[];
	/** Appearance: larger chips with plain-language words. */
	plainChips: boolean;
	/** Appearance: the Tag button stays visible on every card, not only on hover and focus. */
	alwaysTag: boolean;
	/** Appearance: a notice with Undo when a swipe feed skips a hidden video. Off: skips are silent. */
	skipNotice: boolean;
	onboarded: boolean;
}

export interface OwnTag {
	verdict: TagVerdict;
	at: number;
}

export const DEFAULT_SETTINGS: Settings = {
	strictness: 'standard',
	perPlatform: {},
	topics: [],
	platforms: { yt: false, tt: false, ig: false, fb: false },
	pausedSites: [],
	allows: [],
	blocks: [],
	plainChips: false,
	alwaysTag: false,
	skipNotice: false,
	onboarded: false
};

/** browser.storage.local keys. Content scripts read the first five; the rest is bookkeeping. */
export const K = {
	settings: 'settings',
	ownTags: 'ownTags',
	listIndex: 'listIndex',
	adapterConfig: 'adapterConfig',
	entitlement: 'entitlement',
	installId: 'installId',
	planToken: 'planToken',
	status: 'status',
	stats: 'stats',
	reports: 'reports',
	reviewerToken: 'reviewerToken',
	syncState: 'syncState',
	supportCard: 'supportCard',
	weeklyCard: 'weeklyCard',
	planCheckedAt: 'planCheckedAt'
} as const;

export interface Status {
	listSequence: number;
	listCount: number;
	listCreated: number;
	lastSyncAt: number | null;
	lastAttemptAt: number | null;
	lastError: string | null;
	configVersion: number;
	/** A report got a verdict since the user last looked at My reports (the attention dot). */
	reportsUpdated: boolean;
	/** A report was dismissed since then: a calm note in the popup, no attention dot. */
	reportsClosed: boolean;
}

export const DEFAULT_STATUS: Status = {
	listSequence: 0,
	listCount: 0,
	listCreated: 0,
	lastSyncAt: null,
	lastAttemptAt: null,
	lastError: null,
	configVersion: 0,
	reportsUpdated: false,
	reportsClosed: false
};

export interface DayStats {
	hidden: number;
	labeled: number;
}

export interface Stats {
	firstRunAt: number;
	/** Keyed by local date, YYYY-MM-DD. */
	days: Record<string, DayStats>;
}

export function dayKey(t = Date.now()): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The sync attention dot shows once the list has not refreshed for this long. */
export const STALE_MS = 6 * 60 * 60_000;

export function needsAttention(s: Status, now = Date.now()): boolean {
	const stale = !s.lastSyncAt || now - s.lastSyncAt > STALE_MS;
	return s.reportsUpdated || (!!s.lastError && stale);
}

export interface StoredIndex {
	sequence: number;
	count: number;
	/** base64 of the sorted 16-byte entries. */
	entries: string;
	syncedAt: number;
}

export interface Entitlement {
	plus: boolean;
	trial: boolean;
	exp: number;
}

/** Plus features are on while the verified plan token has not expired. */
export function isPlus(e: Entitlement | undefined, now = Date.now()): boolean {
	return !!e?.plus && e.exp * 1000 > now;
}

/** A stored level, from any version or another browser's sync: the removed Strict, and anything unknown, read as Standard. */
export function level(v: unknown): Strictness {
	return v === 'label' || v === 'no_ai' ? v : 'standard';
}

/** Settings as stored, from any version or from sync, with defaults filled in and every level valid. */
export function withDefaults(s: Partial<Settings> | undefined): Settings {
	return {
		...DEFAULT_SETTINGS,
		...s,
		strictness: level(s?.strictness ?? DEFAULT_SETTINGS.strictness),
		platforms: { ...DEFAULT_SETTINGS.platforms, ...s?.platforms },
		perPlatform: Object.fromEntries(Object.entries(s?.perPlatform ?? {}).map(([p, v]) => [p, level(v)])),
		topics: (s?.topics ?? []).map((t) => ({ ...t, strictness: level(t.strictness) }))
	};
}

export const STRICTNESS_RANK: Record<Strictness, number> = { label: 0, standard: 1, no_ai: 2 };
