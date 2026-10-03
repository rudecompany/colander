// The content script's controller: finds cards as they are inserted, decides what happens to
// each with the matching engine, and applies the treatment before the page paints.
import { PLATFORM_NAME, type Action, type Platform, type SlopType, type TagVerdict, type Test } from '@colander/shared/verdicts';
import defaults from '../adapters/default-config.json';
import { activeSurfaces, extractCard, pageSource, platformForHost, rx, type Extracted, type PageSource } from '../adapters/extract';
import type { AdapterConfig, Anchor, PlatformConfig, Surface } from '../adapters/schema';
import { b64decode } from '../lib/bytes';
import { targetKey } from '../lib/ids';
import { ListIndex } from '../lib/list';
import { decide, type Decision, type MatchContext } from '../lib/match';
import type { ActivityEntry, HelloReply, PageAction, PageCounts, PageState, ReportReply, TagRequest, ToPage, ToWorker } from '../lib/messages';
import { platformConfig } from '../lib/platforms';
import { isPlus, K, withDefaults, type Entitlement, type OwnTag, type Settings, type StoredIndex } from '../lib/settings';
import { pageIsDark, reducedMotion, setDark } from './dom';
import { Layer, bar, chip, cover, reportButton, tagButton, type CardView } from './ui';

interface CardState {
	id: number;
	surface: Surface;
	facts: Extracted;
	sig: string;
	decision: Decision;
	version: number;
	/** Show was chosen: the item stays visible, with its chip, for this page view. */
	shown: boolean;
	/** Reported to the activity log for this page view. */
	counted: boolean;
	/** Swipe feeds: already skipped once automatically. */
	skipped: boolean;
	ui: Partial<Record<'chip' | 'bar' | 'cover' | 'tag', HTMLElement>>;
}

type Effective = Action | 'none';

/** After an extension update the old content script's context is gone and sendMessage throws. */
const send = <T = unknown>(m: ToWorker): Promise<T> => {
	try {
		return chrome.runtime.sendMessage(m) as Promise<T>;
	} catch (e) {
		return Promise.reject(e);
	}
};

export function start(): void {
	const bundled = defaults as AdapterConfig;
	const platform = platformForHost(bundled.platforms, location.hostname);
	if (!platform) return;

	let pc: PlatformConfig = bundled.platforms[platform]!;
	let surfaces: Surface[] = [];
	let settings: Settings = withDefaults(undefined);
	let ownTags = new Map<string, TagVerdict>();
	let index: ListIndex | null = null;
	let plus = false;
	let tabPaused = false;
	let ready = false;
	let version = 0;
	let nextId = 1;
	let page: PageSource | null = null;
	let lastUrl = location.href;
	let reportHost: HTMLElement | null = null;
	const states = new Map<Element, CardState>();
	const batchMs: number[] = [];
	let layer: Layer | null = null;
	const ui = () => (layer ??= new Layer());

	// Registered at document_start, before the page's own scripts, so Escape and the focus trap
	// of an open popover or dialog are handled before any site shortcut sees the key.
	addEventListener('keydown', (e) => layer?.onKey(e), true);
	// Leaving the page closes an open tag menu, which sends its held tag.
	addEventListener('pagehide', () => layer?.closePop(false));

	let ctx: MatchContext = buildCtx();
	function buildCtx(): MatchContext {
		return {
			strictness: settings.strictness,
			perPlatform: settings.perPlatform,
			topics: settings.topics,
			plus,
			paused: tabPaused || settings.pausedSites.includes(platform!),
			allows: new Set(settings.allows.map((e) => e.key)),
			blocks: new Set(settings.blocks.map((e) => e.key)),
			ownTags,
			lookup: (k) => index?.lookup(k) ?? null
		};
	}
	function changed() {
		version++;
		ctx = buildCtx();
	}

	function applyConfig(stored: unknown) {
		pc = platformConfig(stored as AdapterConfig | undefined, platform!);
		surfaces = activeSurfaces(pc.surfaces, location.pathname);
		sendBridge();
	}
	function sendBridge() {
		document.dispatchEvent(new CustomEvent('colander:bridge-config', { detail: JSON.stringify(pc.bridges ?? []) }));
	}
	document.addEventListener('colander:bridge-ready', sendBridge);

	function applyIndex(stored: StoredIndex | undefined) {
		index = stored?.entries ? new ListIndex(b64decode(stored.entries)) : null;
	}
	function applyEntitlement(e: Entitlement | undefined) {
		plus = isPlus(e);
	}
	function applyTags(t: Record<string, OwnTag> | undefined) {
		ownTags = new Map(Object.entries(t ?? {}).map(([k, v]) => [k, v.verdict]));
	}

	// ---- Card processing ------------------------------------------------------------

	const noun = (s: Surface) => (platform === 'yt' || platform === 'tt' ? 'video' : s.mode === 'swipe' ? 'reel' : 'post');

	function preferredSource(f: Extracted): string | null {
		return f.sourceIds.find((s) => s.startsWith('UC')) ?? f.sourceIds[0] ?? null;
	}

	function effective(st: CardState): Effective {
		const a = st.decision.action;
		if (st.shown && (a === 'hide' || a === 'collapse')) return st.decision.verdict ? 'label' : 'none';
		return a;
	}

	function process(card: Element, surface: Surface, force = false) {
		const prev = states.get(card);
		const facts = extractCard(platform!, surface, card, document);
		if (surface.pageSource && !facts.sourceIds.length && page) facts.sourceIds = [...page.sourceIds];
		const sig = `${facts.itemId}|${facts.sourceIds.join(',')}|${facts.aiLabel ? 1 : 0}|${facts.title.length}`;
		if (prev && prev.sig === sig && prev.version === version && !force) {
			render(card, prev);
			return;
		}
		let st = prev;
		if (!st || st.sig !== sig || st.surface !== surface) {
			if (st) clearUi(card, st);
			st = { id: nextId++, surface, facts, sig, decision: decide(facts, ctx), version, shown: false, counted: false, skipped: false, ui: {} };
			states.set(card, st);
		} else {
			st.facts = facts;
			st.decision = decide(facts, ctx);
			st.version = version;
		}
		render(card, st);
	}

	function clearUi(card: Element, st: CardState) {
		for (const k of Object.keys(st.ui) as (keyof CardState['ui'])[]) {
			st.ui[k]?.remove();
			delete st.ui[k];
		}
		card.removeAttribute('data-colander');
		unguard(card);
	}

	function resolve(card: Element, a: Anchor | undefined, fallback: Anchor | null): { el: Element; place: Anchor['place'] } | null {
		const spec = a ?? fallback;
		if (!spec) return null;
		let el: Element | null = card;
		if (spec.sel) {
			try {
				el = card.querySelector(spec.sel);
			} catch {
				el = null;
			}
		}
		if (!el) return fallback && a ? resolve(card, undefined, fallback) : null;
		return { el, place: spec.place };
	}

	function insert(host: HTMLElement, at: { el: Element; place: Anchor['place'] }, inline: 'inline' | 'block') {
		const { el, place } = at;
		if (place === 'overlay' || place === 'overlay-end') {
			if (getComputedStyle(el).position === 'static') el.setAttribute('data-colander-anchor', '');
			host.setAttribute('data-place', place);
			el.append(host);
			return;
		}
		host.setAttribute('data-place', inline);
		if (place === 'append') el.append(host);
		else if (place === 'prepend') el.prepend(host);
		else if (place === 'before') el.before(host);
		else el.after(host);
	}

	/** Makes sure one UI element exists where it belongs, creating or moving it as needed. */
	function ensure(st: CardState, slot: keyof CardState['ui'], want: boolean, card: Element, make: () => HTMLElement, place: (host: HTMLElement) => boolean) {
		const cur = st.ui[slot];
		if (!want) {
			if (cur) {
				cur.remove();
				delete st.ui[slot];
			}
			return;
		}
		if (cur && cur.isConnected && card.contains(cur)) return;
		cur?.remove();
		const host = make();
		if (place(host)) st.ui[slot] = host;
		else delete st.ui[slot];
	}

	function view(st: CardState): CardView {
		return { platform: platform!, decision: st.decision, noun: noun(st.surface), sourceId: preferredSource(st.facts), plain: settings.plainChips };
	}

	function render(card: Element, st: CardState) {
		if (!card.isConnected) return;
		const action = effective(st);
		const swipe = st.surface.mode === 'swipe';
		const paused = ctx.paused;
		card.setAttribute('data-colander-card', '');

		// Remove UI that travelled here inside a reused element and belongs to another card.
		const own = new Set(Object.values(st.ui));
		for (const stray of card.querySelectorAll('colander-ui')) {
			if (own.has(stray as HTMLElement)) continue;
			let owner: Element | null = stray.parentElement;
			while (owner && !states.has(owner)) owner = owner.parentElement;
			if (owner === card) stray.remove();
		}

		if (!swipe) {
			if (action === 'hide') card.setAttribute('data-colander', 'hide');
			else if (action === 'collapse') card.setAttribute('data-colander', 'collapse');
			else card.removeAttribute('data-colander');
		}
		ensure(st, 'bar', !swipe && action === 'collapse', card, () => bar(view(st), () => show(card, st), (a) => why(a, card, st)), (host) => {
			card.prepend(host);
			return true;
		});
		const covered = swipe && (action === 'hide' || action === 'collapse');
		ensure(
			st,
			'cover',
			covered,
			card,
			() => cover(view(st), () => show(card, st), () => skip(card, st, false), (a) => why(a, card, st)),
			(host) => {
				const at = resolve(card, st.surface.cover ? { sel: st.surface.cover, place: 'overlay' } : undefined, { place: 'overlay' });
				if (!at) return false;
				if (getComputedStyle(at.el).position === 'static') at.el.setAttribute('data-colander-anchor', '');
				at.el.append(host);
				return true;
			}
		);
		if (covered) guard(card);
		else unguard(card);

		const tone = swipe || resolve(card, st.surface.chip, { place: 'overlay' })?.place.startsWith('overlay') ? 'ink' : 'tint';
		ensure(st, 'chip', action === 'label' && !!st.decision.verdict, card, () => chip(view(st), tone, (a) => why(a, card, st)), (host) => {
			const at = resolve(card, st.surface.chip, { place: 'overlay' });
			if (!at) return false;
			insert(host, at, 'inline');
			return true;
		});

		// Every card with an item or a source gets the Tag button, also where the card shows no source.
		const taggable = !!(st.facts.itemId || st.facts.sourceIds.length);
		ensure(
			st,
			'tag',
			taggable && !paused && !covered && action !== 'collapse' && action !== 'hide',
			card,
			() => {
				const host = tagButton(noun(st.surface), swipe || !!st.surface.tag?.place.startsWith('overlay'), (a) => tagMenu(a, card, st));
				if (!swipe) host.setAttribute('data-reveal', '');
				return host;
			},
			(host) => {
				const at = resolve(card, st.surface.tag, null);
				if (!at) return false;
				insert(host, at, swipe ? 'inline' : 'block');
				return true;
			}
		);

		if (!st.counted && (action === 'hide' || action === 'collapse' || action === 'label') && st.decision.reason !== 'none') {
			st.counted = true;
			queueActivity(st, action);
		}
		scheduleCounts();
	}

	// ---- Swipe feeds ------------------------------------------------------------------

	const guarded = new WeakMap<Element, (e: Event) => void>();
	function guard(card: Element) {
		for (const v of card.querySelectorAll('video')) v.pause();
		if (guarded.has(card)) return;
		const fn = (e: Event) => {
			if (e.target instanceof HTMLVideoElement) e.target.pause();
		};
		guarded.set(card, fn);
		card.addEventListener('play', fn, true);
	}
	function unguard(card: Element) {
		const fn = guarded.get(card);
		if (fn) card.removeEventListener('play', fn, true);
		guarded.delete(card);
	}

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
				const st = states.get(e.target);
				if (st && effective(st) === 'hide' && !st.skipped) skip(e.target, st, true);
			}
		},
		{ threshold: [0, 0.6] }
	);
	const watched = new WeakSet<Element>();

	let skipRun = { n: 0, at: 0 };
	let lastSkipped: { card: Element; st: CardState } | null = null;
	function skip(card: Element, st: CardState, auto: boolean) {
		st.skipped = true;
		const cards = [...document.querySelectorAll(st.surface.card)];
		const next = cards[cards.indexOf(card) + 1];
		let button: HTMLElement | null = null;
		if (st.surface.next) {
			try {
				button = document.querySelector<HTMLElement>(st.surface.next);
			} catch {
				button = null;
			}
		}
		if (button && button.getClientRects().length) button.click();
		else next?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
		if (!auto) return;
		const now = Date.now();
		skipRun = now - skipRun.at < 4000 ? { n: skipRun.n + 1, at: now } : { n: 1, at: now };
		lastSkipped = { card, st };
		const what = st.decision.verdict ? `slop ${noun(st.surface)}` : noun(st.surface);
		ui().notice(`Skipped ${skipRun.n} ${what}${skipRun.n === 1 ? '' : 's'}.`, () => {
			const last = lastSkipped;
			skipRun = { n: 0, at: 0 };
			if (!last) return;
			last.st.shown = true;
			render(last.card, last.st);
			last.card.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
		});
	}

	// ---- Actions from the UI ------------------------------------------------------------

	function show(card: Element, st: CardState) {
		st.shown = true;
		render(card, st);
		const focusTarget = st.ui.chip?.shadowRoot?.querySelector('button') ?? null;
		focusTarget?.focus();
	}

	function why(anchor: HTMLElement, card: Element, st: CardState) {
		const d = st.decision;
		const hidden = effective(st) === 'hide' || effective(st) === 'collapse';
		ui().why(anchor, view(st), {
			show: hidden ? () => show(card, st) : undefined,
			allow: d.reason !== 'allowed' ? () => allow(st) : undefined,
			notSlop: d.verdict && d.verdict !== 'clear' ? () => void tagCard(card, st, 'not_slop', d.reason === 'source_list') : undefined
		});
	}

	function allow(st: CardState) {
		const src = preferredSource(st.facts);
		const key = src ? targetKey(platform!, 'source', src) : st.facts.itemId ? targetKey(platform!, 'item', st.facts.itemId) : null;
		if (!key) return;
		settings = { ...settings, allows: [...settings.allows.filter((e) => e.key !== key), { key, name: st.facts.name || undefined, at: Date.now() }] };
		changed();
		reapplyAll();
		void send({ type: 'allow', key, name: st.facts.name || undefined });
		ui().notice(`Always allowed. ${st.facts.name || 'This source'} is on My list allows.`);
	}

	/** Item tags carry their source when the card shows one; `source_id` is left out otherwise (contract 6.2). */
	function tagTarget(st: CardState, sourceLevel: boolean): Omit<TagRequest, 'verdict'> | null {
		const src = preferredSource(st.facts);
		const item = !sourceLevel && st.facts.itemId;
		if (!item && !src) return null;
		return {
			platform: platform!,
			targetType: item ? 'item' : 'source',
			targetId: item || src!,
			sourceId: item ? (src ?? undefined) : undefined,
			platformLabel: st.facts.aiLabel,
			name: st.facts.name || st.facts.title || undefined
		};
	}

	async function tagCard(card: Element, st: CardState, verdict: TagVerdict, sourceLevel = false, hold = false): Promise<Effective> {
		const t = tagTarget(st, sourceLevel);
		if (!t) return 'none';
		const key = targetKey(platform!, t.targetType, t.targetId);
		ownTags = new Map(ownTags).set(key, verdict);
		changed();
		reapplyAll();
		void send({ type: 'tag', tag: { ...t, verdict }, hold });
		if (verdict === 'not_slop' && sourceLevel) ui().notice('Tagged as not slop. Shown for you, and counted toward the shared list.');
		return states.get(card) ? effective(states.get(card)!) : 'none';
	}

	/**
	 * One tagging session sends one tag (the limit is 60 a minute): Slop applies and is queued at
	 * once but held while the menu is open, type and tests refine it here, and the final state
	 * replaces the queued tag when the menu closes.
	 */
	function tagMenu(anchor: HTMLElement, card: Element, st: CardState) {
		const base = tagTarget(st, false);
		let held: TagRequest | null = null;
		ui().tagMenu(anchor, {
			noun: noun(st.surface),
			reportHelp: pc.reportHelp,
			tag: (v) => {
				if (v === 'slop' && base) held = { ...base, verdict: 'slop' };
				return tagCard(card, st, v, false, v === 'slop');
			},
			detail: (slopType: SlopType | null, tests: Test[]) => {
				if (held) held = { ...held, slopType, tests };
			},
			close: () => {
				if (held) void send({ type: 'tag', tag: held }).catch(() => undefined);
				held = null;
			}
		});
	}

	function openReport() {
		if (!page) return;
		const items: { id: string; title: string }[] = [];
		for (const [card, st] of states) {
			if (!card.isConnected || !surfaces.includes(st.surface) || !st.facts.itemId) continue;
			if (st.facts.sourceIds.length && !st.facts.sourceIds.some((s) => page!.sourceIds.includes(s))) continue;
			if (!items.some((i) => i.id === st.facts.itemId)) items.push({ id: st.facts.itemId, title: st.facts.title });
		}
		const sourceId = page.sourceIds.find((s) => s.startsWith('UC')) ?? page.sourceIds[0]!;
		ui().report({
			platform: platform!,
			platformName: PLATFORM_NAME[platform!],
			sourceId,
			name: page.name,
			items,
			send: async (input) => {
				try {
					const r = await send<ReportReply>({
						type: 'report',
						report: { platform: platform!, sourceId, sourceName: page?.name || undefined, ...input }
					});
					return r.ok ? { ok: true } : r;
				} catch {
					return { ok: false, error: 'Could not reach Colander. Try again in a moment.' };
				}
			},
			openReports: () => void send({ type: 'open', page: 'options', section: 'reports' })
		});
	}

	// ---- Scanning, counts and activity -------------------------------------------------

	function reapplyAll() {
		for (const [card, st] of states) {
			if (!card.isConnected) {
				states.delete(card);
				continue;
			}
			st.decision = decide(st.facts, ctx);
			st.version = version;
			render(card, st);
		}
		placeReport();
	}

	function watch(card: Element, s: Surface) {
		if (s.mode === 'swipe' && !watched.has(card)) {
			watched.add(card);
			io.observe(card);
		}
	}

	function scanAll() {
		const t0 = performance.now();
		page = pageSource(platform!, pc.pages, document);
		for (const s of surfaces) {
			let cards: NodeListOf<Element>;
			try {
				cards = document.querySelectorAll(s.card);
			} catch {
				continue;
			}
			for (const c of cards) {
				if (states.get(c)?.surface && states.get(c)!.surface !== s && surfaces.includes(states.get(c)!.surface)) continue;
				process(c, s);
				watch(c, s);
			}
		}
		placeReport();
		record(performance.now() - t0);
	}

	function placeReport() {
		const want = !!page && !ctx.paused && !!page.rule.anchor;
		if (!want) {
			reportHost?.remove();
			reportHost = null;
			return;
		}
		if (reportHost?.isConnected) return;
		let at: Element | null = null;
		try {
			at = page!.rule.anchor!.sel ? document.querySelector(page!.rule.anchor!.sel) : null;
		} catch {
			at = null;
		}
		if (!at) return;
		reportHost = reportButton(noun(surfaces[0] ?? pc.surfaces[0]!), openReport);
		const place = page!.rule.anchor!.place;
		if (place === 'before') at.before(reportHost);
		else if (place === 'after') at.after(reportHost);
		else if (place === 'prepend') at.prepend(reportHost);
		else at.append(reportHost);
	}

	function record(ms: number) {
		batchMs.push(ms);
		if (batchMs.length > 2000) batchMs.splice(0, 1000);
	}

	let countsTimer = 0;
	let lastCounts = '';
	function counts(): PageCounts {
		const c = { hidden: 0, collapsed: 0, labeled: 0 };
		for (const [card, st] of states) {
			if (!card.isConnected || !surfaces.includes(st.surface)) continue;
			const a = effective(st);
			if (a === 'hide') c.hidden++;
			else if (a === 'collapse') c.collapsed++;
			else if (a === 'label') c.labeled++;
		}
		return c;
	}
	function scheduleCounts() {
		if (countsTimer) return;
		countsTimer = window.setTimeout(() => {
			countsTimer = 0;
			const c = counts();
			const key = JSON.stringify(c);
			if (key === lastCounts) return;
			lastCounts = key;
			void send({ type: 'counts', platform: platform!, counts: c }).catch(() => undefined);
		}, 120);
	}

	let activity: ActivityEntry[] = [];
	let activityTimer = 0;
	function queueActivity(st: CardState, action: Action) {
		activity.push({
			at: Date.now(),
			platform: platform!,
			itemId: st.facts.itemId,
			sourceId: preferredSource(st.facts),
			sourceName: st.facts.name,
			title: st.facts.title.slice(0, 200),
			verdict: st.decision.verdict,
			action,
			reason: st.decision.reason
		});
		if (activityTimer) return;
		activityTimer = window.setTimeout(() => {
			activityTimer = 0;
			const entries = activity;
			activity = [];
			void send({ type: 'activity', entries }).catch(() => undefined);
		}, 1000);
	}

	function pageState(): PageState {
		const actions: PageAction[] = [];
		let total = 0, withItem = 0, withSource = 0;
		const bySurface: PageState['bySurface'] = {};
		for (const [card, st] of states) {
			if (!card.isConnected || !surfaces.includes(st.surface)) continue;
			const b = (bySurface[st.surface.id] ??= { total: 0, withItem: 0, withSource: 0 });
			total++;
			b.total++;
			if (st.facts.itemId) (withItem++, b.withItem++);
			if (st.facts.sourceIds.length) (withSource++, b.withSource++);
			const d = st.decision;
			if (d.action !== 'hide' && d.action !== 'collapse' && d.action !== 'label') continue;
			actions.push({
				id: st.id,
				at: 0,
				platform: platform!,
				itemId: st.facts.itemId,
				sourceId: preferredSource(st.facts),
				sourceName: st.facts.name,
				title: st.facts.title,
				verdict: d.verdict,
				action: d.action,
				reason: d.reason,
				shown: st.shown,
				signals: d.signals
			});
		}
		const sorted = [...batchMs].sort((a, b) => a - b);
		return {
			platform: platform!,
			surfaces: surfaces.map((s) => s.id),
			mode: surfaces[0]?.mode ?? null,
			paused: { site: settings.pausedSites.includes(platform!), tab: tabPaused },
			counts: counts(),
			actions,
			source: page ? { platform: platform!, sourceIds: page.sourceIds, name: page.name } : null,
			cards: { total, withItem, withSource, tracked: states.size },
			bySurface,
			perf: {
				batches: sorted.length,
				totalMs: Math.round(sorted.reduce((a, b) => a + b, 0) * 100) / 100,
				p95Ms: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 100) / 100,
				maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100
			}
		};
	}

	// ---- Observation and navigation --------------------------------------------------------

	function onNavigate() {
		lastUrl = location.href;
		states.clear();
		reportHost?.remove();
		reportHost = null;
		surfaces = activeSurfaces(pc.surfaces, location.pathname);
		layer?.closePop(false);
		lastCounts = '';
		if (document.body) setDark(pageIsDark());
		scanAll();
		scheduleCounts();
	}

	const mo = new MutationObserver((records) => {
		if (!ready) return;
		const t0 = performance.now();
		if (location.href !== lastUrl) {
			onNavigate();
			return;
		}
		const touched = new Set<Element>();
		for (const r of records) {
			if (r.type === 'childList') {
				const t = r.target as Element;
				if (t.nodeType === 1 && t.nodeName !== 'COLANDER-UI') touched.add(t);
				for (const n of r.addedNodes) if (n.nodeType === 1 && n.nodeName !== 'COLANDER-UI') touched.add(n as Element);
			} else if (r.target.nodeType === 1) touched.add(r.target as Element);
		}
		const seen = new Set<Element>();
		for (const el of touched) {
			for (const s of surfaces) {
				let card: Element | null;
				try {
					card = el.closest(s.card);
				} catch {
					continue;
				}
				if (card && !seen.has(card)) {
					seen.add(card);
					process(card, s);
					watch(card, s);
				}
				if (el.firstElementChild) {
					for (const c of el.querySelectorAll(s.card)) {
						if (seen.has(c)) continue;
						seen.add(c);
						process(c, s);
						watch(c, s);
					}
				}
			}
		}
		if (page === null || !reportHost?.isConnected) {
			const before = page?.sourceIds.join();
			page = pageSource(platform!, pc.pages, document);
			if (page?.sourceIds.join() !== before) for (const [c, st] of states) if (st.surface.pageSource) process(c, st.surface, true);
			placeReport();
		}
		record(performance.now() - t0);
	});
	mo.observe(document, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['href', 'data-colander-bridge', 'data-more-menu-item-id', 'data-video-id']
	});

	const nav = (globalThis as { navigation?: EventTarget }).navigation;
	const checkNav = () => {
		if (ready && location.href !== lastUrl) onNavigate();
	};
	nav?.addEventListener('navigatesuccess', checkNav);
	addEventListener('popstate', checkNav);
	for (const ev of pc.navEvents ?? []) document.addEventListener(ev, checkNav);
	document.addEventListener('DOMContentLoaded', () => {
		setDark(pageIsDark());
		if (ready) scanAll();
	});
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setDark(pageIsDark()));

	// ---- Messages and storage ---------------------------------------------------------------

	chrome.runtime.onMessage.addListener((m: ToPage, _sender, reply) => {
		switch (m.type) {
			case 'page-state':
				reply(pageState());
				return;
			case 'show': {
				for (const [card, st] of states) {
					if (st.id !== m.id) continue;
					show(card, st);
					if (card instanceof HTMLElement) card.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
				}
				reply({ ok: true });
				return;
			}
			case 'tab-paused':
				tabPaused = m.paused;
				changed();
				reapplyAll();
				reply({ ok: true });
				return;
			case 'report-open':
				openReport();
				reply({ ok: !!page });
				return;
		}
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return;
		let dirty = false;
		if (changes[K.settings]) {
			settings = withDefaults(changes[K.settings]!.newValue as Partial<Settings>);
			for (const host of document.querySelectorAll('colander-ui[data-kind="chip"], colander-ui[data-kind="bar"]')) host.remove();
			for (const st of states.values()) {
				delete st.ui.chip;
				delete st.ui.bar;
			}
			dirty = true;
		}
		if (changes[K.ownTags]) (applyTags(changes[K.ownTags]!.newValue as Record<string, OwnTag>), (dirty = true));
		if (changes[K.listIndex]) (applyIndex(changes[K.listIndex]!.newValue as StoredIndex), (dirty = true));
		if (changes[K.entitlement]) (applyEntitlement(changes[K.entitlement]!.newValue as Entitlement), (dirty = true));
		if (changes[K.adapterConfig]) {
			applyConfig(changes[K.adapterConfig]!.newValue);
			onNavigate();
		}
		if (dirty) {
			changed();
			reapplyAll();
		}
	});

	void (async () => {
		const [stored, hello] = await Promise.all([
			chrome.storage.local.get([K.settings, K.ownTags, K.listIndex, K.adapterConfig, K.entitlement]),
			send<HelloReply>({ type: 'hello' }).catch(() => ({ tabPaused: false }))
		]);
		settings = withDefaults(stored[K.settings] as Partial<Settings>);
		applyTags(stored[K.ownTags] as Record<string, OwnTag>);
		applyIndex(stored[K.listIndex] as StoredIndex);
		applyEntitlement(stored[K.entitlement] as Entitlement);
		applyConfig(stored[K.adapterConfig]);
		tabPaused = !!hello?.tabPaused;
		changed();
		ready = true;
		if (document.body) setDark(pageIsDark());
		scanAll();
	})();

	// Keep the regular expression cache warm for this platform's surfaces.
	for (const s of pc.surfaces) rx(s.path);
}
