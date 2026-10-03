// WCAG 2.2 AA checks with axe on every page, in light and dark.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

for (const scheme of ['light', 'dark'] as const) {
	for (const [path, mocks] of PAGES) {
		test(`${path} has no WCAG A or AA violations (${scheme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await mockApi(page, mocks);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			if (path === '/console') await page.getByRole('button', { name: /History Bites/ }).click();
			await page.waitForLoadState('networkidle');
			const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
			const found = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(' | ')}`);
			expect(found).toEqual([]);
		});
	}
}
