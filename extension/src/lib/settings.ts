// User settings and the chrome.storage.local layout. Content scripts read these keys directly
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
	onboarded: false
};

/** The keys content scripts read. Anything else in storage is service-worker bookkeeping. */
export const K = {
	settings: 'settings',
	ownTags: 'ownTags',
	listIndex: 'listIndex',
	adapterConfig: 'adapterConfig',
	entitlement: 'entitlement'
} as const;

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

export function withDefaults(s: Partial<Settings> | undefined): Settings {
	return {
		...DEFAULT_SETTINGS,
		...s,
		platforms: { ...DEFAULT_SETTINGS.platforms, ...s?.platforms },
		perPlatform: { ...s?.perPlatform }
	};
}

export const STRICTNESS_RANK: Record<Strictness, number> = { label: 0, standard: 1, strict: 2, no_ai: 3 };
