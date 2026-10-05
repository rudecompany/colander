// The exact quotas of contracts 6.2 to 6.8 as token buckets (Go's limiter and allow in
// internal/api/respond.go). Go kept them in process memory; here every bucket is a row of the
// Store's `limits` table, so quotas survive restarts and deploys. Take them in the same
// transaction as the write they guard: a write that fails then gives its tokens back.
import type { Db } from './store/db';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Each limiter allows n requests per `per` milliseconds, refilling continuously (Go's newLimiter). */
export const LIMITERS = {
	tags_minute: { n: 60, per: MINUTE },
	tags_day: { n: 500, per: DAY },
	reports: { n: 20, per: DAY },
	appeals: { n: 5, per: DAY },
	/** each automatic appeal check is a live YouTube Data API call that spends the daily quota */
	appeal_verify: { n: 10, per: HOUR },
	appeal_verify_ip: { n: 30, per: HOUR },
	/** a trial lets an install store synced settings without signing in */
	trial_ip: { n: 5, per: DAY },
	auth_email: { n: 5, per: HOUR },
	auth_email_ip: { n: 30, per: HOUR },
	donate: { n: 10, per: HOUR },
	/** pairing codes an account may make; each one ends the one before */
	pair_create: { n: 20, per: HOUR },
	/** a claim carries nothing but the code, so guesses are limited per address */
	pair_claim_ip: { n: 10, per: 10 * MINUTE },
	/**
	 * wrong pairing codes from all addresses together, the baseline the watchdog alerts at
	 * (src/scheduled.ts); it never refuses a claim
	 */
	pair_claim_fail: { n: 300, per: HOUR }
} as const;

export type Limiter = keyof typeof LIMITERS;

/**
 * Takes n tokens for key from every limiter, or none of them. Returns 0 when they were taken,
 * otherwise the milliseconds until the request would fit. now is unix milliseconds.
 */
export function allow(db: Db, now: number, key: string, n: number, ...limiters: Limiter[]): number {
	return db.tx(() => {
		let wait = 0;
		const buckets = limiters.map((name) => {
			const { n: burst, per } = LIMITERS[name];
			const rate = burst / per; // tokens per millisecond
			const row = db.get<{ tokens: number; at: number }>('SELECT tokens, at FROM limits WHERE name = ? AND key = ?', name, key);
			const tokens = row ? Math.min(burst, row.tokens + (now - row.at) * rate) : burst;
			if (tokens < n) wait = Math.max(wait, Math.ceil((Math.min(n, burst) - tokens) / rate));
			return { name, tokens };
		});
		if (wait > 0) return wait;
		for (const b of buckets) {
			db.run(
				`INSERT INTO limits (name, key, tokens, at) VALUES (?, ?, ?, ?)
				ON CONFLICT (name, key) DO UPDATE SET tokens = excluded.tokens, at = excluded.at`,
				b.name,
				key,
				b.tokens - n,
				now
			);
		}
		return 0;
	});
}

/** Whether the bucket for key is empty now: requests came faster than the limiter refills. now is unix milliseconds. */
export function drained(db: Db, now: number, key: string, name: Limiter): boolean {
	const { n, per } = LIMITERS[name];
	const row = db.get<{ tokens: number; at: number }>('SELECT tokens, at FROM limits WHERE name = ? AND key = ?', name, key);
	return !!row && row.tokens + (now - row.at) * (n / per) < 1;
}

/** Drops buckets that have refilled completely: they hold no state worth keeping. */
export function pruneLimits(db: Db, now: number): void {
	for (const [name, { n, per }] of Object.entries(LIMITERS)) {
		db.run('DELETE FROM limits WHERE name = ? AND tokens + (? - at) * ? >= ?', name, now, n / per, n);
	}
}
