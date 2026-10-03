// Tiny DOM helpers for the in-page UI. No innerHTML anywhere: host pages may enforce
// Trusted Types, and building nodes directly keeps page text out of any markup parser.
import { createElement as createIcon, type IconNode } from 'lucide';
import { GLYPHS, GLYPH_VIEWBOX } from '@colander/shared/glyphs';
import type { Verdict } from '@colander/shared/verdicts';
import { SHEET } from './styles';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
		else if (k === 'class') el.className = String(v);
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	for (const c of children) if (c) el.append(c);
	return el;
}

export function icon(node: IconNode, size = 14): SVGElement {
	const svg = createIcon(node, { width: size, height: size, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false' }) as SVGElement;
	svg.setAttribute('class', 'lucide');
	svg.style.width = svg.style.height = `${size}px`;
	return svg;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A verdict glyph, colored by the verdict class. Decorative: the word always sits beside it. */
export function glyph(verdict: Verdict, size = 12): SVGElement {
	const svg = document.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', GLYPH_VIEWBOX);
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('class', `v-${verdict}`);
	for (const s of GLYPHS[verdict]) {
		const p = document.createElementNS(SVG, 'path');
		p.setAttribute('d', s.d);
		if (s.stroke) {
			p.setAttribute('fill', 'none');
			p.setAttribute('stroke', 'currentColor');
			p.setAttribute('stroke-width', '4');
			p.setAttribute('stroke-linejoin', 'round');
		} else {
			p.setAttribute('fill', 'currentColor');
			if (s.evenodd) p.setAttribute('fill-rule', 'evenodd');
		}
		svg.append(p);
	}
	return svg;
}

let sheet: CSSStyleSheet | null = null;
let dark = false;

export function setDark(value: boolean): void {
	dark = value;
	for (const host of document.querySelectorAll('colander-ui')) host.setAttribute('theme', dark ? 'dark' : 'light');
}

/** A host element with its own shadow root and the shared stylesheet. */
export function makeHost(kind: string): { host: HTMLElement; root: ShadowRoot } {
	const host = document.createElement('colander-ui');
	host.setAttribute('data-kind', kind);
	host.setAttribute('theme', dark ? 'dark' : 'light');
	const root = host.attachShadow({ mode: 'open' });
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(SHEET);
	}
	root.adoptedStyleSheets = [sheet];
	// Clicks and keys inside our UI must never reach handlers of the card or page around it
	// (keys typed in the report form would otherwise trigger site shortcuts).
	for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'keydown', 'keypress', 'keyup'] as const) {
		host.addEventListener(type, (e) => e.stopPropagation());
	}
	// A chip or Tag button can sit inside the card's own link; a click on it must not follow that link.
	host.addEventListener('click', (e) => {
		if (host.parentElement?.closest('a[href]')) e.preventDefault();
	});
	return { host, root };
}

/** Relative luminance of the page background decides light or dark in-page UI. */
export function pageIsDark(): boolean {
	for (const el of [document.body, document.documentElement]) {
		if (!el) continue;
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(el).backgroundColor);
		if (!m || m[4] === '0') continue;
		const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
			const c = Number(v) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.2;
	}
	return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function reducedMotion(): boolean {
	return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Keeps Tab inside a popover or dialog. */
export function trapFocus(root: ShadowRoot, container: HTMLElement, e: KeyboardEvent): void {
	if (e.key !== 'Tab') return;
	const items = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea, [tabindex="0"]')].filter(
		(el) => el.offsetParent !== null || el.getClientRects().length
	);
	if (!items.length) return;
	const first = items[0]!, last = items[items.length - 1]!;
	const active = root.activeElement as HTMLElement | null;
	if (e.shiftKey && (active === first || !container.contains(active))) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

export function formatDate(d: Date): string {
	return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
