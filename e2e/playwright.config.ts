import { defineConfig } from '@playwright/test';

// The Worker, website and extension together. Global setup builds the website and the extension and
// starts one Worker under wrangler dev with freshly seeded state, so the specs run one at a time, in
// file order.
export default defineConfig({
	testDir: 'tests',
	globalSetup: './tests/global-setup.ts',
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	timeout: 90_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [['line']] : [['list']]
});
