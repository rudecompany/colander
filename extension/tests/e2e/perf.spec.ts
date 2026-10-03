// P0-1 budgets on a 200-card page: a slop card is hidden within 150 ms at the 95th percentile
// of insertion, and the content script adds under 50 ms of work to the page in total.
import { expect, test } from './harness';

test('200 cards: hide latency p95 under 150 ms and added time under 50 ms', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/');
	const result = await page.evaluate(async () => {
		const grid = document.querySelector('ytd-rich-grid-renderer #contents')!;
		const templates = [...grid.querySelectorAll('ytd-rich-item-renderer')].map((c) => {
			const t = c.cloneNode(true) as Element;
			t.removeAttribute('data-colander');
			t.removeAttribute('data-colander-card');
			t.querySelectorAll('colander-ui').forEach((e) => e.remove());
			return t;
		});
		grid.replaceChildren();
		const inserted = new Map<Element, number>();
		const hiddenAt = new Map<Element, number>();
		new MutationObserver((records) => {
			const now = performance.now();
			for (const r of records) {
				const el = r.target as Element;
				if (el.getAttribute('data-colander') === 'hide' && !hiddenAt.has(el)) hiddenAt.set(el, now);
			}
		}).observe(grid, { subtree: true, attributes: true, attributeFilter: ['data-colander'] });
		let slop = 0;
		// Ten batches of twenty, one per frame, like infinite scroll.
		for (let b = 0; b < 10; b++) {
			for (let i = 0; i < 20; i++) {
				const n = b * 20 + i;
				const card = templates[n % templates.length]!.cloneNode(true) as Element;
				const id = `perf${String(n).padStart(7, '0')}`;
				card.querySelectorAll('a[href*="watch?v="]').forEach((a) => a.setAttribute('href', `/watch?v=${id}`));
				const bridge = JSON.parse(card.getAttribute('data-colander-bridge') || '{}');
				if (n % 4 === 0) {
					bridge.s = ['/@aihistorydaily'];
					slop++;
				}
				bridge.i = id;
				card.setAttribute('data-colander-bridge', JSON.stringify(bridge));
				inserted.set(card, performance.now());
				grid.append(card);
			}
			await new Promise((r) => requestAnimationFrame(r));
		}
		await new Promise((r) => setTimeout(r, 300));
		const lat = [...hiddenAt].map(([el, t]) => t - inserted.get(el)!).sort((a, b) => a - b);
		return { slop, hidden: lat.length, p95: lat[Math.floor(lat.length * 0.95)] ?? Infinity, max: lat.at(-1) ?? Infinity };
	});
	const state = await ext.pageState(page);
	console.log(`200 cards: ${result.hidden}/${result.slop} hidden, latency p95 ${result.p95.toFixed(2)} ms, max ${result.max.toFixed(2)} ms; content script total ${state.perf.totalMs} ms over ${state.perf.batches} batches, batch p95 ${state.perf.p95Ms} ms`);
	expect(result.hidden).toBe(result.slop);
	expect(result.p95).toBeLessThan(150);
	expect(state.cards.total).toBe(200);
	expect(state.perf.totalMs).toBeLessThan(50);
});
