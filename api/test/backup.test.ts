// Backups (src/backup.ts): the dump round trip through gzip and R2, the SQL it writes, restores
// that refuse what they cannot load, and the 6-hourly dump job.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countsAgree, dump, DUMP_PREFIX, dumpKey, dumpLines, dumpTables, loadDump, newestDump, parseInsert, restoreDump, tableCounts } from '../src/backup';
import { nextDump, STATUS } from '../src/jobs';
import { grantRole, setDisplayName } from '../src/store/accounts';
import type { Db } from '../src/store/db';
import { putSync } from '../src/store/misc';
import { setYouTube } from '../src/store/sources';
import { saveTags } from '../src/store/tags';
import type { Store } from '../src/store/store';

const T = 1_900_000_000_000;
let n = 0;
const fresh = () => env.STORE.getByName(`backup-${++n}`);

/** Every row of every dumped table as SQLite quotes it (so 1, 1.0 and '1' differ), sorted per table. */
function contents(db: Db): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const t of dumpTables(db)) {
		if (t.name === '_migrations') continue;
		const cols = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t.name}')`).map((c) => `quote("${c.name}")`);
		out[t.name] = db.all<{ v: string }>(`SELECT ${cols.join(` || ',' || `)} AS v FROM "${t.name}"`).map((r) => r.v).sort();
	}
	return out;
}

/** Data in every shape the schema holds: text with quotes and line breaks, blobs, reals, NULLs, big integers. */
function fill(store: Store): void {
	const db = store.db;
	const sam = grantRole(db, 'sam@example.com', 'curator', 1_790_000_000);
	setDisplayName(db, sam.id, "Sam 'the curator' O'Neil\r\nsecond line\n\nüñí ✓ 😀");
	grantRole(db, 'rae@example.com', 'staff', 1_790_000_001);
	saveTags(
		db,
		'install-a',
		[
			{ clientId: 'c1', platform: 'yt', targetType: 'source', targetId: '@slopfarm', sourceId: '@slopfarm', verdict: 'slop', slopType: 'filler', tests: 12, platformLabel: true, createdAt: 1_790_000_000, extVersion: '1.0.0' },
			{ clientId: 'c2', platform: 'yt', targetType: 'item', targetId: 'dQw4w9WgXcQ', sourceId: '@slopfarm', verdict: 'ai_fine', slopType: '', tests: 0, platformLabel: false, createdAt: 1_790_000_000, extVersion: '' }
		],
		1_790_000_000
	);
	const ref = db.get<{ id: number }>("SELECT id FROM sources WHERE canonical_id = '@slopfarm'")!.id;
	setYouTube(db, ref, { channelId: 'UCzzzzzzzzzzzzzzzzzzzzz1', handle: '@slopfarm', title: 'Slop Farm', subscribers: 12_345, uploadsPerDay: 3 }, 1_790_000_000);
	db.run('UPDATE sources SET uploads_per_day = 0.1 + 0.2 WHERE id = ?', ref);
	putSync(db, 'acc_1', 0, '{"a":"line\\nbreak","b":[1,2.5]}', 1_790_000_000);
	db.run("INSERT INTO list_sequences (seq, created_at) VALUES (1790000000, 1790000000)");
	db.run("INSERT INTO list_entries (hash, entry, target_key) VALUES (x'00ff10a0b0c0d0e0', x'00ff10a0b0c0d0e0010d040008000000', 'yt:s:@slopfarm')");
	db.run("INSERT INTO list_changes (seq, hash, entry) VALUES (1790000000, x'00ff10a0b0c0d0e0', x'00ff10a0b0c0d0e0010d040008000000')");
	db.run("INSERT INTO youtube_cache (key, body, fetched_at) VALUES ('empty', x'', 1), ('nul', x'0001', 2)");
	db.run("INSERT INTO jobs (name, due_at) VALUES ('publish', 9007199254740991)");
	db.run("INSERT INTO limits (name, key, tokens, at) VALUES ('donate', 'k', 2.0, 1)");
}

const dumpText = (store: Store, state: DurableObjectState) => [...dumpLines(state.storage.sql, store.db, T)].join('\n') + '\n';

/** SQL text as the byte stream loadDump reads. */
const bytes = (text: string) => new Response(text).body!;

afterEach(async () => {
	for (const o of (await env.BACKUPS.list({ prefix: DUMP_PREFIX })).objects) await env.BACKUPS.delete(o.key);
});

describe('dump and restore', () => {
	it('round-trip every table exactly through gzip and R2', async () => {
		const source = fresh();
		const { key, before } = await runInDurableObject(source, async (store: Store, state) => {
			fill(store);
			const d = await dump(state, store.db, env.BACKUPS, T);
			expect(d.key).toBe(`dumps/${new Date(T).toISOString()}.sql.gz`);
			expect(d.bytes).toBe(new TextEncoder().encode(dumpText(store, state)).length);
			expect(d.size).toBe((await env.BACKUPS.head(d.key))!.size);
			expect(d.size).toBeLessThan(d.bytes);
			return { key: d.key, before: contents(store.db) };
		});
		expect(before.accounts).toHaveLength(2);
		expect((await env.BACKUPS.head(key))!.httpMetadata!.contentType).toBe('application/gzip');

		await runInDurableObject(fresh(), async (store: Store) => {
			// Rows the restore replaces.
			grantRole(store.db, 'someone@example.com', 'member', 1);
			const rows = await restoreDump(store.db, env.BACKUPS, key, T);
			expect(rows).toMatchObject({ accounts: 2, tags: 2, sources: 1, list_entries: 1, youtube_cache: 2, jobs: 1, limits: 1 });
			expect(rows).not.toHaveProperty('_migrations');
			expect(contents(store.db)).toEqual(before);
			expect(store.db.get<{ t: string }>("SELECT typeof(uploads_per_day) AS t FROM sources")!.t).toBe('real');
			expect(store.db.all('PRAGMA foreign_key_check')).toEqual([]);
			expect(await restoreDump(store.db, env.BACKUPS, 'dumps/none.sql.gz', T)).toBeUndefined();
		});
	});

	it('write SQL that stock sqlite3 loads: the schema as created, one INSERT per row, indexes last', async () => {
		await runInDurableObject(fresh(), (store: Store, state) => {
			fill(store);
			state.storage.kv.put('status:pass', { at: 1 });
			const lines = dumpText(store, state).trimEnd().split('\n');
			expect(lines.slice(0, 3)).toEqual([`-- Colander Store dump, schema version 4, taken ${new Date(T).toISOString()}`, 'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;']);
			expect(lines.at(-1)).toBe('COMMIT;');
			const text = lines.join('\n');
			for (const t of dumpTables(store.db)) expect(text).toContain(`${t.sql};\n`);
			expect(text).not.toMatch(/__cf_kv|_cf_KV/);
			expect(lines.filter((l) => l.startsWith('INSERT INTO "accounts"'))).toContainEqual(
				expect.stringContaining(`'Sam ''the curator'' O''Neil'||char(13)||''||char(10)||'second line'||char(10)||''||char(10)||'üñí ✓ 😀'`)
			);
			expect(text).toContain(`INSERT INTO "jobs"("name","due_at") VALUES('publish',9007199254740991);`);
			expect(text).toContain(`INSERT INTO "limits"("name","key","tokens","at") VALUES('donate','k',2.0,1);`);
			expect(text).toContain(`VALUES('empty',X'',1);`);
			const firstIndex = lines.findIndex((l) => l.startsWith('CREATE INDEX'));
			expect(firstIndex).toBeGreaterThan(lines.findLastIndex((l) => l.startsWith('INSERT INTO')));
		});
	});

	it('split a dump larger than 5 MiB into equal parts', async () => {
		const parts: number[] = [];
		const bucket = {
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				const upload = await env.BACKUPS.createMultipartUpload(key, options);
				return {
					uploadPart: (part: number, value: Uint8Array) => (parts.push(value.byteLength), upload.uploadPart(part, value)),
					complete: (uploaded: R2UploadedPart[]) => upload.complete(uploaded),
					abort: () => upload.abort()
				};
			}
		} as unknown as R2Bucket;
		const { key, before } = await runInDurableObject(fresh(), async (store: Store, state) => {
			// Random bytes do not compress, so 8 x 700 KB of them make a dump of about 6 MiB.
			for (let i = 0; i < 8; i++) {
				const body = new Uint8Array(700_000);
				for (let at = 0; at < body.length; at += 65_536) crypto.getRandomValues(body.subarray(at, at + 65_536));
				store.db.run('INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, ?, ?)', `k${i}`, body.buffer, i);
			}
			const { key } = await dump(state, store.db, bucket, T);
			return { key, before: contents(store.db) };
		});
		expect(parts.length).toBe(2);
		expect(parts[0]).toBe(5 * 1024 * 1024);
		expect(parts[1]).toBeLessThan(5 * 1024 * 1024);
		await runInDurableObject(fresh(), async (store: Store) => {
			expect((await restoreDump(store.db, env.BACKUPS, key, T))!.youtube_cache).toBe(8);
			expect(contents(store.db)).toEqual(before);
		});
	});

	it('refuse an incomplete dump, or rows this Store cannot hold, and change nothing', async () => {
		await runInDurableObject(fresh(), async (store: Store, state) => {
			fill(store);
			const text = dumpText(store, state);
			const before = contents(store.db);
			await expect(loadDump(store.db, bytes(text.replace('COMMIT;\n', '')), T)).rejects.toThrow(/does not end with COMMIT/);
			await expect(loadDump(store.db, bytes(text.replace('COMMIT;', `INSERT INTO "gone"("a") VALUES(1);\nCOMMIT;`)), T)).rejects.toThrow(/does not know: gone/);
			await expect(loadDump(store.db, bytes(text.replace('INSERT INTO "jobs"("name","due_at")', 'INSERT INTO "jobs"("name","due_at","extra")').replace(`VALUES('publish',9007199254740991)`, `VALUES('publish',1,2)`)), T)).rejects.toThrow();
			await expect(loadDump(store.db, bytes(text.replace(`INSERT INTO "jobs"("name","due_at") VALUES`, `INSERT INTO "jobs"("due_at","name") VALUES`)), T)).rejects.toThrow();
			expect(contents(store.db)).toEqual(before);
			expect(dumpTables(store.db).map((t) => t.name), 'no staging table is left').not.toContainEqual(expect.stringMatching(/^_restore_/));
		});
	});

	it('load a dump from older code into a newer schema: columns added since take their defaults', async () => {
		// The dump of a Store whose code predates sources.mixed (migration 0003).
		const old = await runInDurableObject(fresh(), (store: Store, state) => {
			fill(store);
			store.db.run('ALTER TABLE sources DROP COLUMN mixed');
			return dumpText(store, state);
		});
		expect(old).not.toContain('"mixed"');
		await runInDurableObject(fresh(), async (store: Store) => {
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at, mixed) VALUES ('yt', '@gone', 1, 1)");
			expect((await loadDump(store.db, bytes(old), T)).sources).toBe(1);
			expect(store.db.all('SELECT canonical_id, mixed FROM sources')).toEqual([{ canonical_id: 'UCzzzzzzzzzzzzzzzzzzzzz1', mixed: 0 }]);
		});
	});
});

describe('dumps at scale and under failure', () => {
	it('restore a dump of over 40 MB in bounded batches, without holding it whole', async () => {
		const { key, d, before } = await runInDurableObject(fresh(), async (store: Store, state) => {
			const db = store.db;
			// 60,000 sources with two aliases each, and 300 synced settings of 60 KB.
			db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000)
				INSERT INTO sources (platform, canonical_id, name, created_at, verdict, signals, changed_at) SELECT 'yt', '@channel' || i, 'Channel ' || i, 1790000000, 'slop', 4113, 1790000000 FROM n`
			);
			db.run(`INSERT INTO source_aliases (platform, alias, source_id) SELECT 'yt', canonical_id, id FROM sources`);
			db.run(`INSERT INTO source_aliases (platform, alias, source_id) SELECT 'yt', 'UC' || substr(hex(randomblob(11)), 1, 22), id FROM sources`);
			for (let i = 0; i < 300; i++) putSync(db, `acc_${i}`, 0, JSON.stringify({ blocks: 'x'.repeat(60_000), i }), 1_790_000_000);
			const d = await dump(state, store.db, env.BACKUPS, T);
			return { key: d.key, d, before: tableCounts(db) };
		});
		expect(d.bytes).toBeGreaterThan(40 * 1024 * 1024);
		await runInDurableObject(fresh(), async (store: Store) => {
			const tx = vi.spyOn(store.db, 'tx');
			const rows = await restoreDump(store.db, env.BACKUPS, key, T);
			expect(rows).toMatchObject({ sources: 60_000, source_aliases: 120_000, sync_blobs: 300 });
			expect(tableCounts(store.db)).toEqual(before);
			// Batches of about 1 MB of SQL each, then one swap.
			expect(tx.mock.calls.length).toBeGreaterThan(40);
			expect(store.db.all('PRAGMA foreign_key_check')).toEqual([]);
		});
	}, 120_000);

	it('never reset the Store when the upload fails: the object keeps running and the dump job can back off', async () => {
		const bucket = {
			createMultipartUpload: async (key: string, options?: R2MultipartOptions) => {
				const upload = await env.BACKUPS.createMultipartUpload(key, options);
				return {
					uploadPart: async () => {
						throw new Error('R2 rejected the part');
					},
					complete: (uploaded: R2UploadedPart[]) => upload.complete(uploaded),
					abort: () => upload.abort()
				};
			}
		} as unknown as R2Bucket;
		const stub = fresh();
		await runInDurableObject(stub, async (store: Store, state) => {
			fill(store);
			(store as unknown as { marker: string }).marker = 'same instance';
			await expect(dump(state, store.db, bucket, T)).rejects.toThrow('R2 rejected the part');
		});
		expect(await runInDurableObject(stub, (store: Store) => (store as unknown as { marker?: string }).marker)).toBe('same instance');
		expect(await env.BACKUPS.head(dumpKey(T))).toBeNull();
	});
});

describe('parseInsert', () => {
	it('binds text and blobs and keeps numbers and NULL inline', () => {
		const p = parseInsert(`INSERT INTO "a""b"("x","y y","z","w","v") VALUES('it''s'||char(10)||''||char(13)||'x',X'00FFA1',-1.5e+20,NULL,42);`);
		expect(p.table).toBe('a"b');
		expect(p.sql).toBe(`INSERT INTO "a""b"("x","y y","z","w","v") VALUES(?,?,-1.5e+20,NULL,42)`);
		expect(p.params[0]).toBe("it's\n\rx");
		expect([...new Uint8Array(p.params[1] as ArrayBuffer)]).toEqual([0, 255, 161]);
	});

	it.each([
		'INSERT INTO "t"("a") VALUES(1)',
		'INSERT INTO "t"("a","b") VALUES(1);',
		`INSERT INTO "t"("a") VALUES('open);`,
		'INSERT INTO "t"("a") VALUES(1); DROP TABLE t;',
		`INSERT INTO "t"("a") VALUES(abs(1));`,
		`INSERT INTO "t"("a") VALUES(X'0');`,
		'DELETE FROM "t";'
	])('rejects %s', (line) => {
		expect(() => parseInsert(line)).toThrow(/not an INSERT this Store writes/);
	});
});

describe('drill pieces', () => {
	it('find the newest dump by its time-ordered key', async () => {
		expect(await newestDump(env.BACKUPS)).toBeUndefined();
		for (const t of [T, T + 6 * 3_600_000, T - 1]) await env.BACKUPS.put(dumpKey(t), 'x');
		expect((await newestDump(env.BACKUPS))!.key).toBe(dumpKey(T + 6 * 3_600_000));
	});

	it('count rows per table and tolerate the drift of a few hours', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			fill(store);
			expect(tableCounts(store.db)).toMatchObject({ accounts: 2, tags: 2, jobs: 1 });
			expect(tableCounts(store.db)).not.toHaveProperty('_migrations');
		});
		expect(countsAgree(0, 0)).toBe(true);
		expect(countsAgree(0, 100)).toBe(true);
		expect(countsAgree(0, 200)).toBe(false);
		expect(countsAgree(10_000, 12_000)).toBe(true);
		expect(countsAgree(10_000, 14_000)).toBe(false);
		expect(countsAgree(14_000, 10_000)).toBe(false);
	});
});

describe('the dump job', () => {
	const stub = env.STORE.getByName('primary');

	it('write a dump to the backup bucket at each 6-hourly slot and record how long it blocked', async () => {
		const first = nextDump(T);
		await runInDurableObject(stub, async (store: Store) => {
			store.now = () => T;
			store.jobs.ensure(T);
			await store.jobs.arm();
		});
		await runInDurableObject(stub, (store: Store) => void (store.now = () => first));
		await runDurableObjectAlarm(stub);
		expect(await env.BACKUPS.head(dumpKey(first))).not.toBeNull();
		await runInDurableObject(stub, async (store: Store, state) => {
			expect(state.storage.kv.get(STATUS.dump)).toMatchObject({ at: first, ms: expect.any(Number) });
			expect(store.db.get('SELECT due_at FROM jobs WHERE name = ?', 'dump')).toEqual({ due_at: first + 6 * 3_600_000 });
			store.db.run('DELETE FROM jobs');
			for (const key of Object.values(STATUS)) state.storage.kv.delete(key);
			await state.storage.deleteAlarm();
		});
		await evictDurableObject(stub);
	});
});
