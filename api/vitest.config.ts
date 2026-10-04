import { readdirSync, readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { contractFiles } from '../packages/shared/test/contract-files.ts';

// node:sqlite still announces itself as experimental on Node 24; that notice is expected here.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
	if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const repo = new URL('../', import.meta.url);
const migrations = new URL('src/store/migrations/', import.meta.url);

/** The schema stock SQLite builds from the Store's migration files, as sqlite_master rows. */
function migrationSchema() {
	const db = new DatabaseSync(':memory:');
	for (const f of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(f, migrations), 'utf8'));
	return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name').all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
}

// The Worker's required secrets for tests, with the published dev signing key. Passed as bindings
// so a developer's api/.dev.vars never changes test results; also set in process.env so Wrangler
// does not warn about missing secrets when there is no .dev.vars.
const secrets = {
	COLANDER_SIGNING_KEY: readFileSync(new URL('testdata/dev-signing.key', repo), 'utf8').trim(),
	IP_SALT: 'test-ip-salt',
	OPS_TOKEN: 'test-ops-token'
};
Object.assign(process.env, secrets);

export default defineConfig({
	test: {
		projects: [
			{
				// Inside workerd: the Worker, the Store and the shared list and signing code.
				plugins: [
					cloudflareTest({
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: { bindings: { ...secrets, COLANDER_DEV: '1' } }
					})
				],
				test: {
					name: 'workerd',
					include: ['test/*.test.ts', '../packages/shared/test/{contract,ids}.test.ts'],
					provide: { contract: contractFiles(), migrationSchema: migrationSchema() }
				}
			},
			{
				// In Node against the full Worker with its static assets, as `wrangler dev` runs it.
				test: {
					name: 'harness',
					include: ['test/harness/*.test.ts'],
					environment: 'node',
					globalSetup: ['test/harness/build-web.ts'],
					testTimeout: 60_000,
					hookTimeout: 120_000
				}
			}
		]
	}
});

