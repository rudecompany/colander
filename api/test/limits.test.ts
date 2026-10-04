// The token bucket limiter (src/limits.ts, the port of respond.go's limiter and allow) on the
// Store's limits table.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { allow, LIMITERS, pruneLimits } from '../src/limits';
import { ensureSource } from '../src/store/sources';
import type { Store } from '../src/store/store';

const T = 1_900_000_000_000;
let n = 0;
const fresh = () => env.STORE.getByName(`limits-${++n}`);

describe('allow', () => {
	// Go's TestTagRateLimit at the limiter: 40 tags twice in a minute is too many for one install.
	it('refuses a batch over the minute quota with a wait, per key, and recovers as time passes', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			expect(allow(store.db, T, 'install-1', 40, 'tags_minute', 'tags_day')).toBe(0);
			const wait = allow(store.db, T, 'install-1', 40, 'tags_minute', 'tags_day');
			// 20 tokens are missing at one per second.
			expect(wait).toBe(20_000);
			expect(allow(store.db, T, 'install-2', 40, 'tags_minute', 'tags_day')).toBe(0);
			expect(allow(store.db, T + 60_000, 'install-1', 40, 'tags_minute', 'tags_day')).toBe(0);
		});
	});

	it('takes from every limiter or from none', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			// 480 of the 500 a day, spread over time so the minute quota allows them.
			for (let i = 0; i < 12; i++) expect(allow(store.db, T + i * 60_000, 'k', 40, 'tags_minute', 'tags_day')).toBe(0);
			const tokens = () => store.db.all('SELECT name, tokens FROM limits ORDER BY name');
			const before = tokens();
			// The minute bucket is full again, the day bucket has about 27 left: refused, nothing taken.
			const wait = allow(store.db, T + 20 * 60_000, 'k', 40, 'tags_minute', 'tags_day');
			expect(wait).toBeGreaterThan(30 * 60_000);
			expect(tokens()).toEqual(before);
		});
	});

	it('gives the tokens back when the write it guards fails in the same transaction', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			const db = store.db;
			expect(() =>
				db.tx(() => {
					if (allow(db, T, 'ip-hash', 1, 'appeals')) throw new Error('limited');
					ensureSource(db, 'yt', '@x', '', 1);
					throw new Error('the guarded write failed');
				})
			).toThrow('the guarded write failed');
			expect(db.all('SELECT * FROM limits')).toEqual([]);
			for (let i = 0; i < LIMITERS.appeals.n; i++) expect(allow(db, T, 'ip-hash', 1, 'appeals')).toBe(0);
			expect(allow(db, T, 'ip-hash', 1, 'appeals')).toBe(Math.ceil(LIMITERS.appeals.per / LIMITERS.appeals.n));
		});
	});

	it('keeps quotas across a restart, unlike the Go server', async () => {
		const stub = fresh();
		await runInDurableObject(stub, (store: Store) => {
			for (let i = 0; i < 5; i++) expect(allow(store.db, T, 'email-hash', 1, 'auth_email')).toBe(0);
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, (store: Store) => {
			expect(allow(store.db, T + 1000, 'email-hash', 1, 'auth_email')).toBeGreaterThan(0);
		});
	});

	it('lets a full bucket take a batch larger than its burst, like Go', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			expect(allow(store.db, T, 'k', 70, 'tags_minute')).toBe(0);
			expect(allow(store.db, T, 'k', 1, 'tags_minute')).toBeGreaterThan(0);
		});
	});
});

describe('pruneLimits', () => {
	it('drops only buckets that have refilled completely', async () => {
		await runInDurableObject(fresh(), (store: Store) => {
			allow(store.db, T, 'a', 1, 'donate');
			allow(store.db, T, 'b', 1, 'reports');
			// One of ten donations an hour comes back after 6 minutes; one of 20 reports a day after 72.
			pruneLimits(store.db, T + 5 * 60_000);
			expect(store.db.all('SELECT name FROM limits ORDER BY name')).toEqual([{ name: 'donate' }, { name: 'reports' }]);
			pruneLimits(store.db, T + 7 * 60_000);
			expect(store.db.all('SELECT name FROM limits ORDER BY name')).toEqual([{ name: 'reports' }]);
		});
	});
});
