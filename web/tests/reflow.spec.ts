// Reflow (WCAG 1.4.10): no page scrolls sideways at phone widths, down to 320 CSS px.
import { test, expect, layoutSpills } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

for (const width of [390, 320]) {
	for (const [path, mocks] of PAGES) {
		test(`${path} reflows at ${width} px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await mockApi(page, mocks);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			expect(await layoutSpills(page), 'layout spills').toEqual([]);
		});
	}
}
