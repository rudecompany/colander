import { defineConfig } from '@playwright/test';

// End-to-end tests load the built extension (pnpm build:e2e) into Chromium. Platform pages are
// served from saved fixtures and the API from route handlers, so nothing leaves the machine.
// The live project visits real YouTube and TikTok pages; run it with `pnpm test:live`.
export default defineConfig({
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// The summary reporter only reports the live project (the daily adapter checks).
	reporter: [['list'], ['./tests/live/summary-reporter.ts']],
	workers: process.env.CI ? 2 : 4,
	projects: [
		{ name: 'e2e', testDir: 'tests/e2e', testIgnore: /perf\.spec\.ts/, fullyParallel: true },
		// Timing runs alone, after every other browser test has finished, so parallel workers cannot skew it.
		{ name: 'perf', testDir: 'tests/e2e', testMatch: /perf\.spec\.ts/, dependencies: ['e2e'] },
		{ name: 'live', testDir: 'tests/live', timeout: 180_000, retries: 1 }
	]
});
