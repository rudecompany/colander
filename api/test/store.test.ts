// The Store Durable Object: migrations, the transaction helper and the internal router.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, inject, it } from 'vitest';
import { MIGRATIONS } from '../src/store/migrations';
import type { Store } from '../src/store/store';

const NEW_TABLES = ['_migrations', 'jobs', 'limits'];
const schema = (store: Store) =>
	store.db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
		// _cf_* and __cf_* are the platform's own tables.
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_cf\\_%' ESCAPE '\\' ORDER BY name"
	);

describe('migrations', () => {
	it('builds exactly the Go schema plus _migrations, limits and jobs', async () => {
		const rows = await runInDurableObject(env.STORE.getByName('migrations'), (store: Store) => schema(store));
		const go = inject('goSchema');
		expect(rows.filter((r) => !NEW_TABLES.includes(r.tbl_name))).toEqual(go);
		expect([...new Set(rows.filter((r) => NEW_TABLES.includes(r.tbl_name)).map((r) => r.tbl_name))].sort()).toEqual(NEW_TABLES);
		expect(go.length).toBeGreaterThan(50);
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
		const res = await env.STORE.getByName('router').fetch('https://store/v1/sources/yt/@someone');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'There is no API route for this method and path.' } });
		expect(res.headers.get('x-colander-route')).toBe('GET (unmatched)');
	});
});
