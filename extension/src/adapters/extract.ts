// Reads card facts out of the DOM with a declarative surface description. Runs in content
// scripts (and in unit tests under jsdom); everything here is synchronous and allocation-light.
import type { Platform } from '@colander/shared/verdicts';
import { canonicalItem, canonicalSource, itemFromUrl, sourceFromUrl } from '../lib/ids';
import type { CardFacts } from '../lib/match';
import type { Extractor, PageRule, Surface, TextProbe } from './schema';

/** Attribute the main-world bridge writes on cards: `{"i": item, "s": [sources]}` as raw values. */
export const BRIDGE_ATTR = 'data-colander-bridge';

const regexCache = new Map<string, RegExp>();
export function rx(source: string, flags = 'u'): RegExp {
	const k = flags + source;
	let r = regexCache.get(k);
	if (!r) {
		r = new RegExp(source, flags);
		regexCache.set(k, r);
	}
	return r;
}

function pick(root: ParentNode, sel: string | undefined): Element | null {
	if (!sel || sel === ':scope') return (root as Element).getAttribute ? (root as Element) : null;
	try {
		return root.querySelector(sel);
	} catch {
		return null;
	}
}

function rawValue(root: ParentNode, e: Extractor, doc: Document): string | null {
	let v: string | null;
	if (e.from === 'location') v = doc.location?.href ?? null;
	else if (e.from === 'title') v = doc.title;
	else {
		const el = pick(root, e.sel);
		if (!el) return null;
		const attr = e.attr ?? 'href';
		v = attr === 'text' ? el.textContent : el.getAttribute(attr);
	}
	if (v == null) return null;
	if (e.re) {
		const m = rx(e.re).exec(v);
		v = m ? (m[1] ?? m[0]) : null;
	}
	return v;
}

function read(
	root: ParentNode,
	e: Extractor,
	doc: Document,
	parseUrl: (v: string) => string | null,
	parseId: (v: string) => string | null
): string | null {
	const v = rawValue(root, e, doc);
	if (v == null) return null;
	const as = e.as ?? (e.attr && e.attr !== 'href' ? 'id' : 'url');
	if (as === 'text') return v.replace(/\s+/g, ' ').trim() || null;
	return as === 'url' ? parseUrl(v) : parseId(v);
}

export function readItem(platform: Platform, root: ParentNode, list: Extractor[] | undefined, doc: Document): string | null {
	for (const e of list ?? []) {
		const v = read(root, e, doc, (u) => itemFromUrl(platform, u), (r) => canonicalItem(platform, r));
		if (v) return v;
	}
	return null;
}

export function readSources(platform: Platform, root: ParentNode, list: Extractor[] | undefined, doc: Document): string[] {
	const out: string[] = [];
	for (const e of list ?? []) {
		const v = read(root, e, doc, (u) => sourceFromUrl(platform, u), (r) => canonicalSource(platform, r));
		if (v && !out.includes(v)) out.push(v);
	}
	return out;
}

export function readText(root: ParentNode, list: Extractor[] | undefined, doc: Document): string {
	for (const e of list ?? []) {
		const v = read(root, { ...e, as: 'text' }, doc, (u) => u, (r) => r);
		if (v) return v;
	}
	return '';
}

export function probe(card: Element, p: TextProbe | undefined): boolean {
	if (!p) return false;
	let els: NodeListOf<Element>;
	try {
		els = card.querySelectorAll(p.sel);
	} catch {
		return false;
	}
	if (!p.text) return els.length > 0;
	const re = rx(p.text, 'iu');
	for (const el of els) if (re.test(el.textContent ?? '')) return true;
	return false;
}

/** Item and source values the bridge read from page data, canonicalized. */
function bridged(platform: Platform, card: Element): { item: string | null; sources: string[] } | null {
	const raw = card.getAttribute(BRIDGE_ATTR);
	if (!raw) return null;
	try {
		const b = JSON.parse(raw) as { i?: string; s?: string[] };
		const sources: string[] = [];
		for (const s of b.s ?? []) {
			const v = s.includes('/') ? sourceFromUrl(platform, s) : canonicalSource(platform, s);
			if (v && !sources.includes(v)) sources.push(v);
		}
		return { item: canonicalItem(platform, b.i), sources };
	} catch {
		return null;
	}
}

export interface Extracted extends CardFacts {
	name: string;
	title: string;
}

export function extractCard(platform: Platform, s: Surface, card: Element, doc: Document = card.ownerDocument): Extracted {
	let itemId = readItem(platform, card, s.item, doc);
	const sourceIds = readSources(platform, card, s.source, doc);
	const b = bridged(platform, card);
	// The bridge describes whatever the page's data says the card shows now. Reused elements can
	// lag behind, so its sources only count when its item agrees with the DOM's.
	if (b && (!itemId || !b.item || b.item === itemId)) {
		itemId ??= b.item;
		for (const v of b.sources) if (!sourceIds.includes(v)) sourceIds.push(v);
	}
	const title = readText(card, s.title, doc);
	return {
		platform,
		itemId,
		sourceIds,
		aiLabel: probe(card, s.aiLabel),
		text: title,
		title,
		name: readText(card, s.name, doc)
	};
}

export interface PageSource {
	sourceIds: string[];
	name: string;
	rule: PageRule;
}

/** The source the current page belongs to (a channel, profile or page), or null. */
export function pageSource(platform: Platform, rules: PageRule[] | undefined, doc: Document): PageSource | null {
	const path = doc.location?.pathname ?? '';
	for (const rule of rules ?? []) {
		if (!rx(rule.path).test(path)) continue;
		const sourceIds = readSources(platform, doc, rule.source, doc);
		if (sourceIds.length) return { sourceIds, name: readText(doc, rule.name, doc), rule };
	}
	return null;
}

export function platformForHost(
	platforms: Partial<Record<Platform, { hosts: string[] }>>,
	hostname: string
): Platform | null {
	for (const [p, c] of Object.entries(platforms)) if (c?.hosts.includes(hostname)) return p as Platform;
	return null;
}

export function activeSurfaces(surfaces: Surface[], pathname: string): Surface[] {
	return surfaces.filter((s) => {
		try {
			return rx(s.path).test(pathname);
		} catch {
			return false;
		}
	});
}
