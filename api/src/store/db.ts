// A thin typed layer over the Store's SQLite (ctx.storage.sql), plus the helpers Go's store.go
// shared between its files. Every call is synchronous and fully consumes its cursor, so no result
// ever spans an await.

export type Row = Record<string, SqlStorageValue>;

export class Db {
	/** Rows read by every statement since the object started; the watchdog reports them per pass. */
	rowsRead = 0;

	constructor(private readonly storage: DurableObjectStorage) {}

	private exec<T extends Row>(query: string, params: SqlStorageValue[]): { rows: T[]; written: number } {
		const cursor = this.storage.sql.exec<T>(query, ...params);
		const rows = cursor.toArray();
		this.rowsRead += cursor.rowsRead;
		return { rows, written: cursor.rowsWritten };
	}

	/**
	 * Runs one or more statements; bindings apply to the last one. Returns rows written, which
	 * counts index rows too: use it as Go's RowsAffected only to test for zero.
	 */
	run(query: string, ...params: SqlStorageValue[]): number {
		return this.exec(query, params).written;
	}

	all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.exec<T>(query, params).rows;
	}

	/** The first row, or undefined (Go's QueryRow without ErrNoRows). */
	get<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
		return this.all<T>(query, ...params)[0];
	}

	/**
	 * Runs fn in one SQLite transaction and commits when it returns; a throw rolls everything back.
	 * fn must be synchronous: keep network calls outside, as the Go store did with s.Tx.
	 * A nested tx is a savepoint: an inner throw that the outer fn catches undoes only the inner work.
	 * SQL BEGIN and SAVEPOINT statements are refused by the runtime; use this instead.
	 */
	tx<T>(fn: () => T): T {
		return this.storage.transactionSync(fn);
	}
}

/** Go's store.ErrNotFound, thrown by writes that need an existing row. Lookups return undefined. */
export class NotFoundError extends Error {
	constructor() {
		super('not found');
	}
}

/** Go's store.ErrConflict: a row is not in the state an update needs. */
export class ConflictError extends Error {
	constructor() {
		super('conflict');
	}
}

/** Go's nullString: "" becomes NULL. */
export const nullString = (s: string): string | null => (s === '' ? null : s);

/** Go's nullInt: 0 becomes NULL. */
export const nullInt = (v: number): number | null => (v === 0 ? null : v);

/** "?, ?, ?" for n arguments. */
export const placeholders = (n: number): string => Array<string>(n).fill('?').join(', ');

/** SQLite has no booleans: Go's driver binds them as 0 and 1. */
export const bit = (b: boolean): number => (b ? 1 : 0);

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Go's NewID: prefix + "_" + 16 random lowercase characters (80 bits, unpadded base32). */
export function newId(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	let out = '', acc = 0, bits = 0;
	for (const b of bytes) {
		acc = ((acc << 8) | b) & 0xffff;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += ID_ALPHABET[(acc >> bits) & 31];
		}
	}
	return `${prefix}_${out}`;
}
