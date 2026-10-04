// Shadow hosts for the in-page UI: one <colander-ui> per decorated element, one constructed
// sheet per document. Also the website's side: Declarative Shadow DOM markup at prerender,
// and mounting live children into a host on the client.
import { INPAGE_COPY } from '../copy';
import { fmtShortDate, type DateInput } from '../utils/format';
import { SHEET, SHEET_AUTO } from './styles';

export type Theme = 'light' | 'dark' | 'auto';

/** What every builder takes: the document to build in, the website origin, formats and copy. */
export interface InpageContext {
	doc: Document;
	/** Website origin for links, such as https://colander.app. Empty for same-site links. */
	site: string;
	fmt: { date: (t: DateInput) => string };
	strings: typeof INPAGE_COPY;
}

export function inpageContext(doc: Document, site = ''): InpageContext {
	return { doc, site, fmt: { date: fmtShortDate }, strings: INPAGE_COPY };
}

const sheets = new WeakMap<Document, Map<string, CSSStyleSheet>>();
const sheetText = (auto: boolean) => (auto ? SHEET_AUTO : SHEET);
const themes = new WeakMap<Document, Theme>();

/** One constructed sheet per document and text, shared by every host that uses it. */
function sheetFor(doc: Document, text: string): CSSStyleSheet {
	let m = sheets.get(doc);
	if (!m) sheets.set(doc, (m = new Map()));
	let s = m.get(text);
	if (!s) {
		const Sheet = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet ?? CSSStyleSheet;
		s = new Sheet();
		s.replaceSync(text);
		m.set(text, s);
	}
	return s;
}

/** Sets light or dark for every host in the document, now and for hosts made later. */
export function setTheme(doc: Document, theme: Theme): void {
	themes.set(doc, theme);
	for (const host of doc.querySelectorAll('colander-ui')) host.setAttribute('theme', theme);
}

/**
 * A host element with its own shadow root and the shared sheet, for the content script.
 * Clicks and keys inside never reach handlers of the card or page around it (keys typed in
 * the report sheet would otherwise trigger site shortcuts).
 */
export function makeHost(ctx: InpageContext, kind: string): { host: HTMLElement; root: ShadowRoot } {
	const { doc } = ctx;
	const host = doc.createElement('colander-ui');
	host.setAttribute('data-kind', kind);
	host.setAttribute('theme', themes.get(doc) ?? 'light');
	const root = host.attachShadow({ mode: 'open' });
	root.adoptedStyleSheets = [sheetFor(doc, SHEET)];
	for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'keydown', 'keypress', 'keyup'] as const) {
		host.addEventListener(type, (e) => e.stopPropagation());
	}
	// A chip or Tag pill can sit inside the card's own link; a click on it must not follow that link.
	host.addEventListener('click', (e) => {
		if (host.parentElement?.closest('a[href]')) e.preventDefault();
	});
	return { host, root };
}

/** A builder: makes one in-page element in the context's document. */
export type Build = (ctx: InpageContext) => Element;

/**
 * Pages: fill an existing <colander-ui> with live children. Reuses the shadow root a Declarative
 * Shadow DOM template made, or attaches one after client-side navigation, where the template is
 * never parsed into a root. `css` adds page-only rules, such as the demo feed's host look.
 *
 * Focus inside the host survives a rebuild: the element with the same data-k gets it back, or
 * else its nearest keyed ancestor (a card whose Why button went away). A `data-focus` list of
 * keys on the new root moves focus on purpose instead, to the first key that exists: into a
 * popover the visitor opened, or back to its anchor when it closes.
 */
export function mountInto(host: HTMLElement, el: Element, theme: Theme = 'auto', css = ''): ShadowRoot {
	const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
	const doc = host.ownerDocument;
	const keys: string[] = [];
	for (let n = root.activeElement as Element | null; n && n !== host; n = n.parentElement) {
		const key = n.getAttribute('data-k');
		if (key) keys.push(key);
	}
	const wanted = el.getAttribute('data-focus');
	el.removeAttribute('data-focus');
	root.adoptedStyleSheets = [sheetFor(doc, sheetText(theme === 'auto')), ...(css ? [sheetFor(doc, css)] : [])];
	root.replaceChildren(el);
	for (const key of wanted ? wanted.split(' ') : keys) {
		const target = root.querySelector<HTMLElement>(`[data-k="${key}"]`);
		if (target) {
			target.focus();
			break;
		}
	}
	return root;
}

let serverDoc: (() => Document) | null = null;

/**
 * The website registers a document factory (linkedom) for prerender, so the same builders
 * render on the server. Never called in the extension.
 */
export function setServerDocument(factory: (() => Document) | null): void {
	serverDoc = factory;
}

/** The prerender document, or null in browsers and wherever none is registered. */
export function serverDocument(): Document | null {
	return typeof window === 'undefined' && serverDoc ? serverDoc() : null;
}

/** Declarative Shadow DOM content for one host: the sheet and the markup inside an open template. */
export function dsd(markup: string, theme: Theme = 'auto', css = ''): string {
	return `<template shadowrootmode="open"><style>${sheetText(theme === 'auto')}${css}</style>${markup}</template>`;
}

/** The whole host as markup: `<colander-ui theme="auto"><template shadowrootmode="open">…</template></colander-ui>`. */
export function dsdHost(markup: string, kind: string, theme: Theme = 'auto', css = ''): string {
	return `<colander-ui data-kind="${kind}" theme="${theme}">${dsd(markup, theme, css)}</colander-ui>`;
}

/** Server side: the shadow content for `build`, or null when no prerender document is registered. */
export function prerender(build: Build, theme: Theme = 'auto', site = '', css = ''): string | null {
	const doc = serverDocument();
	return doc ? dsd(build(inpageContext(doc, site)).outerHTML, theme, css) : null;
}
