import { defineConfig } from '@playwright/test';

// The real server, website and extension together. Global setup builds all three and starts one
// server with a freshly seeded database, so the specs run one at a time, in file order.
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
