// See https://svelte.dev/docs/kit/types#app.d.ts
import type { LogEntry, Stats } from '@colander/shared/api';

declare global {
	namespace App {}
	/** The extension's version and the commit date of its release tag, read at build (vite.config.ts). */
	const __RELEASE__: { version: string; released: string | null };
	/** /v1/stats and the latest decisions read at build, or null when the build had no API. */
	const __BUILD_LIVE__: { stats: Stats; log: LogEntry[]; asOf: string } | null;
}

export {};
