// The content script's controller: finds cards as they are inserted, decides what happens to
// each with the matching engine, and applies the treatment before the page paints.
import { INPAGE_COPY } from '@colander/shared/copy';
// Deep imports, not the inpage barrel: the barrel also carries the demo feed and its bundled
// thumbnail images, which belong to extension pages only (a build test checks).
import { hyper, pageIsDark, reducedMotion } from '@colander/shared/inpage/dom.ts';
import { inpageContext, makeHost, setTheme } from '@colander/shared/inpage/host.ts';
import { Layer, bar, chip, cover, gridStub, reportPill, tagPill, type EvidenceActions } from '@colander/shared/inpage/ui.ts';
import { SLOP_TYPE_HINT, SLOP_TYPE_WORD, TEST_WORD, type Action, type SlopType, type TagVerdict, type Test } from '@colander/shared/verdicts';
import { Info, Undo2 } from 'lucide';
import defaults from '../adapters/default-config.json';
import { activeSurfaces, extractCard, pageSource, platformForHost, rx, type Extracted, type PageSource } from '../adapters/extract';
import type { AdapterConfig, Anchor, PlatformConfig, Surface } from '../adapters/schema';
import { b64decode } from '../lib/bytes';
import { targetKey } from '../lib/ids';
import { ListIndex } from '../lib/list';
import { decide, type Decision, type MatchContext } from '../lib/match';
import type { ActivityEntry, HelloReply, PageAction, PageCounts, PageState, ReportReply, TagRequest, ToPage, ToWorker } from '../lib/messages';
import { SITE } from '../lib/env';
import { platformConfig } from '../lib/platforms';
import { isPlus, K, withDefaults, type Entitlement, type OwnTag, type Settings, type StoredIndex } from '../lib/settings';
import { itemView, whyEvidence } from './views';

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
	/** Where the thumbnail sits in the card, measured once before the first collapse. */
	geo?: Geo | null;
	ui: Partial<Record<'chip' | 'bar' | 'cover' | 'tag', HTMLElement>>;
}

/** The thumbnail's box inside the card's content box, in px: the bar starts at its left edge, the grid stub takes its footprint. */
interface Geo {
	x: number;
	y: number;
	w: number;
	h: number;
	tw: number;
}

type Effective = Action | 'none';

/** A tag from the tag menu or Why: applied at once, held while its toast can still undo or refine it. */
interface TagSession {
	req: TagRequest;
	key: string;
	queued: Promise<unknown>;
	undone: boolean;
	sent: boolean;
}

/**
 * Extension-only additions to the shared SHEET, adopted by every host this script makes:
 * - The Tag pill over media (thumbnails and swipe feeds) is ink, so it reads on any picture.
 * - On dark hosts and on ink, a primary button's hover and press mix toward ink, not toward the
 *   light text color, which would drop white text to 4.06:1. To move into parts.css.
 * - Dark hosts draw native checkboxes, radios and text fields dark too.
 */
const LOCAL_SHEET =
	":host([theme='dark']){color-scheme:dark}" +
	'.pill.ink{background:var(--cl-ink);color:var(--cl-on-ink)}.pill.ink:hover,.pill.ink[aria-expanded="true"]{box-shadow:inset 0 0 0 1px var(--cl-on-ink-muted)}' +
	":host([theme='dark']) .cl-b-p:hover,.cl-ink .cl-b-p:hover{background:color-mix(in srgb,var(--cl-brand-fill),var(--cl-ink) 12%)}" +
	":host([theme='dark']) .cl-b-p:active,.cl-ink .cl-b-p:active{background:color-mix(in srgb,var(--cl-brand-fill),var(--cl-ink) 20%)}";
let localSheet: CSSStyleSheet | null = null;
function adoptLocal(root: ShadowRoot) {
	if (!localSheet) {
		localSheet = new CSSStyleSheet();
		localSheet.replaceSync(LOCAL_SHEET);
	}
	root.adoptedStyleSheets = [...root.adoptedStyleSheets, localSheet];
}

/**
 * The shared layer, plus one callback when each toast ends: timed out, closed, replaced or undone.
 * The callback runs a tick later, so an Undo in the same click cancels what it would do.
 */
class PageLayer extends Layer {
	private next: (() => void) | null = null;
	private ended: (() => void) | null = null;

	constructor(ctx: ConstructorParameters<typeof Layer>[0]) {
		super(ctx);
		// The shared Layer keeps its shadow root to itself; the local additions go on it too.
		adoptLocal((this as unknown as { root: ShadowRoot }).root);
	}

	/** The next notice calls `onEnd` once it is gone. */
	whenNextEnds(onEnd: () => void) {
		this.next = onEnd;
	}

	override notice(t: Parameters<Layer['notice']>[0]) {
		super.notice(t);
		this.ended = this.next;
		this.next = null;
	}

	override dismissNotice() {
		super.dismissNotice();
		const f = this.ended;
		this.ended = null;
		if (f) setTimeout(f, 0);
	}

	/** Runs the current toast's end now, when the page goes away. */
	flush() {
		const f = this.ended;
		this.ended = null;
		f?.();
	}

	/** A button in the current toast, found by its word, to anchor Why; the toast then holds until closed. */
	toastButton(label: string): HTMLElement | null {
		const root = document.querySelector('colander-ui[data-kind="layer"]')?.shadowRoot;
		const toast = root?.querySelector('.cl-toast');
		toast?.querySelector('.cl-count')?.setAttribute('data-paused', '');
		return [...(toast?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === label) ?? null;
	}
}

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
	const ip = inpageContext(document, SITE);
	const copy = ip.strings;
	let layer: PageLayer | null = null;
	const ui = () => (layer ??= new PageLayer(ip));

	// Registered at document_start, before the page's own scripts, so Escape and the focus trap
	// of an open popover or dialog are handled before any site shortcut sees the key.
	addEventListener('keydown', (e) => layer?.onKey(e), true);
	// Leaving the page closes an open popover and sends a tag its toast still held.
	addEventListener('pagehide', () => {
		layer?.closePop(false);
		layer?.flush();
	});
	const theme = () => setTheme(document, pageIsDark(document) ? 'dark' : 'light');

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

	const noun = (sf: Surface) => (platform === 'yt' || platform === 'tt' ? 'video' : sf.mode === 'swipe' ? 'reel' : 'post');

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

	const hidden = (st: CardState) => effective(st) === 'hide' || effective(st) === 'collapse';
	const view = (st: CardState) => itemView(st.decision, hidden(st), settings.plainChips);

	/** One shadow host per decorated element, holding one builder's element. `local` adds LOCAL_SHEET (ink pills, primary buttons). */
	function hostWith(kind: string, el: Element, local = false): HTMLElement {
		const { host, root } = makeHost(ip, kind);
		if (local) adoptLocal(root);
		root.append(el);
		return host;
	}

	/**
	 * The one layout read per collapsed card: where its thumbnail sits in its content box. Cards
	 * collapsed in one task are measured together in the next animation frame, before it paints:
	 * their collapse is lifted, every rect is read in one layout, and the collapse goes back. Not
	 * before the document is parsed, when page styles may still be on their way.
	 */
	const toMeasure = new Set<Element>();
	let measureFrame = 0;
	function queueMeasure(card: Element) {
		toMeasure.add(card);
		measureFrame ||= requestAnimationFrame(measureAll);
	}
	function measureAll() {
		measureFrame = 0;
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => (measureFrame ||= requestAnimationFrame(measureAll)), { once: true });
			return;
		}
		const t0 = performance.now();
		const list = [...toMeasure].flatMap((card) => {
			const st = states.get(card);
			return st?.ui.bar && card.isConnected ? [{ card, st, bar: st.ui.bar, was: card.getAttribute('data-colander') }] : [];
		});
		toMeasure.clear();
		for (const m of list) {
			m.card.removeAttribute('data-colander');
			m.bar.style.setProperty('display', 'none', 'important');
		}
		const read = list.map((m) => ({ ...m, geo: rects(m.card, m.st) }));
		for (const m of read) {
			m.bar.style.removeProperty('display');
			if (m.was) m.card.setAttribute('data-colander', m.was);
			m.st.geo = m.geo;
			place(m.bar, m.geo, m.st.surface.mode === 'grid');
		}
		if (list.length) record(performance.now() - t0);
	}
	function rects(card: Element, st: CardState): Geo | null {
		const thumb = resolve(card, st.surface.chip, { place: 'overlay' })?.el ?? card;
		const c = card.getBoundingClientRect();
		const t = thumb.getBoundingClientRect();
		if (!c.width || !t.width || !t.height) return null;
		const cs = getComputedStyle(card);
		const left = c.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
		const right = c.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
		const top = c.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
		const x = Math.max(0, Math.round(t.left - left));
		const w = Math.round(right - left - x);
		return { x, y: Math.max(0, Math.round(t.top - top)), w, h: Math.round(t.height), tw: Math.min(Math.round(t.width), w) };
	}

	function place(host: HTMLElement, geo: Geo | null | undefined, grid: boolean) {
		if (!geo) return;
		host.style.setProperty('--cl-x', `${geo.x}px`);
		host.style.setProperty('--cl-y', `${geo.y}px`);
		host.style.setProperty('--cl-w', `${grid ? geo.tw : geo.w}px`);
		if (grid) host.style.setProperty('--cl-h', `${geo.h}px`);
	}

	function render(card: Element, st: CardState) {
		if (!card.isConnected) return;
		const action = effective(st);
		const swipe = st.surface.mode === 'swipe';
		const grid = st.surface.mode === 'grid';
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
		const reveal = { onShow: () => show(card, st), onWhy: (a: HTMLElement) => why(a, card, st) };
		// Lists keep a 40 px bar; grids keep the thumbnail's footprint, so the grid never moves.
		ensure(
			st,
			'bar',
			!swipe && action === 'collapse',
			card,
			() => {
				const host = hostWith(grid ? 'stub' : 'bar', (grid ? gridStub : bar)(ip, view(st), reveal), true);
				place(host, st.geo, grid);
				return host;
			},
			(host) => {
				card.prepend(host);
				return true;
			}
		);
		if (st.ui.bar && st.geo === undefined) queueMeasure(card);
		const covered = swipe && (action === 'hide' || action === 'collapse');
		ensure(
			st,
			'cover',
			covered,
			card,
			() => hostWith('cover', cover(ip, view(st), { ...reveal, onSkip: () => skip(card, st, false) }), true),
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
		ensure(
			st,
			'chip',
			action === 'label' && !!st.decision.verdict,
			card,
			() => hostWith('chip', chip(ip, view(st), { tone, onWhy: (a) => why(a, card, st) })),
			(host) => {
				const at = resolve(card, st.surface.chip, { place: 'overlay' });
				if (!at) return false;
				insert(host, at, 'inline');
				return true;
			}
		);

		// Every card with an item or a source gets the Tag button, also where the card shows no source.
		// It shows on hover and focus in grids and lists, and always in swipe feeds or when Appearance says so.
		const taggable = !!(st.facts.itemId || st.facts.sourceIds.length);
		ensure(
			st,
			'tag',
			taggable && !paused && !covered && action !== 'collapse' && action !== 'hide',
			card,
			() => {
				const ink = swipe || !!st.surface.tag?.place.startsWith('overlay');
				const pill = tagPill(ip, noun(st.surface), (a) => tagMenu(a, st));
				if (ink) pill.classList.add('ink');
				const host = hostWith('tag', pill, ink);
				if (!swipe && !settings.alwaysTag) host.setAttribute('data-reveal', '');
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
		else next?.scrollIntoView({ block: 'start', behavior: reducedMotion(document) ? 'auto' : 'smooth' });
		if (!auto) return;
		const now = Date.now();
		skipRun = now - skipRun.at < 4000 ? { n: skipRun.n + 1, at: now } : { n: 1, at: now };
		lastSkipped = { card, st };
		const n = skipRun.n;
		const word = noun(st.surface);
		const back = () => {
			const last = lastSkipped;
			skipRun = { n: 0, at: 0 };
			if (!last) return;
			last.st.shown = true;
			render(last.card, last.st);
			last.card.scrollIntoView({ block: 'start', behavior: reducedMotion(document) ? 'auto' : 'smooth' });
		};
		const l = ui();
		// One notice, never stacked: a new skip replaces it. In swipe feeds it sits above the player's controls.
		l.notice({
			text: st.decision.verdict ? copy.skipped(n, word) : `Skipped ${n} ${n === 1 ? word : `${word}s`}.`,
			verdict: st.decision.verdict ?? undefined,
			bottom: 96,
			actions: [
				{ label: copy.undo, icon: Undo2, onClick: () => (l.dismissNotice(), back()) },
				{
					label: copy.why,
					icon: Info,
					onClick: () => {
						const anchor = l.toastButton(copy.why);
						if (anchor) l.why(anchor, evidenceFor(st, true), actionsFor(card, st, back));
					}
				}
			]
		});
	}

	// ---- Actions from the UI ------------------------------------------------------------

	function show(card: Element, st: CardState, quiet = false) {
		st.shown = true;
		render(card, st);
		st.ui.chip?.shadowRoot?.querySelector<HTMLElement>('button')?.focus();
		if (quiet) return;
		const l = ui();
		l.notice({
			text: copy.shownAgain,
			actions: [{ label: copy.undo, icon: Undo2, onClick: () => (l.dismissNotice(), (st.shown = false), render(card, st)) }]
		});
	}

	function evidenceFor(st: CardState, isHidden = hidden(st)) {
		return whyEvidence(st.decision, { hidden: isHidden, platform: platform!, sourceId: preferredSource(st.facts), site: SITE });
	}

	function actionsFor(card: Element, st: CardState, showIt?: () => void): EvidenceActions {
		const d = st.decision;
		return {
			show: showIt ?? (hidden(st) ? () => show(card, st) : undefined),
			allow: d.reason !== 'allowed' ? () => allow(st) : undefined,
			notSlop: d.verdict && d.verdict !== 'clear' ? () => tagWithToast(st, 'not_slop', d.reason === 'source_list') : undefined
		};
	}

	function why(anchor: HTMLElement, card: Element, st: CardState) {
		ui().why(anchor, evidenceFor(st), actionsFor(card, st));
	}

	function allow(st: CardState) {
		const src = preferredSource(st.facts);
		const key = src ? targetKey(platform!, 'source', src) : st.facts.itemId ? targetKey(platform!, 'item', st.facts.itemId) : null;
		if (!key) return;
		settings = { ...settings, allows: [...settings.allows.filter((e) => e.key !== key), { key, name: st.facts.name || undefined, at: Date.now() }] };
		changed();
		reapplyAll();
		void send({ type: 'allow', key, name: st.facts.name || undefined });
		const l = ui();
		l.notice({
			text: `Always allowed. ${st.facts.name || 'This source'} is on My list allows.`,
			actions: [{ label: copy.undo, icon: Undo2, onClick: () => (l.dismissNotice(), void send({ type: 'unlist', list: 'allows', key })) }]
		});
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

	/**
	 * One click applies a tag on this device at once. It is queued but held while its toast is up,
	 * so Undo drops it and Add detail refines it; one tag goes out when the toast ends (the limit
	 * is 60 a minute). A held tag the page never released goes out after 5 minutes.
	 */
	function startTag(req: TagRequest): TagSession {
		const key = targetKey(req.platform, req.targetType, req.targetId);
		ownTags = new Map(ownTags).set(key, req.verdict);
		changed();
		reapplyAll();
		const queued = send({ type: 'tag', tag: req, hold: true }).catch(() => undefined);
		const t: TagSession = { req, key, queued, undone: false, sent: false };
		ui().whenNextEnds(() => release(t));
		return t;
	}

	function release(t: TagSession) {
		if (t.undone || t.sent) return;
		t.sent = true;
		void t.queued.then(() => send({ type: 'tag', tag: t.req })).catch(() => undefined);
	}

	function undoTag(t: TagSession) {
		t.undone = true;
		const next = new Map(ownTags);
		next.delete(t.key);
		ownTags = next;
		changed();
		reapplyAll();
		void t.queued.then(() => send({ type: 'untag', key: t.key })).catch(() => undefined);
	}

	/** Not slop from Why: the same tag, confirmed by a toast with Undo. */
	function tagWithToast(st: CardState, verdict: TagVerdict, sourceLevel: boolean) {
		const base = tagTarget(st, sourceLevel);
		if (!base) return;
		const t = startTag({ ...base, verdict });
		const l = ui();
		l.notice({ text: copy.tagged[verdict], actions: [{ label: copy.undo, icon: Undo2, onClick: () => (l.dismissNotice(), undoTag(t)) }] });
	}

	function tagMenu(anchor: HTMLElement, st: CardState) {
		const base = tagTarget(st, false);
		if (!base) return;
		let session: TagSession | null = null;
		const l = ui();
		l.tagMenu(anchor, noun(st.surface), {
			tag: (verdict) => {
				session = startTag({ ...base, verdict });
			},
			undo: () => session && undoTag(session),
			detail: (slopType: SlopType | null, tests: Test[]) => {
				if (session) session.req = { ...session.req, slopType, tests };
			}
		});
		// Scams and deepfakes are beyond slop: a shortcut to the platform's own reporting.
		// Extension-only addition to the shared tag menu.
		const menu = document.querySelector('colander-ui[data-kind="layer"]')?.shadowRoot?.querySelector('.cl-pop.menu');
		if (menu && pc.reportHelp) {
			const h = hyper(document);
			const p = h('p', { class: 'cl-ev-links scam' }, h('a', { class: 'cl-link', href: pc.reportHelp, target: '_blank', rel: 'noopener noreferrer' }, 'This is a scam or deepfake'));
			// CSSOM, not a style attribute, so a host page's style-src cannot drop it.
			p.style.padding = '0 8px 4px';
			menu.append(p);
		}
	}

	/** The report's reason: the note, or the type and tests chosen, so reviewers know what to look for. */
	function reportReason(note: string, slopType: SlopType | null, tests: Test[]): string {
		if (note) return note.slice(0, 500);
		const parts = [slopType && `${SLOP_TYPE_WORD[slopType]}: ${SLOP_TYPE_HINT[slopType].toLowerCase()}`, tests.length && tests.map((x) => TEST_WORD[x]).join(', ')].filter(Boolean);
		return parts.length ? `${parts.join('. ')}.` : '';
	}

	function openReport() {
		if (!page) return;
		const items: { id: string; title: string; thumb?: string }[] = [];
		for (const [card, st] of states) {
			if (!card.isConnected || !surfaces.includes(st.surface) || !st.facts.itemId) continue;
			if (st.facts.sourceIds.length && !st.facts.sourceIds.some((x) => page!.sourceIds.includes(x))) continue;
			if (items.some((i) => i.id === st.facts.itemId)) continue;
			// Only pictures the page already shows: no new requests to anyone.
			const img = card.querySelector<HTMLImageElement>('img[src^="https:"]');
			items.push({ id: st.facts.itemId, title: st.facts.title, thumb: img?.src });
		}
		const sourceId = page.sourceIds.find((x) => x.startsWith('UC')) ?? page.sourceIds[0]!;
		const at = page.sourceIds.find((x) => x.startsWith('@'));
		const handle = at ?? (platform === 'ig' ? `@${page.sourceIds[0]}` : page.name || sourceId);
		ui().report({
			handle,
			items,
			noun: platform === 'yt' || platform === 'tt' ? 'video' : 'post',
			send: async (input) => {
				const reason = reportReason(input.note, input.slopType, input.tests);
				if (!reason) return { ok: false, error: 'Choose a type or a test, or add a note, so reviewers know what to look for.' };
				try {
					const r = await send<ReportReply>({
						type: 'report',
						report: { platform: platform!, sourceId, sourceName: page?.name || undefined, examples: input.examples, reason, slopType: input.slopType, tests: input.tests }
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
		reportHost = hostWith('report', reportPill(ip, openReport));
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
		if (document.body) theme();
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
		theme();
		if (ready) scanAll();
	});
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme);

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
					if (card instanceof HTMLElement) card.scrollIntoView({ block: 'center', behavior: reducedMotion(document) ? 'auto' : 'smooth' });
				}
				reply({ ok: true });
				return;
			}
			case 'why': {
				for (const [card, st] of states) {
					if (st.id !== m.id) continue;
					if (effective(st) === 'hide') show(card, st, true);
					if (card instanceof HTMLElement) card.scrollIntoView({ block: 'center', behavior: 'auto' });
					const anchor =
						st.ui.chip?.shadowRoot?.querySelector<HTMLElement>('button') ??
						[...(st.ui.bar?.shadowRoot?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === copy.why);
					if (anchor) why(anchor, card, st);
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
			const before = settings;
			settings = withDefaults(changes[K.settings]!.newValue as Partial<Settings>);
			// Appearance changed: chips, bars and Tag buttons are built again in the new look.
			if (before.plainChips !== settings.plainChips || before.alwaysTag !== settings.alwaysTag) {
				for (const st of states.values()) {
					for (const k of ['chip', 'bar', 'tag'] as const) st.ui[k]?.remove();
					delete st.ui.chip;
					delete st.ui.bar;
					delete st.ui.tag;
				}
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
		if (document.body) theme();
		scanAll();
	})();

	// Keep the regular expression cache warm for this platform's surfaces.
	for (const s of pc.surfaces) rx(s.path);
}
