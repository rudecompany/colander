// The tag queue: tags apply on the device at once and are sent in batches, retried with
// backoff while offline or rate limited (P0-5). Planning is pure so it can be tested.
import type { Tag } from '@colander/shared/api';

export interface Queued {
	client_id: string;
	/** `{platform}:{s|i}:{id}`; a newer tag on the same target replaces a queued one. */
	target: string;
	tag: Tag;
	attempts: number;
	nextAt: number;
}

export const BATCH = 50;
const BASE_MS = 30_000;
const MAX_MS = 6 * 60 * 60_000;

/** 30 s, 1 min, 2 min ... capped at 6 hours, with up to 20% jitter so installs spread out. */
export function backoff(attempts: number, random = Math.random): number {
	const ms = Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempts - 1));
	return Math.round(ms * (1 + 0.2 * random()));
}

/** Adds a tag, dropping any queued tag for the same target that has not been sent yet. */
export function enqueue(queue: Queued[], tag: Tag, target: string, now: number): { add: Queued; remove: string[] } {
	return {
		add: { client_id: tag.client_id, target, tag, attempts: 0, nextAt: now },
		remove: queue.filter((q) => q.target === target).map((q) => q.client_id)
	};
}

export function dueBatch(queue: Queued[], now: number): Queued[] {
	return queue.filter((q) => q.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt).slice(0, BATCH);
}

export type Outcome =
	| { kind: 'sent'; accepted: string[]; rejected: { client_id: string; error: string }[] }
	| { kind: 'rate-limited'; retryAfterMs: number }
	| { kind: 'failed' }
	| { kind: 'invalid' };

/** What to delete and what to reschedule after one POST /v1/tags attempt. */
export function settle(batch: Queued[], o: Outcome, now: number, random = Math.random): { remove: string[]; update: Queued[] } {
	switch (o.kind) {
		case 'sent': {
			const done = new Set([...o.accepted, ...o.rejected.map((r) => r.client_id)]);
			// Anything the server neither accepted nor rejected is retried.
			const update = batch.filter((q) => !done.has(q.client_id)).map((q) => ({ ...q, attempts: q.attempts + 1, nextAt: now + backoff(q.attempts + 1, random) }));
			return { remove: [...done], update };
		}
		case 'rate-limited':
			return { remove: [], update: batch.map((q) => ({ ...q, nextAt: now + o.retryAfterMs })) };
		case 'failed':
			return { remove: [], update: batch.map((q) => ({ ...q, attempts: q.attempts + 1, nextAt: now + backoff(q.attempts + 1, random) })) };
		case 'invalid':
			// The server refused the batch as malformed; sending it again cannot succeed.
			return { remove: batch.map((q) => q.client_id), update: [] };
	}
}

export function nextDue(queue: Queued[]): number | null {
	return queue.length ? Math.min(...queue.map((q) => q.nextAt)) : null;
}
