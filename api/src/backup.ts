// Backups (hosting plan section 3): a gzip SQL dump of the Store every 6 hours into the backup
// bucket, the restore of a dump into a Store, and the pieces of the weekly restore drill.
//
// A dump is plain SQL that stock sqlite3 loads (`gunzip -c dump.sql.gz | sqlite3 colander.db`):
// the CREATE statements of every table, one INSERT per row with its column names, then the
// indexes, inside one transaction. Each INSERT is on one line: SQLite's quote() writes every
// value exactly, and line breaks inside text become ||char(10)||. A restore into a Store keeps the
// Store's own schema (its migrations) and replaces the rows of every table with the dump's, so a
// dump from older code loads into newer code (expand-then-contract keeps new columns defaulted).
import type { Db } from './store/db';
import { migrate } from './store/migrations';

/** Dumps live under this prefix, named by their time, so the newest sorts last. */
export const DUMP_PREFIX = 'dumps/';

/** R2 multipart parts must all have this size except the last, and at least 5 MiB. */
const PART_SIZE = 5 * 1024 * 1024;

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Not dumped: SQLite's own tables and the runtime's (__cf_kv holds the synchronous KV status). */
const INTERNAL = `name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'`;

/** The tables a dump holds, in creation order, with their CREATE statements. */
export function dumpTables(db: Db): { name: string; sql: string }[] {
	return db.all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${INTERNAL} ORDER BY rowid`);
}

/** The key a dump taken at now (unix ms) is stored under. */
export const dumpKey = (now: number): string => `${DUMP_PREFIX}${new Date(now).toISOString()}.sql.gz`;

/**
 * The dump as SQL lines. It reads the tables lazily, so the caller must keep writes out until it
 * is done: the backup runs it inside blockConcurrencyWhile.
 */
export function* dumpLines(sql: SqlStorage, db: Db, now: number): Generator<string> {
	const version = db.get<{ v: number }>('SELECT max(version) AS v FROM _migrations')?.v ?? 0;
	yield `-- Colander Store dump, schema version ${version}, taken ${new Date(now).toISOString()}`;
	yield 'PRAGMA foreign_keys=OFF;';
	yield 'BEGIN TRANSACTION;';
	const tables = dumpTables(db);
	for (const t of tables) yield `${t.sql};`;
	for (const t of tables) {
		const columns = sql.exec(`SELECT * FROM ${ident(t.name)} LIMIT 0`).columnNames;
		const head = `INSERT INTO ${ident(t.name)}(${columns.map(ident).join(',')}) VALUES(`;
		const values = columns.map((c) => `quote(${ident(c)})`).join(` || ',' || `);
		for (const row of sql.exec<{ v: string }>(`SELECT ${values} AS v FROM ${ident(t.name)}`)) {
			// Raw line breaks can only occur inside text literals, so this keeps every value exact.
			yield `${head}${row.v.replaceAll('\r', "'||char(13)||'").replaceAll('\n', "'||char(10)||'")});`;
		}
	}
	for (const { sql: s } of db.all<{ sql: string }>(
		`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL AND ${INTERNAL} ORDER BY rowid`
	)) {
		yield `${s};`;
	}
	yield 'COMMIT;';
}

/** Lines as a byte stream, a batch per pull, so a large dump never sits in memory whole. */
function lineStream(lines: Iterator<string>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		pull(controller) {
			let batch = '';
			for (let i = 0; i < 1000; i++) {
				const next = lines.next();
				if (next.done) {
					if (batch) controller.enqueue(encoder.encode(batch));
					controller.close();
					return;
				}
				batch += next.value + '\n';
			}
			controller.enqueue(encoder.encode(batch));
		}
	});
}

/** Uploads a stream as an R2 multipart object of equal PART_SIZE parts (R2 requires that), the last one shorter. */
async function uploadParts(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>): Promise<R2Object> {
	const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/gzip' } });
	try {
		const parts: R2UploadedPart[] = [];
		let part = new Uint8Array(PART_SIZE);
		let filled = 0;
		const reader = body.getReader();
		for (let r = await reader.read(); !r.done; r = await reader.read()) {
			for (let at = 0; at < r.value.length; ) {
				const n = Math.min(PART_SIZE - filled, r.value.length - at);
				part.set(r.value.subarray(at, at + n), filled);
				filled += n;
				at += n;
				if (filled === PART_SIZE) {
					parts.push(await upload.uploadPart(parts.length + 1, part));
					part = new Uint8Array(PART_SIZE);
					filled = 0;
				}
			}
		}
		if (filled > 0 || parts.length === 0) parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, filled)));
		return await upload.complete(parts);
	} catch (err) {
		await upload.abort().catch(() => undefined);
		throw err;
	}
}

/**
 * Streams a consistent dump through gzip into the backup bucket and returns its key and size.
 * ponytail: the whole dump runs inside blockConcurrencyWhile, which the platform caps at 30 s
 * (the watchdog alerts at 10 s). Before it reaches 20 s, switch to a per-table export with a
 * foreign-key check on restore.
 */
export function dump(ctx: DurableObjectState, db: Db, bucket: R2Bucket, now: number): Promise<{ key: string; size: number }> {
	return ctx.blockConcurrencyWhile(async () => {
		const key = dumpKey(now);
		const gz = lineStream(dumpLines(ctx.storage.sql, db, now)).pipeThrough(new CompressionStream('gzip'));
		const obj = await uploadParts(bucket, key, gz);
		console.log(JSON.stringify({ message: 'dump written', key, bytes: obj.size }));
		return { key, size: obj.size };
	});
}

/** One INSERT line of a dump as a statement: numbers and NULL stay inline, text and blobs are bound. */
export function parseInsert(line: string): { table: string; sql: string; params: SqlStorageValue[] } {
	let i = 0;
	const fail = (what: string): never => {
		throw new Error(`dump line is not an INSERT this Store writes (${what} at ${i}): ${line.slice(0, 120)}`);
	};
	const expect = (s: string) => {
		if (!line.startsWith(s, i)) fail(`expected ${s}`);
		i += s.length;
	};
	const quoted = (q: string): string => {
		expect(q);
		let out = '';
		for (;;) {
			const end = line.indexOf(q, i);
			if (end < 0) fail('unterminated quote');
			out += line.slice(i, end);
			i = end + 1;
			if (line[i] !== q) return out;
			out += q;
			i++;
		}
	};
	expect('INSERT INTO ');
	const table = quoted('"');
	expect('(');
	const columns = [quoted('"')];
	while (line[i] === ',') {
		i++;
		columns.push(quoted('"'));
	}
	expect(') VALUES(');
	const values: string[] = [];
	const params: SqlStorageValue[] = [];
	for (;;) {
		if (line.startsWith('NULL', i)) {
			values.push('NULL');
			i += 4;
		} else if (line.startsWith("X'", i)) {
			i++;
			const h = quoted("'");
			if (!/^(?:[0-9A-F]{2})*$/.test(h)) fail('bad blob');
			params.push(Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16)).buffer);
			values.push('?');
		} else if (line[i] === "'") {
			let text = quoted("'");
			for (;;) {
				const brk = line.startsWith("||char(10)||'", i) ? '\n' : line.startsWith("||char(13)||'", i) ? '\r' : '';
				if (!brk) break;
				i += 12;
				text += brk + quoted("'");
			}
			params.push(text);
			values.push('?');
		} else {
			const m = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(line.slice(i));
			if (!m) fail('bad value');
			values.push(m![0]);
			i += m![0].length;
		}
		if (line[i] !== ',') break;
		i++;
	}
	expect(');');
	if (i !== line.length) fail('trailing text');
	if (values.length !== columns.length) fail(`${values.length} values for ${columns.length} columns`);
	return { table, sql: `INSERT INTO ${ident(table)}(${columns.map(ident).join(',')}) VALUES(${values.join(',')})`, params };
}

/**
 * Replaces the rows of every table with the dump's, in one transaction, and returns the rows
 * loaded per table. It keeps the Store's schema and _migrations; a table or column this Store does
 * not know fails the whole restore, and so does a dump that does not end with its COMMIT.
 * ponytail: the whole dump text sits in memory while it loads; stage it in chunks once dumps pass
 * about 30 MB uncompressed.
 */
export function loadDump(db: Db, text: string, now: number): Record<string, number> {
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	if (lines.at(-1) !== 'COMMIT;') throw new Error('the dump is incomplete: it does not end with COMMIT');
	const statements = lines.filter((l) => l.startsWith('INSERT INTO ')).map(parseInsert);
	// A drill Store after deleteAll() has no tables until its migrations run again.
	migrate(db, now);
	const counts: Record<string, number> = {};
	for (const t of dumpTables(db)) if (t.name !== '_migrations') counts[t.name] = 0;
	return db.tx(() => {
		// The rows go in table by table; foreign keys are checked once, at commit.
		db.run('PRAGMA defer_foreign_keys = ON');
		for (const t of Object.keys(counts)) db.run(`DELETE FROM ${ident(t)}`);
		for (const s of statements) {
			if (s.table === '_migrations') continue;
			if (!(s.table in counts)) throw new Error(`the dump has a table this Store does not know: ${s.table}`);
			db.run(s.sql, ...s.params);
			counts[s.table]!++;
		}
		return counts;
	});
}

/** Reads a dump from the backup bucket and loads it with loadDump. Undefined when there is no such dump. */
export async function restoreDump(db: Db, bucket: R2Bucket, key: string, now: number): Promise<Record<string, number> | undefined> {
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text();
	return loadDump(db, text, now);
}

/** Rows per table, for the drill's comparison between a loaded dump and the primary Store. */
export function tableCounts(db: Db): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const t of dumpTables(db)) {
		if (t.name !== '_migrations') counts[t.name] = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${ident(t.name)}`)!.n;
	}
	return counts;
}

/** The newest dump in the bucket, or undefined when there is none. */
export async function newestDump(bucket: R2Bucket): Promise<R2Object | undefined> {
	let newest: R2Object | undefined;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: DUMP_PREFIX, cursor });
		for (const o of page.objects) if (!newest || o.key > newest.key) newest = o;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return newest;
}

/**
 * Whether a dump's row count is close enough to the primary's: the dump is up to 7 hours old, so
 * tables grow and churn in between, but a missing or emptied table never passes.
 * ponytail: one tolerance for every table; give fast-churning tables their own once real traffic
 * shows how far they drift in 7 hours.
 */
export function countsAgree(dumped: number, primary: number): boolean {
	return Math.abs(dumped - primary) <= 100 + 0.25 * Math.max(dumped, primary);
}
