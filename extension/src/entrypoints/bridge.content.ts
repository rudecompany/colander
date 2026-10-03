// Main-world bridge. Some platforms keep a card's channel only in JavaScript component data
// (YouTube's newer lockups have no channel link in the DOM), which the isolated content script
// cannot read. This script reads the configured property paths and writes the result onto the
// card as a data attribute. It runs no remote code: the rules are plain data sent by the
// isolated script, and the reader is packaged here.
import { readBridge } from '../adapters/bridge-read';
import { BRIDGE_ATTR } from '../adapters/extract';
import type { Bridge } from '../adapters/schema';

export default defineContentScript({
	matches: ['*://*.youtube.com/*'],
	registration: 'runtime',
	runAt: 'document_start',
	world: 'MAIN',
	main() {
		let bridges: Bridge[] = [];

		// When the data cannot be read, the attribute is left alone: the isolated script only
		// trusts it while its item matches the card's own, so a stale value is ignored there.
		const annotate = (card: Element, b: Bridge) => {
			const r = readBridge(card, b);
			if (!r) return;
			const v = JSON.stringify(r);
			if (card.getAttribute(BRIDGE_ATTR) !== v) card.setAttribute(BRIDGE_ATTR, v);
		};

		const scan = (root: ParentNode) => {
			for (const b of bridges) {
				try {
					for (const card of root.querySelectorAll(b.card)) annotate(card, b);
				} catch {
					// A bad selector in a config only disables that bridge.
				}
			}
		};

		new MutationObserver((records) => {
			if (!bridges.length) return;
			const touched = new Set<Element>();
			for (const r of records) {
				if (r.target.nodeType === 1) touched.add(r.target as Element);
				for (const n of r.addedNodes) if (n.nodeType === 1 && n.nodeName !== 'COLANDER-UI') touched.add(n as Element);
			}
			const done = new Set<Element>();
			for (const el of touched) {
				if (el.nodeName === 'COLANDER-UI') continue;
				for (const b of bridges) {
					try {
						const card = el.closest(b.card);
						if (card && !done.has(card)) {
							done.add(card);
							annotate(card, b);
						}
						if (el.firstElementChild) {
							for (const c of el.querySelectorAll(b.card)) {
								if (done.has(c)) continue;
								done.add(c);
								annotate(c, b);
							}
						}
					} catch {
						// Ignore a bad selector.
					}
				}
			}
		}).observe(document, { childList: true, subtree: true });

		document.addEventListener('colander:bridge-config', (e) => {
			try {
				const next = JSON.parse(String((e as CustomEvent).detail)) as Bridge[];
				if (Array.isArray(next)) bridges = next;
			} catch {
				return;
			}
			scan(document);
		});
		document.dispatchEvent(new CustomEvent('colander:bridge-ready'));
	}
});
