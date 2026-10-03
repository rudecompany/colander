// The tag queue's offline retry planning (P0-5).
import { describe, expect, it } from 'vitest';
import type { Tag } from '@colander/shared/api';
import { backoff, BATCH, dueBatch, enqueue, nextDue, settle, type Queued } from '../../src/background/queue';

const tag = (id: string): Tag => ({
	client_id: id,
	platform: 'yt',
	target_type: 'item',
	target_id: 'dQw4w9WgXcQ',
	source_id: '@chan',
	verdict: 'slop',
	platform_label: false,
	created_at: '2026-10-03T12:00:00Z',
	ext_version: '1.0.0'
});
const q = (id: string, target: string, nextAt = 0, attempts = 0): Queued => ({ client_id: id, target, tag: tag(id), attempts, nextAt });
const noJitter = () => 0;

describe('tag queue', () => {
	it('backs off 30 s, 1, 2, 4 minutes ... up to 6 hours, with at most 20% jitter', () => {
		expect([1, 2, 3, 4].map((n) => backoff(n, noJitter))).toEqual([30_000, 60_000, 120_000, 240_000]);
		expect(backoff(30, noJitter)).toBe(6 * 3600_000);
		expect(backoff(1, () => 1)).toBe(36_000);
	});

	it('a newer tag on the same target replaces the queued one', () => {
		const queue = [q('a', 'yt:i:x'), q('b', 'yt:i:y')];
		const { add, remove } = enqueue(queue, tag('c'), 'yt:i:x', 1000);
		expect(remove).toEqual(['a']);
		expect(add).toMatchObject({ client_id: 'c', target: 'yt:i:x', attempts: 0, nextAt: 1000 });
	});

	it('sends due tags oldest first, at most 50 at a time', () => {
		const queue = Array.from({ length: 70 }, (_, i) => q(`t${i}`, `yt:i:${i}`, 1000 - i));
		queue.push(q('later', 'yt:i:later', 5000));
		const batch = dueBatch(queue, 2000);
		expect(batch).toHaveLength(BATCH);
		expect(batch[0]!.client_id).toBe('t69');
		expect(batch.some((b) => b.client_id === 'later')).toBe(false);
	});

	it('offline: every tag stays and is retried later with growing delays', () => {
		let queue = [q('a', 'yt:i:a'), q('b', 'yt:i:b')];
		let now = 0;
		for (const expected of [30_000, 60_000, 120_000]) {
			const batch = dueBatch(queue, now);
			expect(batch).toHaveLength(2);
			const { remove, update } = settle(batch, { kind: 'failed' }, now, noJitter);
			expect(remove).toEqual([]);
			queue = update;
			expect(nextDue(queue)).toBe(now + expected);
			expect(dueBatch(queue, now + expected - 1)).toHaveLength(0);
			now += expected;
		}
		// Back online: the server accepts one and rejects the other; both leave the queue.
		const { remove, update } = settle(dueBatch(queue, now), { kind: 'sent', accepted: ['a'], rejected: [{ client_id: 'b', error: 'invalid_target' }] }, now);
		expect(remove.sort()).toEqual(['a', 'b']);
		expect(update).toEqual([]);
	});

	it('rate limited: waits for Retry-After without counting an attempt', () => {
		const { update } = settle([q('a', 'yt:i:a', 0, 2)], { kind: 'rate-limited', retryAfterMs: 90_000 }, 1000);
		expect(update[0]).toMatchObject({ attempts: 2, nextAt: 91_000 });
	});

	it('a tag the server left unanswered is retried; a malformed batch is dropped', () => {
		const sent = settle([q('a', 'yt:i:a'), q('b', 'yt:i:b')], { kind: 'sent', accepted: ['a'], rejected: [] }, 0, noJitter);
		expect(sent.remove).toEqual(['a']);
		expect(sent.update.map((u) => u.client_id)).toEqual(['b']);
		expect(settle([q('a', 'yt:i:a')], { kind: 'invalid' }, 0).remove).toEqual(['a']);
	});
});
