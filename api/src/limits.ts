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
	/** sign-in codes sent to one address: 5 an hour and 10 a day (contracts 6.6) */
	auth_email: { n: 5, per: HOUR },
	auth_email_day: { n: 10, per: DAY },
	auth_email_ip: { n: 30, per: HOUR },
	/** code tries per IP */
	auth_verify_ip: { n: 30, per: HOUR },
	/** wrong codes for one address across all its codes; when they run out, auth_lock is taken */
	auth_fail: { n: 10, per: DAY },
	/** one token that refills in exactly 24 hours: taken, code sign-in is off for the address that long */
	auth_lock: { n: 1, per: DAY },
	/** passkey challenges started without a session, per IP */
	passkey_options_ip: { n: 60, per: HOUR },
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

/** Whether one token of limiter is left for key, without taking it. now is unix milliseconds. */
export function available(db: Db, now: number, key: string, limiter: Limiter): boolean {
	const { n: burst, per } = LIMITERS[limiter];
	const row = db.get<{ tokens: number; at: number }>('SELECT tokens, at FROM limits WHERE name = ? AND key = ?', limiter, key);
	return !row || Math.min(burst, row.tokens + (now - row.at) * (burst / per)) >= 1;
}

/** Drops buckets that have refilled completely: they hold no state worth keeping. */
export function pruneLimits(db: Db, now: number): void {
	for (const [name, { n, per }] of Object.entries(LIMITERS)) {
		db.run('DELETE FROM limits WHERE name = ? AND tokens + (? - at) * ? >= ?', name, now, n / per, n);
	}
}
