import { defineConfig, devices } from '@playwright/test';

// PORT moves the test server off 4173 when that port is taken.
const port = Number(process.env.PORT ?? 4173);

export default defineConfig({
	testDir: 'tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'line' : 'list',
	use: {
		baseURL: `http://localhost:${port}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// Tests run against a fresh production build, with an extension ID so the handoff code is live
	// and a fictional seed registry so /credits shows a dataset (tests/seed-registry.ts).
	webServer: {
		command: 'pnpm build && node tests/static-server.ts',
		env: { PUBLIC_EXTENSION_ID: 'test-extension-id', PORT: String(port), COLANDER_SEED_REGISTRY: new URL('tests/seed-registry.ts', import.meta.url).pathname },
		port,
		timeout: 120_000,
		reuseExistingServer: false
	}
});
