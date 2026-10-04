// In-page builders: chip, Tag and Report pills, the evidence popover, the tag menu, the detail and
// report sheets, and the toast. Hidden items get no builder: they leave the page with no trace. Each takes a
// context { doc, site, fmt, strings } and callbacks, returns plain elements, and never touches
// chrome.* or the global document, so the website runs the same code at prerender.
// Layer keeps one popover, one sheet and one toast at a time above the page.
import type { IconNode } from 'lucide';
import { ArrowRight, Check, CircleAlert, Eye, Flag, Image as ImageIcon, Play, Tag, Undo2, X } from 'lucide';
import { TAG_GLYPH, TAG_MEANING } from '../copy';
import {
	SLOP_TYPES,
	SLOP_TYPE_HINT,
	SLOP_TYPE_WORD,
	TAG_WORD,
	TESTS,
	TEST_HINT,
	TEST_WORD,
	VERDICT_PLAIN,
	VERDICT_WORD,
	type SlopType,
	type TagVerdict,
	type Test,
	type Verdict
} from '../verdicts';
import { glyph, hyper, icon, menuKeys, trapFocus, uid, type Child } from './dom';
import { keepTogether, popoverRows, type Evidence } from './evidence';
import { makeHost, type InpageContext } from './host';

/** What a decorated card shows. The extension maps its match decision onto this. */
export interface ItemView {
	verdict: Verdict | null;
	/** The chip word when there is no verdict, such as "Your rule". */
	word?: string;
	/** Larger, plain-language chips (Appearance setting). */
	plain?: boolean;
	/** Hidden at this level and shown again, as opposed to labeled: names what Why explains. */
	hidden?: boolean;
}

type Btn = { label: string; icon?: IconNode; onClick?: () => void; kind?: 'p' | 's' | 'q'; sm?: boolean; attrs?: Record<string, string | undefined> };

/**
 * Pages that rebuild the UI (the website's demo) name its controls, so focus survives a rebuild
 * and a closed popover hands focus back to its anchor: `key` gives data-k values such as "why-6".
 * `expanded` and `controls` wire the Why anchor to its open popover.
 */
export type Anchor = { key?: string | number; expanded?: boolean; controls?: string };

const k = (prefix: string, key?: string | number) => (key == null ? undefined : `${prefix}-${key}`);
const whyAttrs = (a: Anchor) => ({
	'aria-haspopup': 'dialog',
	'aria-expanded': a.expanded ? 'true' : 'false',
	'aria-controls': a.expanded ? a.controls : undefined,
	'data-k': k('why', a.key)
});

const chipWord = (v: ItemView) => (v.verdict ? (v.plain ? VERDICT_PLAIN : VERDICT_WORD)[v.verdict] : (v.word ?? 'Your rule'));

/** A button in the shared style: primary, secondary or quiet; 32 tall, or 28 when small. */
export function button(ctx: InpageContext, b: Btn): HTMLButtonElement {
	const h = hyper(ctx.doc);
	return h(
		'button',
		{ type: 'button', class: `cl-b cl-b-${b.kind ?? 'q'}${b.sm ? ' cl-b-sm' : ''}`, onclick: b.onClick && (() => b.onClick!()), ...b.attrs },
		b.icon ? icon(ctx.doc, b.icon) : null,
		b.label
	);
}

/** Verdict chip. With `onWhy` it is a button that opens the evidence popover. */
export function chip(
	ctx: InpageContext,
	v: ItemView,
	opts: { tone?: 'ink' | 'tint'; size?: 'sm' | 'md' | 'lg'; onWhy?: (anchor: HTMLElement) => void } & Anchor = {}
): HTMLElement {
	const h = hyper(ctx.doc);
	const size = opts.size ?? (v.plain ? 'lg' : 'md');
	const word = chipWord(v);
	const cls = `cl-chip cl-chip-${size} ${v.verdict ? `cl-chip-${opts.tone ?? 'tint'}` : 'cl-chip-none'}`;
	const kids: Child[] = [v.verdict ? glyph(ctx.doc, v.verdict, size === 'lg' ? 14 : 12) : null, h('span', {}, word)];
	const data = v.verdict ?? undefined;
	if (!opts.onWhy) return h('span', { class: cls, 'data-v': data }, ...kids);
	const btn = h(
		'button',
		{ type: 'button', class: cls, 'data-v': data, ...whyAttrs(opts), 'aria-label': ctx.strings.chipName(word, !!v.hidden) },
		...kids,
		h('span', { class: 'why', 'aria-hidden': 'true' }, ctx.strings.why)
	);
	btn.addEventListener('click', () => opts.onWhy!(btn));
	return btn;
}

/** The 28 px Tag pill. The host page's own CSS shows it on card hover and focus-within. */
export function tagPill(ctx: InpageContext, noun: string, onOpen: (anchor: HTMLElement) => void): HTMLButtonElement {
	const h = hyper(ctx.doc);
	const btn = h(
		'button',
		{ type: 'button', class: 'pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': ctx.strings.tagTitle(noun) },
		icon(ctx.doc, Tag),
		ctx.strings.tag
	);
	btn.addEventListener('click', () => onOpen(btn));
	return btn;
}

/** The 28 px Report source pill on channel, profile and page headers. */
export function reportPill(ctx: InpageContext, onOpen: () => void): HTMLButtonElement {
	const h = hyper(ctx.doc);
	return h(
		'button',
		{ type: 'button', class: 'pill', 'aria-haspopup': 'dialog', onclick: () => onOpen() },
		icon(ctx.doc, Flag),
		ctx.strings.reportSource
	);
}

export interface EvidenceActions {
	show?: () => void;
	allow?: () => void;
	notSlop?: () => void;
}

/**
 * Why: the signals that agreed, the list and the date, Show, Always allow and Not slop, and the
 * source and appeal links. `key` names the popover ("pop-6") and its actions for pages that
 * rebuild it; `id` is what the anchor's aria-controls points at.
 */
export function evidencePopover(
	ctx: InpageContext,
	ev: Evidence,
	x: EvidenceActions = {},
	opts: { flat?: boolean; key?: string | number; id?: string } = {}
): HTMLElement {
	const h = hyper(ctx.doc);
	const s = ctx.strings;
	const titleId = uid('ev');
	const attrs = (name: string) => ({ 'data-k': k(`pop-${name}`, opts.key) });
	const actions = [
		x.show && button(ctx, { label: s.show, icon: Eye, sm: true, onClick: x.show, attrs: attrs('show') }),
		x.allow && button(ctx, { label: s.alwaysAllow, icon: Check, sm: true, onClick: x.allow, attrs: attrs('allow') }),
		x.notSlop && button(ctx, { label: s.notSlop, icon: Tag, sm: true, onClick: x.notSlop, attrs: attrs('notslop') })
	].filter(Boolean) as HTMLElement[];
	// The website's demo has invented sources with no pages: there the links are plain words, so
	// nothing looks clickable that is not.
	const link = (href: string, text: string, arrow = false): Child =>
		ev.inertLinks
			? h('span', { class: 'cl-link-inert' }, text)
			: h('a', { class: 'cl-link', href, target: '_blank', rel: 'noopener' }, text, arrow && icon(ctx.doc, ArrowRight));
	const links: Child[] = [ev.sourceUrl && link(ev.sourceUrl, s.sourcePage, true), ev.appealUrl && link(ev.appealUrl, ev.appealText ?? '')];
	return h(
		'div',
		{ class: `cl-pop${opts.flat ? ' cl-flat' : ''}`, role: 'dialog', 'aria-labelledby': titleId, id: opts.id, 'data-k': k('pop', opts.key) },
		h(
			'div',
			{ class: 'cl-ev-head' },
			chip(ctx, { verdict: ev.verdict, word: ev.word ?? undefined }, { tone: 'tint' }),
			h('h2', { class: 'cl-ev-title', id: titleId }, ev.title)
		),
		h(
			'ul',
			{ class: 'cl-ev-rows' },
			...popoverRows(ev).map((r) =>
				h(
					'li',
					{ class: 'cl-ev-row', 'data-agreed': String(r.agreed) },
					h('span', {}, h('b', {}, `${r.label}:`), ' ', ...keepTogether(r.texts[0]!).map((p, i) => (i % 2 ? h('span', { class: 'cl-nw' }, p) : p)))
				)
			)
		),
		ev.list ? h('p', { class: 'cl-ev-list' }, ev.list) : null,
		actions.length ? h('hr', { class: 'cl-ev-rule' }) : null,
		actions.length ? h('div', { class: 'cl-ev-actions' }, ...actions) : null,
		links.some(Boolean) ? h('p', { class: 'cl-ev-links' }, ...links) : null
	);
}

const TAGS: TagVerdict[] = ['slop', 'ai_fine', 'not_slop'];

/** Tag this video: three choices; one click applies the tag. */
export function tagMenu(ctx: InpageContext, noun: string, onTag: (verdict: TagVerdict) => void): HTMLElement {
	const h = hyper(ctx.doc);
	const titleId = uid('tag');
	const list = h(
		'div',
		{ role: 'menu', 'aria-labelledby': titleId },
		...TAGS.map((t) =>
			h(
				'button',
				{ type: 'button', class: 'opt', role: 'menuitem', tabindex: -1, onclick: () => onTag(t) },
				glyph(ctx.doc, TAG_GLYPH[t], 16),
				h('span', {}, h('b', {}, TAG_WORD[t]), h('small', {}, TAG_MEANING[t]))
			)
		)
	);
	list.addEventListener('keydown', (e) => menuKeys(list, e));
	return h('div', { class: 'cl-pop menu' }, h('h2', { id: titleId }, ctx.strings.tagTitle(noun)), list, h('p', { class: 'note' }, ctx.strings.tagCounts));
}

function choices<T extends string>(
	ctx: InpageContext,
	legend: string,
	type: 'radio' | 'checkbox',
	items: readonly T[],
	word: Record<T, string>,
	hint: Record<T, string>,
	cls: string
): { el: HTMLElement; picked: () => T[] } {
	const h = hyper(ctx.doc);
	const name = uid('f');
	const inputs = items.map((v) => h('input', { type, name, value: v }));
	const el = h(
		'fieldset',
		{},
		h('legend', {}, legend),
		h('div', { class: 'stack' }, ...items.map((v, i) => h('label', { class: cls }, inputs[i], h('span', {}, h('b', {}, word[v]), h('small', {}, hint[v])))))
	);
	return { el, picked: () => items.filter((_, i) => inputs[i]!.checked) };
}

/** Add detail: an optional type and tests for a Slop tag. */
export function detailSheet(ctx: InpageContext, onSave: (type: SlopType | null, tests: Test[]) => void): HTMLElement {
	const h = hyper(ctx.doc);
	const s = ctx.strings;
	const titleId = uid('detail');
	const type = choices(ctx, s.type, 'radio', SLOP_TYPES, SLOP_TYPE_WORD, SLOP_TYPE_HINT, 'check choice');
	const tests = choices(ctx, s.tests, 'checkbox', TESTS, TEST_WORD, TEST_HINT, 'check');
	const form = h(
		'form',
		{ class: 'cl-pop sheet', role: 'dialog', 'aria-labelledby': titleId },
		h('h2', { id: titleId }, s.addDetail),
		type.el,
		tests.el,
		h('div', { class: 'foot' }, h('button', { type: 'submit', class: 'cl-b cl-b-p' }, s.save))
	);
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		onSave(type.picked()[0] ?? null, tests.picked());
	});
	return form;
}

export interface ReportSheetInput {
	/** "@romefacts.minute", or the page name. */
	handle: string;
	/** Items already on the page; thumbnails reuse the page's own image URLs. */
	items: { id: string; title: string; thumb?: string }[];
	/** The platform's item noun, shown where an item has no thumbnail: "video" or "post". */
	noun: string;
	send(input: { examples: string[]; slopType: SlopType | null; tests: Test[]; note: string }): Promise<{ ok: true } | { ok: false; error: string }>;
	openReports(): void;
}

/** Report source, in two steps, ending on a receipt. */
export function reportSheet(ctx: InpageContext, r: ReportSheetInput, close: () => void): HTMLElement {
	const h = hyper(ctx.doc);
	const s = ctx.strings.report;
	const titleId = uid('report');
	const steps = (n: number) =>
		h('span', { class: 'steps' }, h('i', { class: 'on' }), h('i', { class: n === 2 ? 'on' : '' }), ctx.strings.report.step(n));
	const head = (n: number | null) =>
		h(
			'div',
			{ class: 'head' },
			h('h2', { id: titleId }, s.title(r.handle)),
			n ? steps(n) : null
		);
	const picked = new Set<string>();
	const boxes = r.items.slice(0, 6).map((it) => {
		const input = h('input', { type: 'checkbox', value: it.id });
		input.addEventListener('change', () => {
			if (input.checked) picked.add(it.id);
			else picked.delete(it.id);
			for (const b of boxes) b.disabled = !b.checked && picked.size >= 3;
		});
		return input;
	});
	// Pages load thumbnails lazily, so a tile often has none: a neutral square with the item's icon.
	const tiles = r.items.slice(0, 6).map((it, i) =>
		h(
			'label',
			{ class: 'tile' },
			boxes[i],
			it.thumb
				? h('img', { src: it.thumb, alt: '', width: 48, height: 48, loading: 'lazy' })
				: h('span', { class: 'ph', 'aria-hidden': 'true' }, icon(ctx.doc, r.noun === 'video' ? Play : ImageIcon)),
			h('span', { title: it.title }, it.title || it.id)
		)
	);
	const type = choices(ctx, ctx.strings.type, 'radio', SLOP_TYPES, SLOP_TYPE_WORD, SLOP_TYPE_HINT, 'check choice');
	const tests = choices(ctx, ctx.strings.tests, 'checkbox', TESTS, TEST_WORD, TEST_HINT, 'check');
	const noteId = uid('note');
	const note = h('textarea', { id: noteId, rows: 3, maxlength: 500, placeholder: s.notePlaceholder });
	const error = h('p', { class: 'err', role: 'alert' });
	const send = h('button', { type: 'submit', class: 'cl-b cl-b-p' }, s.send);

	const step1 = h(
		'div',
		{ class: 'sheet' },
		head(1),
		h('div', { class: 'body' }, h('fieldset', {}, h('legend', {}, s.examples), h('div', { class: 'tiles' }, ...tiles))),
		h('div', { class: 'foot' }, button(ctx, { label: ctx.strings.close, kind: 's', onClick: close }), button(ctx, { label: s.next, kind: 'p', onClick: () => go(step2) }))
	);
	const step2 = h(
		'form',
		{ class: 'sheet' },
		head(2),
		h('div', { class: 'body' }, h('p', { class: 't' }, s.why), type.el, tests.el, h('div', { class: 'stack' }, h('label', { for: noteId, class: 't' }, s.note), note), error),
		h('div', { class: 'foot' }, button(ctx, { label: s.back, kind: 's', onClick: () => go(step1) }), send)
	);
	error.hidden = true;
	const sheet = h('div', { class: 'cl-pop float report', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, step1);
	function go(step: HTMLElement) {
		sheet.replaceChildren(step);
		step.querySelector<HTMLElement>('input, textarea, button')?.focus();
	}
	step2.addEventListener('submit', async (e) => {
		e.preventDefault();
		send.disabled = true;
		send.textContent = s.sending;
		const res = await r.send({ examples: [...picked], slopType: type.picked()[0] ?? null, tests: tests.picked(), note: note.value.trim() });
		send.disabled = false;
		send.textContent = s.send;
		if (!res.ok) {
			error.hidden = false;
			error.replaceChildren(icon(ctx.doc, CircleAlert), h('span', {}, res.error));
			return;
		}
		const mine = h(
			'button',
			{ type: 'button', class: 'cl-b cl-b-q', onclick: () => (close(), r.openReports()) },
			s.myReports,
			icon(ctx.doc, ArrowRight)
		);
		go(h('div', { class: 'sheet', role: 'status' }, head(null), h('div', { class: 'body' }, h('p', {}, s.received)), h('div', { class: 'foot' }, mine)));
	});
	return sheet;
}

export interface ToastInput {
	text: string;
	/** Adds the verdict glyph in its media color, as on the skip notice. */
	verdict?: Verdict;
	actions?: { label: string; icon?: IconNode; onClick: () => void }[];
	onClose?: () => void;
	/** Fires when the 4-dot countdown ends (4 s, paused on hover and focus). */
	onTimeout?: () => void;
	/** Holds the countdown at full, for static pictures. */
	paused?: boolean;
}

/** Toast and skip notice: ink, 44 tall, actions, a 4-dot countdown and Close. */
export function toast(ctx: InpageContext, t: ToastInput): HTMLElement {
	const h = hyper(ctx.doc);
	const count = h('span', { class: 'cl-count', 'aria-hidden': 'true', 'data-paused': t.paused || undefined }, h('i'), h('i'), h('i'), h('i'));
	count.firstChild!.addEventListener('animationend', () => t.onTimeout?.());
	return h(
		'div',
		{ class: 'cl-toast cl-ink', role: 'status', 'aria-live': 'polite', 'data-v': t.verdict },
		t.verdict ? glyph(ctx.doc, t.verdict, 16) : null,
		h('span', { class: 'cl-toast-t' }, t.text),
		h(
			'span',
			{ class: 'cl-toast-end' },
			...(t.actions ?? []).map((a) => button(ctx, { label: a.label, icon: a.icon, sm: true, onClick: a.onClick })),
			count,
			h('button', { type: 'button', class: 'cl-b cl-x', 'aria-label': ctx.strings.close, onclick: () => t.onClose?.() }, icon(ctx.doc, X))
		)
	);
}

export interface TagHandlers {
	/** Applies the tag at once. */
	tag(verdict: TagVerdict): Promise<unknown> | void;
	undo(): void;
	/** Refines a Slop tag with an optional type and tests. */
	detail(type: SlopType | null, tests: Test[]): void;
	/** The menu closed without a choice, or after one. */
	close?(): void;
	/**
	 * Where keyboard focus goes when the toast ends after the tagged card left the page with its Tag
	 * button: the card's own Tag button when Undo brought it back, else the next card.
	 */
	focusAfter?(): HTMLElement | null;
}

/** The full-page layer: one popover or sheet, one toast and one report at a time. */
export class Layer {
	private host: HTMLElement;
	private root: ShadowRoot;
	private box: HTMLElement;
	private pop: { el: HTMLElement; anchor: HTMLElement; onClose?: () => void } | null = null;
	private toastEl: HTMLElement | null = null;
	private dialog: { el: HTMLElement; restore: HTMLElement | null } | null = null;
	/** Set while a toast holds focus that the page lost: where focus goes when the toast ends. */
	private afterToast: (() => HTMLElement | null) | null = null;
	/** The last input was a key, not a pointer. */
	private keyed = false;
	private raf = 0;
	private off: (() => void)[] = [];

	constructor(private ctx: InpageContext) {
		const { host, root } = makeHost(ctx, 'layer');
		this.host = host;
		this.root = root;
		this.box = hyper(ctx.doc)('div', { class: 'layer' });
		root.append(this.box);
		const win = ctx.doc.defaultView!;
		const down = (e: PointerEvent) => {
			this.keyed = false;
			if (this.pop && !e.composedPath().some((n) => n === this.pop!.el || n === this.pop!.anchor)) this.closePop(false);
		};
		const follow = () => {
			win.cancelAnimationFrame(this.raf);
			this.raf = win.requestAnimationFrame(() => this.place());
		};
		ctx.doc.addEventListener('pointerdown', down, true);
		win.addEventListener('scroll', follow, { capture: true, passive: true });
		win.addEventListener('resize', follow, { passive: true });
		this.off.push(
			() => ctx.doc.removeEventListener('pointerdown', down, true),
			() => win.removeEventListener('scroll', follow, { capture: true }),
			() => win.removeEventListener('resize', follow)
		);
	}

	destroy() {
		for (const f of this.off) f();
		this.host.remove();
	}

	private mount() {
		if (!this.host.isConnected) this.ctx.doc.documentElement.append(this.host);
	}

	/** Called by the page controller's early key guard for every keydown. */
	onKey(e: KeyboardEvent) {
		this.keyed = true;
		if (this.dialog) {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.closeDialog();
			} else trapFocus(this.root, this.dialog.el, e);
			return;
		}
		if (!this.pop) return;
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			this.closePop(true);
		} else if (e.composedPath().includes(this.pop.el)) trapFocus(this.root, this.pop.el, e);
	}

	/** Follows the anchor; closes when the anchor hides. */
	private place() {
		if (!this.pop) return;
		const { el, anchor } = this.pop;
		if (!anchor.isConnected || !anchor.getClientRects().length) {
			this.closePop(false);
			return;
		}
		const win = this.ctx.doc.defaultView!;
		const r = anchor.getBoundingClientRect();
		const w = el.offsetWidth;
		const ht = el.offsetHeight;
		const m = 8;
		let top = r.bottom + 4;
		if (top + ht > win.innerHeight - m && r.top - 4 - ht > m) top = r.top - 4 - ht;
		// Start-aligned to the anchor; end-aligned to it when that would cross the viewport edge, so it
		// never overhangs the card it belongs to.
		const start = r.left + w > win.innerWidth - m ? r.right - w : r.left;
		const left = Math.min(Math.max(m, start), win.innerWidth - w - m);
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(Math.min(Math.max(m, top), win.innerHeight - ht - m))}px`;
	}

	private openPop(anchor: HTMLElement, el: HTMLElement, onClose?: () => void) {
		this.closePop(false);
		this.mount();
		el.classList.add('float');
		this.box.append(el);
		this.pop = { el, anchor, onClose };
		anchor.setAttribute('aria-expanded', 'true');
		(anchor.getRootNode() as ShadowRoot).host?.setAttribute('data-open', '');
		this.place();
		el.querySelector<HTMLElement>('[role="menuitem"], button, a[href], input')?.focus();
	}

	closePop(restoreFocus: boolean) {
		if (!this.pop) return;
		const { el, anchor, onClose } = this.pop;
		this.pop = null;
		el.remove();
		anchor.setAttribute('aria-expanded', 'false');
		(anchor.getRootNode() as ShadowRoot).host?.removeAttribute('data-open');
		if (restoreFocus && anchor.isConnected && anchor.getClientRects().length) anchor.focus();
		onClose?.();
	}

	why(anchor: HTMLElement, ev: Evidence, x: EvidenceActions) {
		const wrap = (f?: () => void) => f && (() => (this.closePop(false), f()));
		this.openPop(anchor, evidencePopover(this.ctx, ev, { show: wrap(x.show), allow: wrap(x.allow), notSlop: wrap(x.notSlop) }));
	}

	tagMenu(anchor: HTMLElement, noun: string, x: TagHandlers) {
		const s = this.ctx.strings;
		const menu = tagMenu(this.ctx, noun, async (t) => {
			this.closePop(true);
			await x.tag(t);
			this.notice({
				text: s.tagged[t],
				actions: [
					{ label: s.undo, icon: Undo2, onClick: () => (x.undo(), this.dismissNotice()) },
					...(t === 'slop' ? [{ label: s.addDetail, onClick: () => this.detail(x) }] : [])
				]
			});
			// A Slop tag hides the card and its Tag button with it. From the keyboard, focus moves to the
			// toast, which holds while focused, so Undo and Add detail stay in reach; it goes on to the
			// next card when the toast ends.
			if (this.keyed && !(anchor.isConnected && anchor.getClientRects().length)) {
				this.toastEl?.querySelector<HTMLElement>('button')?.focus();
				this.afterToast = x.focusAfter ?? null;
			}
		});
		this.openPop(anchor, menu, x.close);
	}

	private detail(x: TagHandlers) {
		const anchor = this.toastEl?.querySelector<HTMLElement>('.cl-toast');
		if (!anchor) return;
		anchor.querySelector('.cl-count')?.setAttribute('data-paused', '');
		const sheet = detailSheet(this.ctx, (type, tests) => {
			x.detail(type, tests);
			this.closePop(false);
			this.dismissNotice();
		});
		this.openPop(anchor, sheet, () => anchor.querySelector('.cl-count')?.removeAttribute('data-paused'));
	}

	/** One toast at a time; a new one replaces the old. `bottom` lifts it above player controls. */
	notice(t: Omit<ToastInput, 'onClose' | 'onTimeout'> & { bottom?: number }) {
		this.mount();
		this.dismissNotice();
		const el = toast(this.ctx, { ...t, onClose: () => this.dismissNotice(), onTimeout: () => this.dismissNotice() });
		this.toastEl = hyper(this.ctx.doc)('div', { class: 'toast-at', style: t.bottom ? `bottom:${t.bottom}px` : undefined }, el);
		this.box.append(this.toastEl);
	}

	dismissNotice() {
		if (this.pop && this.toastEl?.contains(this.pop.anchor)) this.closePop(false);
		// Focus still in the toast, or lost with a sheet that closed, follows the tagged card on.
		const doc = this.ctx.doc;
		const a = doc.activeElement;
		const inner = this.root.activeElement;
		const lost = !a || a === doc.body || a === doc.documentElement || (a === this.host && (!inner || !!this.toastEl?.contains(inner)));
		const after = this.afterToast;
		this.afterToast = null;
		this.toastEl?.remove();
		this.toastEl = null;
		if (after && lost) after()?.focus();
	}

	report(r: ReportSheetInput) {
		this.closePop(false);
		this.closeDialog();
		this.mount();
		// The Report source pill lives in a shadow root: the document only sees its host, which cannot
		// take focus, so the pill itself is found through the shadow roots.
		let restore = this.ctx.doc.activeElement as HTMLElement | null;
		while (restore?.shadowRoot?.activeElement) restore = restore.shadowRoot.activeElement as HTMLElement;
		const el = reportSheet(this.ctx, r, () => this.closeDialog());
		this.box.append(el);
		this.dialog = { el, restore };
		el.querySelector<HTMLElement>('input, button')?.focus();
	}

	closeDialog() {
		if (!this.dialog) return;
		const { el, restore } = this.dialog;
		this.dialog = null;
		el.remove();
		if (restore?.isConnected) restore.focus();
	}
}
