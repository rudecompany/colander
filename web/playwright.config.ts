import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'line' : 'list',
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// Tests run against a fresh production build, with an extension ID so the handoff code is live.
	webServer: {
		command: 'pnpm build && node tests/static-server.ts',
		env: { PUBLIC_EXTENSION_ID: 'test-extension-id' },
		port: 4173,
		timeout: 120_000,
		reuseExistingServer: false
	}
});
