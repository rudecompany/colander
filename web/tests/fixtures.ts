// A test fixture that fails on page errors and CSP violations. Failed API responses are expected
// in some tests and are not counted.
import { test as base, expect } from '@playwright/test';

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
