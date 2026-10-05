// The content script's controller: finds cards as they are inserted, decides what happens to
// each with the matching engine, and applies the treatment before the page paints. A hidden card
// leaves the page like an ad under an ad blocker: no gap, no placeholder. Grids reflow so their
// rows stay full, swipe feeds skip it, and the popup still lists it with Show.
import { INPAGE_COPY } from '@colander/shared/copy';
// Deep imports, not the inpage barrel: the barrel also carries the demo feed and its bundled
// thumbnail images, which belong to extension pages only (a build test checks).
import { hyper, pageIsDark, reducedMotion } from '@colander/shared/inpage/dom.ts';
import { inpageContext, makeHost, setTheme } from '@colander/shared/inpage/host.ts';
import { Layer, chip, reportPill, tagPill, type EvidenceActions } from '@colander/shared/inpage/ui.ts';
import { SLOP_TYPE_HINT, SLOP_TYPE_WORD, TEST_WORD, type Action, type SlopType, type TagVerdict, type Test } from '@colander/shared/verdicts';
import { Info, Undo2 } from 'lucide';
import defaults from '../adapters/default-config.json';
import { activeSurfaces, extractCard, pageSource, platformForHost, rx, type Extracted, type PageSource } from '../adapters/extract';
import type { AdapterConfig, Anchor, PlatformConfig, Surface } from '../adapters/schema';
import { b64decode } from '@colander/shared/bytes';
import { targetKey } from '@colander/shared/ids';
import { ListIndex } from '@colander/shared/list';
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
	ui: Partial<Record<'chip' | 'tag', HTMLElement>>;
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
	private shadow: ShadowRoot;
	/** The swipe card a skip notice belongs to: the notice sits on its player. */
	private over: Element | null = null;
	private overFrame = 0;

	constructor(ctx: ConstructorParameters<typeof Layer>[0]) {
		super(ctx);
		// The shared Layer keeps its shadow root to itself; the local additions go on it too.
		this.shadow = (this as unknown as { root: ShadowRoot }).root;
		adoptLocal(this.shadow);
		const follow = () => {
			if (!this.over) return;
			cancelAnimationFrame(this.overFrame);
			this.overFrame = requestAnimationFrame(() => this.placeOver());
		};
		addEventListener('scroll', follow, { capture: true, passive: true });
		addEventListener('resize', follow, { passive: true });
	}

	/** The next notice calls `onEnd` once it is gone. */
	whenNextEnds(onEnd: () => void) {
		this.next = onEnd;
	}

	override notice(t: Parameters<Layer['notice']>[0]) {
		super.notice(t);
		this.over = null;
		this.ended = this.next;
		this.next = null;
	}

	/**
	 * A skip notice on a swipe feed: 16 px below the top of the player in view, centered on it and at
	 * most 12 px in from its sides, so it reads as part of the player and leaves the platform's
	 * channel row and title at the bottom clear. It follows the player while the feed scrolls.
	 */
	noticeOver(t: Parameters<Layer['notice']>[0], card: Element) {
		this.notice(t);
		this.over = card;
		this.placeOver();
	}

	private placeOver() {
		const at = this.shadow.querySelector<HTMLElement>('.toast-at');
		const toast = at?.firstElementChild as HTMLElement | null;
		const card = this.over;
		if (!at || !toast || !card?.isConnected) return;
		// The playing video's box when the card has one, which leaves out a side column of actions.
		const video = [...card.querySelectorAll('video')].find((v) => v.getBoundingClientRect().width > 0);
		const r = (video ?? card).getBoundingClientRect();
		if (!r.width) return;
		toast.style.maxWidth = `${Math.min(448, r.width - 24)}px`;
		at.style.left = `${Math.round(r.left + r.width / 2)}px`;
		at.style.bottom = 'auto';
		at.style.top = `${Math.round(Math.min(Math.max(r.top, 0), innerHeight - toast.offsetHeight - 32) + 16)}px`;
	}

	override dismissNotice() {
		super.dismissNotice();
		this.over = null;
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
	let reads = 0;
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
		if (st.shown && a === 'hide') return st.decision.verdict ? 'label' : 'none';
		return a;
	}

	function process(card: Element, surface: Surface, force = false) {
		const prev = states.get(card);
		reads++;
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
			st = { id: nextId++, surface, facts, sig, decision: decide(facts, ctx), version, shown: false, counted: false, ui: {} };
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
		unslot(card);
		unguard(card);
	}

	// ---- Slots ------------------------------------------------------------------------

	const SLOT = 'data-colander-slot';
	/** Gone from the layout: a hidden card, or a wrapper hidden with one. */
	const isGone = (el: Element) => el.getAttribute('data-colander') === 'hide' || el.hasAttribute(SLOT);

	/**
	 * Hides the wrappers the page put around a hidden card: each ancestor that holds nothing else
	 * but Colander's UI and other hidden things, up to the first one with visible content. Without
	 * this a grid keeps the card's cell (Instagram, TikTok profiles, YouTube's Shorts shelf) as an
	 * empty tile. Returns the outermost wrapper hidden, or null.
	 */
	function slot(card: Element): Element | null {
		let outer: Element | null = null;
		for (let el = card.parentElement, from: Element = card; el && el !== document.body; from = el, el = el.parentElement) {
			const other = [...el.childNodes].some((n) =>
				n.nodeType === Node.TEXT_NODE ? !!n.textContent?.trim() : n instanceof Element && n !== from && n.nodeName !== 'COLANDER-UI' && !isGone(n)
			);
			if (other) break;
			el.setAttribute(SLOT, '');
			outer = el;
		}
		return outer;
	}

	/** Shows every wrapper a card's hiding took with it; returns the outermost, or null. */
	function unslot(card: Element): Element | null {
		let outer: Element | null = null;
		for (let el = card.parentElement?.closest(`[${SLOT}]`); el; el = el.parentElement?.closest(`[${SLOT}]`)) {
			el.removeAttribute(SLOT);
			outer = el;
		}
		return outer;
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

	/** Overlays pin to a corner of their anchor; every other place sits inline in the flow. */
	function insert(host: HTMLElement, at: { el: Element; place: Anchor['place'] }) {
		const { el, place } = at;
		if (place === 'overlay' || place === 'overlay-end') {
			if (getComputedStyle(el).position === 'static') el.setAttribute('data-colander-anchor', '');
			host.setAttribute('data-place', place);
			el.append(host);
			return;
		}
		host.setAttribute('data-place', 'inline');
		if (place === 'append') el.append(host);
		else if (place === 'prepend') el.prepend(host);
		else if (place === 'before') el.before(host);
		else {
			// After the anchor and after what Colander already put there, so the chip stays before the Tag button.
			let ref = el;
			while (ref.nextElementSibling?.nodeName === 'COLANDER-UI') ref = ref.nextElementSibling;
			ref.after(host);
		}
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

	const hidden = (st: CardState) => effective(st) === 'hide';
	// A card shown again with Show keeps saying it is hidden at this level.
	const view = (st: CardState) => itemView(st.decision, st.decision.action === 'hide', settings.plainChips);

	/** One shadow host per decorated element, holding one builder's element. `local` adds LOCAL_SHEET (ink pills, primary buttons). */
	function hostWith(kind: string, el: Element, local = false): HTMLElement {
		const { host, root } = makeHost(ip, kind);
		if (local) adoptLocal(root);
		root.append(el);
		return host;
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

		// Grids and lists drop the card from the layout; a swipe feed keeps its slot, which the
		// platform's own scroller counts on, shows nothing in it, and skips past it.
		const was = card.getAttribute('data-colander');
		const now = action === 'hide' ? (swipe ? 'skip' : 'hide') : null;
		if (now) card.setAttribute('data-colander', now);
		else card.removeAttribute('data-colander');
		// The page's own wrappers around a hidden card go with it, so its grid cell closes up too.
		const outer = now === 'hide' ? slot(card) : unslot(card);
		if (st.surface.mode === 'grid' && (was !== now || reflowed.size)) queueReflow((outer ?? card).parentElement);
		if (swipe && now) guard(card);
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
				insert(host, at);
				return true;
			}
		);

		// Every card with an item or a source gets the Tag button, also where the card shows no source.
		// It shows on hover and focus in grids and lists, and always in swipe feeds or when Appearance says so.
		const taggable = !!(st.facts.itemId || st.facts.sourceIds.length);
		ensure(
			st,
			'tag',
			taggable && !paused && action !== 'hide',
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
				insert(host, at);
				return true;
			}
		);

		if (!st.counted && (action === 'hide' || action === 'label') && st.decision.reason !== 'none') {
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

	/** The swipe card in view: the last one to become at least 60% visible. */
	let active: Element | null = null;
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
				const st = states.get(e.target);
				if (!st) continue;
				// Arrived from below when the card in view before it comes later in the feed.
				const cards = [...document.querySelectorAll(st.surface.card)];
				const up = !!active && cards.indexOf(active) > cards.indexOf(e.target);
				active = e.target;
				if (waiting !== e.target) waiting = null;
				if (effective(st) === 'hide') skip(e.target, st, up);
			}
		},
		{ threshold: [0, 0.6] }
	);
	const watched = new WeakSet<Element>();

	let skipRun: { n: number; at: number; kind?: 'slop' | 'ai_made' } = { n: 0, at: 0 };
	/** Swipe cards skipped once already: skips past them again say nothing, also after the page's URL moved on. */
	const noticed = new WeakSet<Element>();
	let lastSkipped: { card: Element; st: CardState } | null = null;
	/** A hidden card in view with nowhere to go yet: skipped as soon as the feed adds a card. */
	let waiting: Element | null = null;
	/**
	 * Moves past a hidden card every time it comes into view, in the direction of travel: back to the
	 * card before it when the person swiped back, else the platform's own next control or the next
	 * card; the other way when there is none. Silent, unless Appearance turns on the skip notice (Undo
	 * and Why), and then only the first time. Either way the popup lists the card with Show.
	 */
	function skip(card: Element, st: CardState, up = false) {
		const cards = [...document.querySelectorAll(st.surface.card)];
		const i = cards.indexOf(card);
		const prev = cards[i - 1];
		const next = cards[i + 1];
		const go = (el: Element) => (el.scrollIntoView({ block: 'start', behavior: reducedMotion(document) ? 'auto' : 'smooth' }), el);
		let button: HTMLElement | null = null;
		if (st.surface.next) {
			try {
				button = document.querySelector<HTMLElement>(st.surface.next);
			} catch {
				button = null;
			}
		}
		let to: Element;
		if (up && prev) to = go(prev);
		else if (button && button.getClientRects().length) {
			button.click();
			to = next ?? card;
		} else if (next) to = go(next);
		else if (prev) to = go(prev);
		else {
			waiting = card;
			return;
		}
		if (waiting === card) waiting = null;
		const first = !noticed.has(card);
		noticed.add(card);
		if (!settings.skipNotice || !first) return;
		const now = Date.now();
		const v = st.decision.verdict;
		const kind = v === 'ai_made' ? 'ai_made' : v ? 'slop' : undefined;
		skipRun = now - skipRun.at < 4000 ? { n: skipRun.n + 1, at: now, kind: skipRun.kind === kind ? kind : undefined } : { n: 1, at: now, kind };
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
		// One notice, never stacked: a new skip replaces it. It sits at the top of the player it skipped
		// to, clear of the platform's channel row and title at the bottom.
		l.noticeOver(
			{
				text: copy.skipped(n, word, skipRun.kind),
				verdict: st.decision.verdict ?? undefined,
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
			},
			to
		);
	}

	// ---- Grid reflow -------------------------------------------------------------------

	/**
	 * A hidden card leaves no box, so a flex or grid container closes up by itself. Two things it
	 * cannot fix alone: a full-width child, such as a shelf of Shorts, now follows a row with a hole
	 * at its end, and a page that styles its first column by position (YouTube's first-column
	 * margin) keeps that style on cards that moved out of it. So in each container with a hidden
	 * card, `order` holds every full-width child back until the row before it is full, and the
	 * first-column margin follows the first column. One layout read per frame for all containers;
	 * orders count up to -1, so a card the page appends before the next pass still lands last.
	 */
	const reflowed = new Set<Element>();
	/** Per container, the page's own left margin for its first column and for the others. */
	const margins = new WeakMap<Element, [number, number]>();
	const toReflow = new Set<Element>();
	let reflowFrame = 0;
	/** `el` holds cards: their parent, or a container the page just changed. */
	function queueReflow(el: Element | null) {
		if (el) toReflow.add(el);
		reflowFrame ||= requestAnimationFrame(reflowAll);
	}
	addEventListener('resize', () => {
		for (const box of reflowed) toReflow.add(box);
		reflowFrame ||= requestAnimationFrame(reflowAll);
	});

	/** The element whose box lays the card out: its parent, or further up past `display: contents`. */
	function layoutBox(el: Element): Element | null {
		let box: Element | null = el;
		while (box && getComputedStyle(box).display === 'contents') box = box.parentElement;
		return box;
	}
	/** The layout children of a box, in document order, looking through `display: contents`. */
	function layoutKids(box: Element): Element[] {
		return [...box.children].flatMap((k) => (getComputedStyle(k).display === 'contents' ? layoutKids(k) : [k]));
	}
	const px = (el: Element) => parseFloat(getComputedStyle(el).marginLeft) || 0;

	interface Plan {
		box: Element;
		order: Map<Element, number>;
		/** Cards and the left margin each should have, when the page styles its first column apart. */
		margin: Map<HTMLElement, number>;
	}

	function plan(box: Element): Plan | 'clear' | null {
		const cs = getComputedStyle(box);
		const flows = cs.display.endsWith('grid') || (cs.display.endsWith('flex') && cs.flexWrap.startsWith('wrap') && cs.flexDirection.startsWith('row'));
		const kids = layoutKids(box);
		const isCard = (k: Element) => states.has(k);
		const gone = isGone;
		if (!flows || !kids.some(gone)) return reflowed.has(box) ? 'clear' : null;
		if (!margins.has(box)) {
			// Read once, before any override: the first card is in the first column, the second is not.
			const cards = kids.filter(isCard);
			margins.set(box, [cards[0] ? px(cards[0]) : 0, cards[1] ? px(cards[1]) : 0]);
		}
		const width = box.getBoundingClientRect().width;
		const shown = kids.filter((k) => !gone(k) && getComputedStyle(k).display !== 'none');
		const rects = new Map(shown.map((k) => [k, k.getBoundingClientRect()]));
		// A child as wide as most of the box breaks the rows: a shelf, a header, a spinner.
		const breaks = (k: Element) => rects.get(k)!.width > width * 0.75;
		// Columns from the widths, not from the rows on screen: those are short where a card is gone.
		// A card's slot is its width with both margins; the widest slot is a column without the
		// first column's own margin.
		const gap = parseFloat(cs.columnGap) || 0;
		let slot = 0;
		for (const k of shown) {
			if (breaks(k)) continue;
			const m = getComputedStyle(k);
			slot = Math.max(slot, rects.get(k)!.width + (parseFloat(m.marginLeft) || 0) + (parseFloat(m.marginRight) || 0));
		}
		const cols = slot ? Math.max(1, Math.round((width + gap) / (slot + gap))) : 1;
		const order = new Map<Element, number>();
		const first = new Set<Element>();
		const held: Element[] = [];
		let n = 0;
		let col = 0;
		for (const k of shown) {
			if (breaks(k)) {
				if (col === 0) order.set(k, n++);
				else held.push(k);
				continue;
			}
			if (col === 0) first.add(k);
			order.set(k, n++);
			col = (col + 1) % cols;
			if (col === 0) for (const x of held.splice(0)) order.set(x, n++);
		}
		for (const x of held) order.set(x, n++);
		for (const [k, i] of order) order.set(k, i - n);
		const [m1, m2] = margins.get(box)!;
		const margin = new Map<HTMLElement, number>();
		if (m1 !== m2) for (const k of shown) if (isCard(k) && k instanceof HTMLElement) margin.set(k, first.has(k) ? m1 : m2);
		return { box, order, margin };
	}

	function clear(box: Element) {
		reflowed.delete(box);
		box.removeAttribute('data-colander-reflow');
		for (const k of layoutKids(box)) {
			if (!(k instanceof HTMLElement)) continue;
			k.style.removeProperty('order');
			k.style.removeProperty('margin-left');
		}
	}

	function reflowAll() {
		reflowFrame = 0;
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => (reflowFrame ||= requestAnimationFrame(reflowAll)), { once: true });
			return;
		}
		const t0 = performance.now();
		const boxes = new Set([...toReflow].flatMap((el) => (el.isConnected ? [layoutBox(el)] : [])).filter((b): b is Element => !!b));
		toReflow.clear();
		for (const box of reflowed) if (!box.isConnected) reflowed.delete(box);
		// Every read first, then every write, so the frame lays out once.
		const plans = [...boxes].map((box) => [box, plan(box)] as const);
		for (const [box, p] of plans) {
			if (p === 'clear') clear(box);
			if (!p || p === 'clear') continue;
			reflowed.add(box);
			box.setAttribute('data-colander-reflow', '');
			for (const [k, o] of p.order) if (k instanceof HTMLElement) k.style.setProperty('order', String(o), 'important');
			for (const [k, m] of p.margin) k.style.setProperty('margin-left', `${m}px`, 'important');
		}
		if (plans.length) record(performance.now() - t0);
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

	/** Why a card is hidden at this level, also once Show brought it back; or why it is labeled. */
	function evidenceFor(st: CardState, isHidden = st.decision.action === 'hide') {
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
		l.notice({ text: copy.tagged(verdict, effective(st)), actions: [{ label: copy.undo, icon: Undo2, onClick: () => (l.dismissNotice(), undoTag(t)) }] });
	}

	function tagMenu(anchor: HTMLElement, st: CardState) {
		const base = tagTarget(st, false);
		if (!base) return;
		let session: TagSession | null = null;
		const card = (anchor.getRootNode() as ShadowRoot).host?.closest('[data-colander-card]');
		const l = ui();
		l.tagMenu(anchor, noun(st.surface), {
			tag: (verdict) => {
				session = startTag({ ...base, verdict });
				return effective(st);
			},
			undo: () => session && undoTag(session),
			detail: (slopType: SlopType | null, tests: Test[]) => {
				if (session) session.req = { ...session.req, slopType, tests };
			},
			focusAfter: () => {
				// The card's own Tag button when Undo brought it back, else the next card still shown.
				const all = [...document.querySelectorAll('[data-colander-card]')];
				const from = card ? all.indexOf(card) : -1;
				for (const c of [...(card ? [card] : []), ...all.slice(from + 1)]) {
					if (c.hasAttribute('data-colander') || !c.getClientRects().length) continue;
					return c.querySelector('colander-ui[data-kind="tag"]')?.shadowRoot?.querySelector('button') ?? c.querySelector<HTMLElement>('a[href]');
				}
				return null;
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
		// The handle as the page writes it ("@NASA"): source IDs are lowercased to compare.
		let shown = /^\/(@[^/]+)/.exec(location.pathname)?.[1];
		try {
			shown &&= decodeURIComponent(shown);
		} catch {
			shown = undefined;
		}
		const at = page.sourceIds.find((x) => x.startsWith('@'));
		const handle = (at && shown?.toLowerCase() === at ? shown : at) ?? (platform === 'ig' ? `@${page.sourceIds[0]}` : page.name || sourceId);
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
		if (s.mode !== 'swipe' || watched.has(card)) return;
		watched.add(card);
		io.observe(card);
		// A new card gives a hidden card that is still in view somewhere to skip to.
		const w = waiting && waiting === active && states.get(waiting);
		if (w && waiting!.isConnected && effective(w) === 'hide') skip(waiting!, w);
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
		reportHost.setAttribute('data-place', place);
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
		const c = { hidden: 0, labeled: 0 };
		for (const [card, st] of states) {
			if (!card.isConnected || !surfaces.includes(st.surface)) continue;
			const a = effective(st);
			if (a === 'hide') c.hidden++;
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
			if (d.action !== 'hide' && d.action !== 'label') continue;
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
				maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
				reads
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
		// Each touched element maps to whether its subtree is new. Only added elements can hold new
		// cards; an element whose children or attributes changed only re-reads its own card. Also
		// scanning a changed list would re-read every earlier card on each append to an infinite feed.
		const touched = new Map<Element, boolean>();
		for (const r of records) {
			const t = r.target as Element;
			if (r.type !== 'childList') {
				if (t.nodeType === 1 && !touched.has(t)) touched.set(t, false);
				continue;
			}
			if (reflowed.has(t)) queueReflow(t);
			let ours = !r.removedNodes.length;
			for (const n of r.addedNodes) {
				if (n.nodeName === 'COLANDER-UI') continue;
				ours = false;
				if (n.nodeType === 1) touched.set(n as Element, true);
			}
			// A record that only adds Colander UI is this script's own insertion, not a page change.
			if (!ours && t.nodeType === 1 && t.nodeName !== 'COLANDER-UI' && !touched.has(t)) touched.set(t, false);
		}
		const seen = new Set<Element>();
		for (const [el, isNew] of touched) {
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
				if (isNew && el.firstElementChild) {
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
					const anchor = st.ui.chip?.shadowRoot?.querySelector<HTMLElement>('button');
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
			// Appearance changed: chips and Tag buttons are built again in the new look.
			if (before.plainChips !== settings.plainChips || before.alwaysTag !== settings.alwaysTag) {
				for (const st of states.values()) {
					for (const k of ['chip', 'tag'] as const) st.ui[k]?.remove();
					delete st.ui.chip;
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
