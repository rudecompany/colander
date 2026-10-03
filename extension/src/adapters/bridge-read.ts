// Reads item and source values out of the JavaScript data a page attaches to its elements.
// YouTube's newer cards carry no channel link in the DOM; the channel lives only in component
// data, which the isolated content script cannot see. The main-world bridge script calls this
// and writes the result onto the card as a data attribute.
//
// Self-contained on purpose (no imports, no module state): the fixture capture script also
// ships this function into live pages with Playwright.
import type { Bridge } from './schema';

export function readBridge(card: Element, b: Bridge): { i?: string; s?: string[] } | null {
	const host = b.el ? card.querySelector(b.el) : card;
	if (!host) return null;
	let data: unknown = null;
	for (const path of b.props) {
		try {
			let v: any = host;
			for (const part of path.split('.')) {
				if (v == null) break;
				v = part.endsWith('()') ? v[part.slice(0, -2)]?.() : v[part];
			}
			if (v && typeof v === 'object') {
				data = v;
				break;
			}
		} catch {
			// A getter that throws just means this path is not the one.
		}
	}
	if (!data) return null;
	const want = [...(b.item ?? []).map((k) => ({ ...k, kind: 'i' })), ...(b.source ?? []).map((k) => ({ ...k, kind: 's' }))];
	const found = new Map<string, string>();
	const res = want.map((k) => (k.re ? new RegExp(k.re, 'u') : null));
	// Depth-first, in property order, stopping as soon as every key has a value.
	const stack: unknown[] = [data];
	let budget = 20000;
	while (stack.length && found.size < want.length && budget-- > 0) {
		const node = stack.pop();
		if (!node || typeof node !== 'object') continue;
		const entries = Object.entries(node as Record<string, unknown>);
		for (let n = entries.length - 1; n >= 0; n--) {
			const [key, value] = entries[n]!;
			if (typeof value === 'string') {
				want.forEach((k, idx) => {
					if (k.key !== key || found.has(k.kind + idx)) return;
					const m = res[idx] ? res[idx]!.exec(value) : null;
					if (res[idx] && !m) return;
					found.set(k.kind + idx, m && m[1] !== undefined ? m[1] : value);
				});
			} else if (value && typeof value === 'object') stack.push(value);
		}
	}
	const out: { i?: string; s?: string[] } = {};
	const items = want.map((k, idx) => (k.kind === 'i' ? found.get('i' + idx) : undefined)).filter(Boolean) as string[];
	const sources = want.map((k, idx) => (k.kind === 's' ? found.get('s' + idx) : undefined)).filter(Boolean) as string[];
	if (items.length) out.i = items[0];
	if (sources.length) out.s = [...new Set(sources)];
	return out.i || out.s ? out : null;
}
