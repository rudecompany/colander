// Values vitest.config.ts reads in Node and hands to the tests (contract fixtures come from
// packages/shared/test/contract-files.ts).
export {};

declare module 'vitest' {
	export interface ProvidedContext {
		/** sqlite_master of a database built from server/internal/store/migrations. */
		goSchema: { type: string; name: string; tbl_name: string; sql: string | null }[];
	}
}
