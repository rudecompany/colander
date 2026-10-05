// Reflow (WCAG 1.4.10): no page scrolls sideways at phone widths, down to 320 CSS px, and figures
// that scale down never set their labels below 12 px.
import { test, expect, layoutSpills, smallSvgText } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

// Five stat cells to a row are narrowest just above the tablet breakpoint: labels stay in their cell.
for (const width of [1024, 1100]) {
	for (const path of ['/', '/transparency']) {
		test(`${path} keeps its stat cells whole at ${width} px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await mockApi(page);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			expect(await layoutSpills(page), 'layout spills').toEqual([]);
		});
	}
}

for (const width of [390, 320]) {
	for (const [path, mocks] of PAGES) {
		test(`${path} reflows at ${width} px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await mockApi(page, mocks);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			expect(await layoutSpills(page), 'layout spills').toEqual([]);
			expect(await smallSvgText(page), 'figure text below 12 px as rendered').toEqual([]);
		});
	}
}
