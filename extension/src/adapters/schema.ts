// The declarative adapter configuration (normative description in extension/README.md).
// It is plain data: CSS selectors, attribute names, regular expressions and property paths.
// A signed remote copy with a higher `version` replaces the bundled one without a code change.
import type { Platform } from '@colander/shared/verdicts';

export const SCHEMA = 1;

export interface AdapterConfig {
	/** Monotonic integer. A remote config applies only when it is higher than the bundled or cached one. */
	version: number;
	/** Schema revision this payload is written for. Unknown revisions are ignored. */
	schema: number;
	platforms: Partial<Record<Platform, PlatformConfig>>;
}

export interface PlatformConfig {
	/** Early access: offered, and its content scripts registered, only with an active Plus entitlement. */
	early_access?: boolean;
	/** Hostnames the adapter runs on. */
	hosts: string[];
	/** Document events that signal in-page navigation, in addition to the Navigation API. */
	navEvents?: string[];
	/** The platform's own help page for reporting scams and deepfakes. */
	reportHelp: string;
	surfaces: Surface[];
	/** Pages that belong to one source (channel, profile, page), for Report source. */
	pages?: PageRule[];
	/** Readers for data the page keeps in JavaScript properties instead of the DOM. */
	bridges?: Bridge[];
}

export type Mode = 'grid' | 'list' | 'swipe';

export interface Surface {
	/** Stable identifier, for example `yt.home`. */
	id: string;
	/** Regular expression tested against `location.pathname`. The surface is active while it matches. */
	path: string;
	mode: Mode;
	/** CSS selector for one card. */
	card: string;
	/** Cards without a source of their own belong to the page's source (channel and profile grids). */
	pageSource?: boolean;
	/** Tried in order; the first one that yields a canonical item ID wins. */
	item?: Extractor[];
	/** Every extractor that yields a canonical source ID adds an alias. */
	source?: Extractor[];
	/** Source display name. */
	name?: Extractor[];
	/** Title or caption, used by topic rules and the activity log. */
	title?: Extractor[];
	/** The platform's own AI disclosure on the card (P0-4). */
	aiLabel?: TextProbe;
	/** Where the verdict chip goes. Default: overlay on the card. */
	chip?: Anchor;
	/** Where the Tag button goes. Default: appended to the card. */
	tag?: Anchor;
	/** Swipe feeds: the element the cover is laid over. Default: the card. */
	cover?: string;
	/** Swipe feeds: the platform's own "next" control, a document-level selector. Default: scroll to the next card. */
	next?: string;
}

export interface Extractor {
	/** Selector relative to the card (or the document for page rules). Default: the card itself. */
	sel?: string;
	/** Read from: `location` (the page URL) or `title` (document.title). Page rules only. */
	from?: 'location' | 'title';
	/** Attribute name, or `text` for the text content. Default: `href`. */
	attr?: string;
	/** Optional regular expression; capture group 1 becomes the value. */
	re?: string;
	/** How to read the value: `url` parses a link with the contract rules, `id` canonicalizes a raw ID, `text` keeps it. */
	as?: 'url' | 'id' | 'text';
}

export interface TextProbe {
	sel: string;
	/** Case-insensitive regular expression the element's text must match. Default: presence is enough. */
	text?: string;
}

export interface Anchor {
	/** Selector relative to the card. Default: the card. */
	sel?: string;
	/**
	 * `overlay` pins to the top-left corner of the anchor, `overlay-end` to the top-right;
	 * `append`, `prepend`, `before` and `after` insert in the flow.
	 */
	place: 'overlay' | 'overlay-end' | 'append' | 'prepend' | 'before' | 'after';
}

export interface PageRule {
	path: string;
	source: Extractor[];
	name?: Extractor[];
	/** Where the Report source button goes (document-level selector). */
	anchor?: Anchor;
}

export interface Bridge {
	/** Cards this bridge annotates. */
	card: string;
	/** Element inside the card that holds the data. Default: the card. */
	el?: string;
	/** Property paths to the data object, tried in order. A trailing `()` reads a getter function. */
	props: string[];
	item?: BridgeKey[];
	source?: BridgeKey[];
}

export interface BridgeKey {
	/** Property name searched depth-first in the data object. */
	key: string;
	/** Regular expression the value must match; capture group 1 is used when present. */
	re?: string;
}

/** Structural validation for a remote payload. Throws with a reason when it is unusable. */
export function validateConfig(value: unknown): AdapterConfig {
	const c = value as AdapterConfig;
	const fail = (why: string): never => {
		throw new Error(`adapter config: ${why}`);
	};
	if (!c || typeof c !== 'object') fail('not an object');
	if (!Number.isInteger(c.version) || c.version < 1) fail('version must be a positive integer');
	if (c.schema !== SCHEMA) fail(`unsupported schema ${String(c.schema)}`);
	if (!c.platforms || typeof c.platforms !== 'object') fail('platforms missing');
	const regexes: string[] = [];
	const extractors = (list: Extractor[] | undefined, where: string) => {
		if (list === undefined) return;
		if (!Array.isArray(list)) fail(`${where} must be a list`);
		for (const e of list) {
			if (!e || typeof e !== 'object') fail(`${where} has a bad extractor`);
			if (e.re) regexes.push(e.re);
		}
	};
	for (const [p, pc] of Object.entries(c.platforms)) {
		if (!['yt', 'tt', 'ig', 'fb'].includes(p)) fail(`unknown platform ${p}`);
		if (!pc || !Array.isArray(pc.hosts) || !Array.isArray(pc.surfaces)) fail(`${p} needs hosts and surfaces`);
		if (pc!.early_access !== undefined && typeof pc!.early_access !== 'boolean') fail(`${p} early_access must be true or false`);
		for (const s of pc!.surfaces) {
			if (!s.id || !s.card || !s.path || !['grid', 'list', 'swipe'].includes(s.mode)) fail(`${p} surface ${s.id} is incomplete`);
			regexes.push(s.path);
			if (s.aiLabel?.text) regexes.push(s.aiLabel.text);
			extractors(s.item, `${s.id}.item`);
			extractors(s.source, `${s.id}.source`);
			extractors(s.name, `${s.id}.name`);
			extractors(s.title, `${s.id}.title`);
		}
		for (const r of pc!.pages ?? []) {
			regexes.push(r.path);
			extractors(r.source, `${p} page source`);
			extractors(r.name, `${p} page name`);
		}
		for (const b of pc!.bridges ?? []) {
			if (!b.card || !Array.isArray(b.props)) fail(`${p} bridge is incomplete`);
			for (const k of [...(b.item ?? []), ...(b.source ?? [])]) if (k.re) regexes.push(k.re);
		}
	}
	for (const r of regexes) {
		try {
			new RegExp(r, 'u');
		} catch {
			fail(`bad regular expression ${r}`);
		}
	}
	return c;
}
