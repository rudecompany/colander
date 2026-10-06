// The review API for curators (docs/contracts.md 6.7), called with the reviewer bearer token. In
// Firefox the token leaves only while "Plus and review" is allowed (lib/consent.ts, contracts 8).
import type { DecisionInput, QueueItem, ReviewSourceResponse } from '@colander/shared/api';
import type { Platform } from '@colander/shared/verdicts';
import { allowed } from '../lib/consent';
import { API } from '../lib/env';

export class ReviewError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
	if (!(await allowed('authenticationInfo'))) throw new ReviewError(0, 'consent', 'Firefox has not allowed Colander to use your reviewer sign-in.');
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: 'omit',
			cache: 'no-store'
		});
	} catch {
		throw new ReviewError(0, 'offline', 'Could not reach Colander. Check your connection and try again.');
	}
	if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
	let code = `http_${res.status}`, message = 'Something went wrong. Try again in a moment.';
	try {
		const e = (await res.json()) as { error?: { code?: string; message?: string } };
		code = e.error?.code ?? code;
		message = e.error?.message ?? message;
	} catch {
		// keep the generic message
	}
	if (res.status === 403 && code === 'staff_required') message = 'This needs staff review: staff decide large sources and appeals in the admin console.';
	throw new ReviewError(res.status, code, message);
}

export const review = {
	queue: (t: string, kind: string, cursor?: string | null) =>
		call<{ items: QueueItem[]; next_cursor: string | null }>(t, `/v1/review/queue?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
	source: (t: string, p: Platform, id: string) => call<ReviewSourceResponse>(t, `/v1/review/sources/${p}/${encodeURIComponent(id)}`),
	decideSource: (t: string, p: Platform, id: string, d: DecisionInput) => call<unknown>(t, `/v1/review/sources/${p}/${encodeURIComponent(id)}/decision`, d),
	decideItem: (t: string, p: Platform, id: string, d: DecisionInput) => call<unknown>(t, `/v1/review/items/${p}/${encodeURIComponent(id)}/decision`, d),
	dismiss: (t: string, reportId: string, reason: string) => call<unknown>(t, `/v1/review/reports/${encodeURIComponent(reportId)}/dismiss`, { reason })
};
