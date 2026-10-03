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
 * Layout spills: anything sticking out of the card it sits in, and any horizontal page scroll.
 * Content inside a clipping or scrolling box (a wide table) and floating layers are not counted.
 */
export function layoutSpills(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		const root = document.documentElement;
		if (root.scrollWidth > root.clientWidth + 0.5) out.push(`page scrolls sideways by ${root.scrollWidth - root.clientWidth}px`);
		for (const card of document.querySelectorAll('.card, .uin-card, .price')) {
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
