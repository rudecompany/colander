// The Store Durable Object: migrations, the transaction helper and the internal router.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, inject, it } from 'vitest';
import { MIGRATIONS } from '../src/store/migrations';
import type { Store } from '../src/store/store';

const schema = (store: Store) =>
	store.db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
		// _cf_* and __cf_* are the platform's own tables.
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_cf\\_%' ESCAPE '\\' ORDER BY name"
	);

describe('migrations', () => {
	it('builds exactly the schema stock SQLite builds from the migration files, plus _migrations', async () => {
		const rows = await runInDurableObject(env.STORE.getByName('migrations'), (store: Store) => schema(store));
		const files = inject('migrationSchema');
		expect(rows.filter((r) => r.tbl_name !== '_migrations')).toEqual(files);
		expect(rows.filter((r) => r.tbl_name === '_migrations').map((r) => r.name)).toEqual(['_migrations']);
		expect(files.length).toBeGreaterThan(50);
		expect(files.map((r) => r.name)).toEqual(expect.arrayContaining(['jobs', 'limits']));
	});

	it('records each migration once and starts again without reapplying', async () => {
		const stub = env.STORE.getByName('restart');
		await runInDurableObject(stub, (store: Store) => store.db.run("INSERT INTO accounts (id, email, created_at) VALUES ('acc_1', 'a@example.com', 1)"));
		await evictDurableObject(stub);
		const [versions, accounts] = await runInDurableObject(stub, (store: Store) => [
			store.db.all<{ version: number; name: string }>('SELECT version, name FROM _migrations ORDER BY version'),
			store.db.all('SELECT id FROM accounts')
		]);
		expect(versions).toEqual(MIGRATIONS.map(({ version, name }) => ({ version, name })));
		expect(accounts).toEqual([{ id: 'acc_1' }]);
	});

	it('ignores migrations newer than the code knows, so a rollback still starts', async () => {
		const stub = env.STORE.getByName('rollback');
		await runInDurableObject(stub, (store: Store) => store.db.run("INSERT INTO _migrations (version, name, applied_at) VALUES (99, '0099_future.sql', 1)"));
		await evictDurableObject(stub);
		expect(await stub.health()).toBe(99);
	});

	// 0005 cleans what earlier code stored: seed list names in public log reasons, and YouTube Data
	// API titles and figures, which may not be kept 30 days.
	it('takes seed list names out of public reasons and drops stored YouTube API data (0005)', async () => {
		await runInDurableObject(env.STORE.getByName('migration-0005'), async (store: Store, state) => {
			const db = store.db;
			await state.storage.deleteAll();
			for (const m of MIGRATIONS.slice(0, 4)) db.run(m.sql);
			db.run("INSERT INTO installs (hash, created_at) VALUES ('h', 1)");
			db.run(`INSERT INTO sources (id, platform, canonical_id, name, import_list, import_source, import_license, subscribers, uploads_per_day, youtube_checked_at, created_at) VALUES
				(1, 'yt', 'UCzzzzzzzzzzzzzzzzzzzzz1', 'API Title', 'blocklist', 'AiSList', 'CC BY-NC 4.0', 5000, 2.5, 10, 1),
				(2, 'yt', 'UCzzzzzzzzzzzzzzzzzzzzz2', 'Reported Name', NULL, NULL, NULL, NULL, NULL, 10, 1),
				(3, 'tt', '@viewer', 'Never Looked Up', NULL, NULL, NULL, NULL, NULL, NULL, 1)`);
			db.run("INSERT INTO reports (id, install_hash, client_id, platform, source_id, reported_id, source_name, reason, created_at, updated_at) VALUES ('r', 'h', 'c', 'yt', 2, 'UCzzzzzzzzzzzzzzzzzzzzz2', 'Reported Name', 'x', 1, 1)");
			const row = (id: number, sourceId: number, name: string, reason: string, actor: string) =>
				db.run(
					"INSERT INTO decision_log (id, at, platform, target_type, target_id, source_id, source_key, source_name, reason, actor) VALUES (?, 1, 'yt', 'source', 'x', ?, 'x', ?, ?, ?)",
					id,
					sourceId,
					name,
					reason,
					actor
				);
			row(1, 1, 'API Title', 'Likely slop. Listed on the AiSList seed list, it posts at a volume no person could sustain, and it is tagged as slop by the community.', 'community');
			row(2, 1, 'API Title', 'AI-made. Listed on the an imported seed list.', 'appeal');
			row(3, 2, 'Reported Name', 'Staff found it listed on the AiSList seed list.', 'staff');

			db.run(MIGRATIONS[4]!.sql);
			expect(db.all('SELECT id, source_name, reason, reason_original FROM decision_log ORDER BY id')).toEqual([
				{
					id: 1,
					source_name: null,
					reason: 'Likely slop. Listed on an imported seed list, it posts at a volume no person could sustain, and it is tagged as slop by the community.',
					reason_original: 'Likely slop. Listed on the AiSList seed list, it posts at a volume no person could sustain, and it is tagged as slop by the community.'
				},
				{ id: 2, source_name: null, reason: 'AI-made. Listed on an imported seed list.', reason_original: 'AI-made. Listed on the an imported seed list.' },
				// A reviewer's own words are theirs; the name a report gave stays.
				{ id: 3, source_name: 'Reported Name', reason: 'Staff found it listed on the AiSList seed list.', reason_original: null }
			]);
			expect(db.all('SELECT id, name, subscribers, uploads_per_day, youtube_checked_at, import_source FROM sources ORDER BY id')).toEqual([
				{ id: 1, name: null, subscribers: null, uploads_per_day: null, youtube_checked_at: null, import_source: 'AiSList' },
				{ id: 2, name: 'Reported Name', subscribers: null, uploads_per_day: null, youtube_checked_at: null, import_source: null },
				{ id: 3, name: 'Never Looked Up', subscribers: null, uploads_per_day: null, youtube_checked_at: null, import_source: null }
			]);
		});
	});

	it('enforces foreign keys as the Go store did with PRAGMA foreign_keys', async () => {
		await runInDurableObject(env.STORE.getByName('fk'), (store: Store) => {
			expect(() => store.db.run("INSERT INTO tags (install_hash, platform, target_type, target_id, source_id, client_id, verdict, created_at, received_at) VALUES ('nobody', 'yt', 'source', '@x', 1, 'c', 'slop', 1, 1)")).toThrow(/FOREIGN KEY/);
		});
	});
});

describe('tx', () => {
	it('commits on return and rolls every statement back on a throw', async () => {
		await runInDurableObject(env.STORE.getByName('tx'), (store: Store) => {
			const insert = (id: string) => store.db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)', id, `${id}@example.com`);
			expect(store.db.tx(() => (insert('kept'), 'done'))).toBe('done');
			expect(() =>
				store.db.tx(() => {
					insert('lost-1');
					insert('lost-2');
					throw new Error('abort');
				})
			).toThrow('abort');
			// A constraint failure halfway through also leaves nothing behind.
			expect(() => store.db.tx(() => (insert('lost-3'), insert('kept')))).toThrow(/UNIQUE/);
			expect(store.db.all('SELECT id FROM accounts ORDER BY id')).toEqual([{ id: 'kept' }]);
		});
	});

	it('nests as a savepoint: a caught inner throw undoes only the inner work', async () => {
		await runInDurableObject(env.STORE.getByName('tx-nested'), (store: Store) => {
			const insert = (id: string) => store.db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)', id, `${id}@example.com`);
			store.db.tx(() => {
				insert('outer');
				expect(() =>
					store.db.tx(() => {
						insert('inner');
						throw new Error('inner abort');
					})
				).toThrow('inner abort');
			});
			expect(store.db.all('SELECT id FROM accounts')).toEqual([{ id: 'outer' }]);
		});
	});

	it('returns rows written and typed rows', async () => {
		await runInDurableObject(env.STORE.getByName('db'), (store: Store) => {
			expect(store.db.run("INSERT INTO list_requests (hour, count) VALUES (1, 2), (2, 3)")).toBe(2);
			expect(store.db.get<{ n: number }>('SELECT sum(count) AS n FROM list_requests')!.n).toBe(5);
			expect(store.db.get('SELECT * FROM list_requests WHERE hour = 9')).toBeUndefined();
		});
	});
});

describe('router', () => {
	it('answers unknown routes with the contract 404 and names the route for the edge log', async () => {
		const res = await env.STORE.getByName('router').fetch('https://store/v1/nothing/yt/@someone');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'There is no API route for this method and path.' } });
		expect(res.headers.get('x-colander-route')).toBe('GET (unmatched)');
	});
});
