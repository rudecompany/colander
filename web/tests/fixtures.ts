// A test fixture that fails on page errors and CSP violations. Failed API responses are expected
// in some tests and are not counted.
import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend<{ pageErrors: string[] }>({
	pageErrors: [
		async ({ page }, use) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			page.on('console', (m) => {
				if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
			});
			await use(errors);
			expect(errors, 'page errors and CSP violations').toEqual([]);
		},
		{ auto: true }
	]
});

export { expect };

/**
 * Layout spills: anything sticking out of the card it sits in (a source page's record and a stat
 * cell count as cards), and any horizontal page scroll. Content inside a clipping or scrolling box
 * (a wide table) and floating layers are not counted.
 */
export function layoutSpills(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		const root = document.documentElement;
		if (root.scrollWidth > root.clientWidth + 0.5) out.push(`page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`);
		for (const card of document.querySelectorAll('.card, .uin-card, .price, .facts, .cells > .cell')) {
			const c = card.getBoundingClientRect();
			for (const el of card.querySelectorAll('*')) {
				const r = el.getBoundingClientRect();
				if (r.width < 2 || r.height < 2 || el.closest('.sr-only, [popover], [role="tooltip"], [role="dialog"]')) continue;
				let clipped = false;
				for (let a = el.parentElement; a && a !== card; a = a.parentElement) {
					if (getComputedStyle(a).overflowX !== 'visible') clipped = true;
				}
				const over = Math.max(c.left - r.left, r.right - c.right);
				if (!clipped && over > 0.5) {
					out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}" sticks out of its card by ${Math.round(over)}px`);
				}
			}
		}
		return out;
	});
}

/** SVG text renders at its font size times the drawing's scale: labels that end up below 12 px. */
export function smallSvgText(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll('svg text')]
			.filter((t) => t.getClientRects().length && !t.closest('.sr-only, [hidden]'))
			.map((t) => {
				const svg = t.closest('svg')!;
				const vb = svg.viewBox.baseVal;
				const scale = vb && vb.width ? svg.getBoundingClientRect().width / vb.width : 1;
				return [(t.textContent ?? '').trim().slice(0, 30), parseFloat(getComputedStyle(t).fontSize) * scale] as const;
			})
			.filter(([, size]) => size < 11.95)
			.map(([name, size]) => `"${name}" ${size.toFixed(1)}px`)
	);
}
