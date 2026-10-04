// Backups (hosting plan section 3): a gzip SQL dump of the Store every 6 hours into the backup
// bucket, the restore of a dump into a Store, and the pieces of the weekly restore drill.
//
// A dump is plain SQL that stock sqlite3 loads (`gunzip -c dump.sql.gz | sqlite3 colander.db`):
// the CREATE statements of every table, one INSERT per row with its column names, then the
// indexes, inside one transaction. Each INSERT is on one line: SQLite's quote() writes every
// value exactly, and line breaks inside text become ||char(10)||. A restore into a Store keeps the
// Store's own schema (its migrations) and replaces the rows of every table with the dump's, so a
// dump from older code loads into newer code (expand-then-contract keeps new columns defaulted).
import type { DumpResult } from './jobs';
import type { Db } from './store/db';
import { migrate } from './store/migrations';

/** Dumps live under this prefix, named by their time, so the newest sorts last. */
export const DUMP_PREFIX = 'dumps/';

/** R2 multipart parts must all have this size except the last, and at least 5 MiB. */
const PART_SIZE = 5 * 1024 * 1024;

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A restore loads each table into a staging table with this prefix first (loadDump). */
const STAGE = '_restore_';

/**
 * Not dumped: SQLite's own tables, the runtime's (__cf_kv holds the synchronous KV status) and a
 * restore's staging tables.
 */
const INTERNAL = `name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB '${STAGE}*'`;

/**
 * Tables a dump creates but holds no rows of: YouTube Data API data may not be kept 30 days
 * (Developer Policies III.E.4), and backups are kept 90. A restore leaves them empty.
 */
export const API_DATA_TABLES = new Set(['youtube_cache', 'youtube_channels']);

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
		if (API_DATA_TABLES.has(t.name)) continue;
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

/** Lines as a byte stream, a batch per pull, so the SQL never sits in memory whole. counted gets each batch's size. */
function lineStream(lines: Iterator<string>, counted: (bytes: number) => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const send = (controller: ReadableStreamDefaultController<Uint8Array>, batch: string) => {
		const bytes = encoder.encode(batch);
		counted(bytes.length);
		controller.enqueue(bytes);
	};
	return new ReadableStream({
		pull(controller) {
			let batch = '';
			for (let i = 0; i < 1000; i++) {
				const next = lines.next();
				if (next.done) {
					if (batch) send(controller, batch);
					controller.close();
					return;
				}
				batch += next.value + '\n';
			}
			send(controller, batch);
		}
	});
}

/** Collects a byte stream into equal PART_SIZE parts (R2 multipart requires that), the last one shorter. */
async function collectParts(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
	const parts: Uint8Array[] = [];
	let part = new Uint8Array(PART_SIZE);
	let filled = 0;
	for await (const chunk of body) {
		for (let at = 0; at < chunk.length; ) {
			const n = Math.min(PART_SIZE - filled, chunk.length - at);
			part.set(chunk.subarray(at, at + n), filled);
			filled += n;
			at += n;
			if (filled === PART_SIZE) {
				parts.push(part);
				part = new Uint8Array(PART_SIZE);
				filled = 0;
			}
		}
	}
	if (filled > 0 || parts.length === 0) parts.push(part.subarray(0, filled));
	return parts;
}

/** Uploads the parts as one R2 multipart object. */
async function uploadParts(bucket: R2Bucket, key: string, parts: Uint8Array[]): Promise<R2Object> {
	const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/gzip' } });
	try {
		const uploaded: R2UploadedPart[] = [];
		for (const part of parts) uploaded.push(await upload.uploadPart(uploaded.length + 1, part));
		return await upload.complete(uploaded);
	} catch (err) {
		await upload.abort().catch(() => undefined);
		throw err;
	}
}

/**
 * Takes a consistent dump, gzipped, and uploads it to the backup bucket. Only reading and
 * compressing block the Store; the upload runs after, so a slow or failing R2 never holds the
 * Store or resets it (blockConcurrencyWhile resets the object when its callback throws or passes
 * 30 s, so the callback here never throws).
 * ponytail: the whole compressed dump sits in memory while it blocks, and the platform caps the
 * block at 30 s (the watchdog alerts at 10 s and at 32 MiB of gzip). Before either nears its
 * limit, switch to a per-table export with a foreign-key check on restore.
 */
export async function dump(ctx: DurableObjectState, db: Db, bucket: R2Bucket, now: number): Promise<{ key: string } & DumpResult> {
	const key = dumpKey(now);
	const started = Date.now();
	const taken = await ctx.blockConcurrencyWhile(async () => {
		try {
			let bytes = 0;
			const sql = lineStream(dumpLines(ctx.storage.sql, db, now), (n) => (bytes += n));
			return { parts: await collectParts(sql.pipeThrough(new CompressionStream('gzip'))), bytes };
		} catch (err) {
			return { err };
		}
	});
	const ms = Date.now() - started;
	if ('err' in taken) throw taken.err;
	const obj = await uploadParts(bucket, key, taken.parts);
	console.log(JSON.stringify({ message: 'dump written', key, bytes: taken.bytes, size: obj.size, ms }));
	return { key, ms, bytes: taken.bytes, size: obj.size };
}

/** One parsed INSERT line of a dump. */
export interface Insert {
	table: string;
	columns: string[];
	/** the statement, for the table it names */
	sql: string;
	params: SqlStorageValue[];
	/** the same statement for another table */
	into(table: string): string;
}

/** One INSERT line of a dump as a statement: numbers and NULL stay inline, text and blobs are bound. */
export function parseInsert(line: string): Insert {
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
	const into = (t: string) => `INSERT INTO ${ident(t)}(${columns.map(ident).join(',')}) VALUES(${values.join(',')})`;
	return { table, columns, sql: into(table), params, into };
}

/** The text lines of a byte stream, without their line breaks, one at a time. */
async function* textLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	let rest = '';
	for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
		const lines = (rest + chunk).split('\n');
		rest = lines.pop()!;
		yield* lines;
	}
	if (rest !== '') yield rest;
}

/** A batch of rows goes into the staging tables per transaction once it holds this much SQL. */
const BATCH_CHARS = 1 << 20;

/**
 * Replaces the rows of every table with the dump's SQL text (a stream of UTF-8 bytes) and returns
 * the rows loaded per table. It keeps the Store's schema and _migrations; a table or column this
 * Store does not know fails the whole restore, and so does a dump that does not end with its
 * COMMIT. API_DATA_TABLES end up empty and are left out of the counts. The rows stream into staging tables in bounded batches, so a dump never sits in memory
 * whole; one transaction then swaps them in, so the live tables change all at once or not at all.
 * Requests keep being served from the live tables meanwhile, and what they write is replaced.
 */
export async function loadDump(db: Db, body: ReadableStream<Uint8Array>, now: number): Promise<Record<string, number>> {
	// A drill Store after deleteAll() has no tables until its migrations run again.
	migrate(db, now);
	const counts: Record<string, number> = {};
	for (const t of dumpTables(db)) if (t.name !== '_migrations') counts[t.name] = 0;
	const tables = Object.keys(counts);
	const columns = new Map<string, string[]>();
	const dropStages = () => db.tx(() => tables.forEach((t) => db.run(`DROP TABLE IF EXISTS ${ident(STAGE + t)}`)));
	dropStages();
	try {
		// Staging tables with the live columns and affinities, without constraints.
		db.tx(() => tables.forEach((t) => db.run(`CREATE TABLE ${ident(STAGE + t)} AS SELECT * FROM ${ident(t)} WHERE 0`)));
		let batch: Insert[] = [];
		let chars = 0;
		const flush = () => {
			db.tx(() => batch.forEach((s) => db.run(s.into(STAGE + s.table), ...s.params)));
			batch = [];
			chars = 0;
		};
		let last = '';
		for await (const line of textLines(body)) {
			last = line;
			if (!line.startsWith('INSERT INTO ')) continue;
			const s = parseInsert(line);
			// Dumps from before API_DATA_TABLES held their rows: those stay out.
			if (s.table === '_migrations' || API_DATA_TABLES.has(s.table)) continue;
			if (!(s.table in counts)) throw new Error(`the dump has a table this Store does not know: ${s.table}`);
			const known = columns.get(s.table);
			if (!known) columns.set(s.table, s.columns);
			else if (known.join() !== s.columns.join()) throw new Error(`the dump's rows of ${s.table} name different columns`);
			batch.push(s);
			counts[s.table]!++;
			chars += line.length;
			if (chars >= BATCH_CHARS) flush();
		}
		flush();
		if (last !== 'COMMIT;') throw new Error('the dump is incomplete: it does not end with COMMIT');
		db.tx(() => {
			// The rows go in table by table; foreign keys are checked once, at commit. Columns the dump
			// lacks (it predates them) take their defaults.
			db.run('PRAGMA defer_foreign_keys = ON');
			for (const t of tables) db.run(`DELETE FROM ${ident(t)}`);
			for (const [t, cols] of columns) {
				const list = cols.map(ident).join(',');
				db.run(`INSERT INTO ${ident(t)}(${list}) SELECT ${list} FROM ${ident(STAGE + t)}`);
			}
		});
		for (const t of API_DATA_TABLES) delete counts[t];
		return counts;
	} finally {
		dropStages();
	}
}

/** Reads a dump from the backup bucket and loads it with loadDump. Undefined when there is no such dump. */
export async function restoreDump(db: Db, bucket: R2Bucket, key: string, now: number): Promise<Record<string, number> | undefined> {
	const obj = await bucket.get(key);
	if (!obj) return undefined;
	return loadDump(db, obj.body.pipeThrough(new DecompressionStream('gzip')), now);
}

/** Rows per table, for the drill's comparison between a loaded dump and the primary Store. */
export function tableCounts(db: Db): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const t of dumpTables(db)) {
		if (t.name !== '_migrations' && !API_DATA_TABLES.has(t.name)) counts[t.name] = db.get<{ n: number }>(`SELECT count(*) AS n FROM ${ident(t.name)}`)!.n;
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
