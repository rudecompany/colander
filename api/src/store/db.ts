// A thin typed layer over the Store's SQLite (ctx.storage.sql). Every call is synchronous and fully
// consumes its cursor, so no result ever spans an await.

export type Row = Record<string, SqlStorageValue>;

export class Db {
	constructor(private readonly storage: DurableObjectStorage) {}

	/** Runs one or more statements; bindings apply to the last one. Returns rows written. */
	run(query: string, ...params: SqlStorageValue[]): number {
		const cursor = this.storage.sql.exec(query, ...params);
		cursor.toArray();
		return cursor.rowsWritten;
	}

	all<T extends Row>(query: string, ...params: SqlStorageValue[]): T[] {
		return this.storage.sql.exec<T>(query, ...params).toArray();
	}

	/** The first row, or undefined (Go's QueryRow without ErrNoRows). */
	get<T extends Row>(query: string, ...params: SqlStorageValue[]): T | undefined {
		return this.all<T>(query, ...params)[0];
	}

	/**
	 * Runs fn in one SQLite transaction and commits when it returns; a throw rolls everything back.
	 * fn must be synchronous: keep network calls outside, as the Go store did with s.Tx.
	 */
	tx<T>(fn: () => T): T {
		return this.storage.transactionSync(fn);
	}
}
