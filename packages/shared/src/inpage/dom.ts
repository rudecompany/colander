// DOM helpers for the in-page UI. Every helper takes the document it builds in, never the
// global one, so the same builders run in a content script, in a page and in Node (linkedom)
// at prerender. No innerHTML anywhere: host pages may enforce Trusted Types, and building
// nodes directly keeps page text out of any markup parser.
import type { IconNode } from 'lucide';
import { GLYPHS, GLYPH_VIEWBOX } from '../glyphs';
import type { Verdict } from '../verdicts';

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

const SVG = 'http://www.w3.org/2000/svg';

function apply(el: Element, attrs: Attrs) {
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
		else el.setAttribute(k, v === true ? '' : String(v));
	}
}

/** `h('button', { class: 'cl-b', onclick }, 'Show')`, bound to one document. */
export type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]) => HTMLElementTagNameMap[K];

export function hyper(doc: Document): H {
	return (tag, attrs = {}, ...children) => {
		const el = doc.createElement(tag);
		apply(el, attrs);
		for (const c of children) if (c) el.append(c);
		return el;
	};
}

function svgEl(doc: Document, tag: string, attrs: Record<string, string | number>): SVGElement {
	const el = doc.createElementNS(SVG, tag) as SVGElement;
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}

/** A Lucide icon at 16 px with the spec's 2 px stroke. Decorative: a word always sits beside it. */
export function icon(doc: Document, node: IconNode, size = 16): SVGElement {
	const svg = svgEl(doc, 'svg', {
		width: size,
		height: size,
		viewBox: '0 0 24 24',
		fill: 'none',
		stroke: 'currentColor',
		'stroke-width': 2,
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		class: 'lucide',
		'aria-hidden': 'true',
		focusable: 'false'
	});
	for (const [tag, attrs] of node) svg.append(svgEl(doc, tag, attrs as Record<string, string>));
	return svg;
}

/** A verdict glyph in currentColor. Decorative: the verdict word always sits beside it. */
export function glyph(doc: Document, verdict: Verdict, size = 12): SVGElement {
	const svg = svgEl(doc, 'svg', {
		viewBox: GLYPH_VIEWBOX,
		width: size,
		height: size,
		class: 'cl-glyph',
		'aria-hidden': 'true',
		focusable: 'false'
	});
	for (const s of GLYPHS[verdict]) {
		svg.append(
			svgEl(
				doc,
				'path',
				s.stroke
					? { d: s.d, fill: 'none', stroke: 'currentColor', 'stroke-width': 4, 'stroke-linejoin': 'round' }
					: { d: s.d, fill: 'currentColor', ...(s.evenodd ? { 'fill-rule': 'evenodd' } : {}) }
			)
		);
	}
	return svg;
}

let ids = 0;
/** A document-unique id for aria wiring. */
export const uid = (prefix: string) => `cl-${prefix}-${++ids}`;

/** Keeps Tab inside a popover or dialog. */
export function trapFocus(root: DocumentOrShadowRoot, container: HTMLElement, e: KeyboardEvent): void {
	if (e.key !== 'Tab') return;
	const items = [
		...container.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea, [tabindex="0"]')
	].filter((el) => el.getClientRects().length);
	if (!items.length) return;
	const first = items[0]!;
	const last = items[items.length - 1]!;
	const active = root.activeElement as HTMLElement | null;
	if (e.shiftKey && (active === first || !container.contains(active))) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

/** Up, Down, Home and End move focus between the items of a menu. */
export function menuKeys(container: HTMLElement, e: KeyboardEvent, selector = '[role="menuitem"], [role="menuitemradio"]'): void {
	const items = [...container.querySelectorAll<HTMLElement>(selector)];
	const i = items.indexOf((container.getRootNode() as unknown as DocumentOrShadowRoot).activeElement as HTMLElement);
	const n = items.length;
	const next =
		e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
	if (next < 0 || !n) return;
	e.preventDefault();
	items[next]!.focus();
}

/** Relative luminance of the page background decides light or dark in-page UI. */
export function pageIsDark(doc: Document): boolean {
	const win = doc.defaultView;
	if (!win) return false;
	for (const el of [doc.body, doc.documentElement]) {
		if (!el) continue;
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(win.getComputedStyle(el).backgroundColor);
		if (!m || m[4] === '0') continue;
		const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
			const c = Number(v) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.2;
	}
	return win.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function reducedMotion(doc: Document): boolean {
	return !!doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
