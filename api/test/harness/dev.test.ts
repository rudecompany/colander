// The Worker in dev mode with the parity harness's frozen clock, as `wrangler dev` runs it: the
// seed lands at COLANDER_TEST_NOW, no job runs on its own, and the dump loads into stock SQLite
// with the Go server's schema (the escape hatch of hosting plan section 3).
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';

// node:sqlite still announces itself as experimental on Node 24; that notice is expected here.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
	if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const NOW = '2026-05-01T12:00:00Z';
const S = Date.parse(NOW) / 1000;

const server = createTestHarness({
	workers: [
		{
			configPath: new URL('../../wrangler.jsonc', import.meta.url),
			secrets: {
				COLANDER_SIGNING_KEY: process.env.COLANDER_SIGNING_KEY!,
				IP_SALT: 'harness-salt',
				OPS_TOKEN: 'harness-ops-token',
				COLANDER_DEV: '1',
				COLANDER_TEST_NOW: NOW
			}
		}
	]
});

beforeAll(() => server.listen());
afterAll(() => server.close());

it('seeds at the frozen time, runs no job on its own, and dumps SQL that stock SQLite loads', async () => {
	const seeded = await server.fetch('/__dev/seed', { method: 'POST' });
	expect(seeded.status).toBe(200);
	expect(((await seeded.json()) as { sequence: number }).sequence).toBe(S);

	const db = new DatabaseSync(':memory:');
	db.exec(await (await server.fetch('/__dev/dump')).text());
	db.exec('PRAGMA foreign_keys = ON');
	expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
	expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

	// Every table and index of the Go migrations, statement for statement.
	const go = new DatabaseSync(':memory:');
	const dir = new URL('../../../server/internal/store/migrations/', import.meta.url);
	for (const f of readdirSync(dir).sort()) go.exec(readFileSync(new URL(f, dir), 'utf8'));
	const schema = (d: DatabaseSync) => d.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
	const ours = new Map(schema(db).map((r) => [r.name, r]));
	for (const r of schema(go)) expect(ours.get(r.name as string), String(r.name)).toEqual(r);

	// The clock: the seed's last pass and publication happened at NOW, the one before a day earlier.
	expect(db.prepare('SELECT seq, created_at FROM list_sequences ORDER BY seq').all()).toEqual([
		{ seq: S - 86_400, created_at: S - 86_400 },
		{ seq: S, created_at: S }
	]);
	expect(db.prepare('SELECT max(at) AS at FROM decision_log').get()).toEqual({ at: S });
	// With the clock frozen the harness settles jobs itself: none was scheduled.
	expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });

	const settled = await server.fetch('/__dev/settle', { method: 'POST' });
	expect(await settled.json()).toEqual({ changed: 0, head_seq: S });
	const status = await server.fetch('/ops/status', { method: 'POST', headers: { Authorization: 'Bearer harness-ops-token' }, body: '{}' });
	expect(await status.json()).toMatchObject({ head_seq: S, r2_seq: S, publish_lag_s: 0 });
});
