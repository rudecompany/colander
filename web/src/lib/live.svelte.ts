// Live numbers: the values read at build, refreshed in place once a page loads. A failed refresh
// keeps the build values and their "as of" time. There is never a spinner.
import type { LogEntry, LogResponse, Stats } from '@colander/shared/api';
import { api } from './api';

const built = __BUILD_LIVE__;

export const live = $state<{ stats: Stats | null; log: LogEntry[]; asOf: string | null; now: string | null; failed: boolean }>({
	stats: built?.stats ?? null,
	log: built?.log ?? [],
	asOf: built?.asOf ?? null,
	// "3 min ago" is measured from the build time until the page mounts, so the prerendered text and
	// the first client render agree.
	now: built?.asOf ?? null,
	/** The refresh failed; pages keep the build values, or say the numbers could not load. */
	failed: false
});

let started = false;

/** Reads /v1/stats and the latest decisions once per page load. */
export function refreshLive(): void {
	live.now = new Date().toISOString();
	if (started) return;
	started = true;
	api<Stats>('/v1/stats').then(
		(s) => {
			live.stats = s;
			live.asOf = new Date().toISOString();
		},
		() => (live.failed = true)
	);
	api<LogResponse>('/v1/log?limit=4').then(
		(r) => (live.log = r.entries.slice(0, 4)),
		() => {}
	);
}
