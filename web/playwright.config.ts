import { defineConfig, devices } from '@playwright/test';

// PORT moves the test server off 4173 when that port is taken. The build with Turnstile's test site
// key is served one port above it.
const port = Number(process.env.PORT ?? 4173);
const turnstilePort = port + 1;

export default defineConfig({
	testDir: 'tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'line' : 'list',
	use: {
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'chromium', testIgnore: /turnstile\.spec\.ts$/, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${port}` } },
		// The sign-in forms with Turnstile on: a build whose CSP and code carry a site key.
		{ name: 'turnstile', testMatch: /turnstile\.spec\.ts$/, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${turnstilePort}` } }
	],
	// Tests run against fresh production builds, with an extension ID so the handoff code is live.
	webServer: {
		command: 'pnpm build && pnpm build:turnstile && node tests/static-server.ts',
		env: { PUBLIC_EXTENSION_ID: 'test-extension-id', PORT: String(port), TURNSTILE_PORT: String(turnstilePort) },
		port,
		timeout: 180_000,
		reuseExistingServer: false
	}
});
