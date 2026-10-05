import { defineConfig, devices } from '@playwright/test';
import { EDGE_STORE } from './tests/mocks.ts';

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
	// Tests run against a fresh production build with an Edge listing and no Firefox listing, so both
	// kinds of store show in the install buttons.
	webServer: {
		command: 'pnpm build && node tests/static-server.ts',
		env: { PUBLIC_STORE_EDGE: EDGE_STORE, PUBLIC_STORE_FIREFOX: '', PORT: String(port) },
		port,
		timeout: 120_000,
		reuseExistingServer: false
	}
});
