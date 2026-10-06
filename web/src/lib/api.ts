// A small fetch wrapper for the same-origin API (docs/contracts.md section 6).
// Every non-GET request carries the CSRF header that cookie-authenticated routes require. When the
// server asks the person to confirm it is them (403 passkey_required or recent_auth_required), the
// step-up dialog (StepUp.svelte) asks for a passkey or a code, and the request runs once more.
import type { ApiError as ApiErrorBody } from '@colander/shared/api';

/** An error whose message is written for the person, so the page shows it as it is. */
export class PlainError extends Error {}

export class ApiError extends PlainError {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}

const FALLBACK_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

export type StepUpReason = 'passkey_required' | 'recent_auth_required';

let stepUp: ((reason: StepUpReason) => Promise<boolean>) | undefined;

/** Registers the step-up dialog (the layout does): it resolves true once the person confirmed, false when they gave up. */
export function onStepUp(handler: typeof stepUp): void {
	stepUp = handler;
}

type Init = { method?: string; body?: unknown; signal?: AbortSignal; stepUp?: boolean };

export async function api<T>(path: string, init: Init = {}): Promise<T> {
	try {
		return await request<T>(path, init);
	} catch (e) {
		const reason = e instanceof ApiError && e.status === 403 ? e.code : '';
		if (init.stepUp !== false && stepUp && (reason === 'passkey_required' || reason === 'recent_auth_required')) {
			if (await stepUp(reason)) return request<T>(path, init);
		}
		throw e;
	}
}

async function request<T>(path: string, init: Init): Promise<T> {
	const method = init.method ?? 'GET';
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	if (method !== 'GET') headers['X-Colander-CSRF'] = '1';

	let res: Response;
	try {
		res = await fetch(path, {
			method,
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			credentials: 'same-origin',
			signal: init.signal
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		throw new ApiError(0, 'network', 'We could not reach Colander. Check your connection and try again.');
	}

	if (!res.ok) {
		let code = 'http_' + res.status;
		let message = FALLBACK_MESSAGE;
		try {
			const body = (await res.json()) as ApiErrorBody;
			code = body.error?.code ?? code;
			message = body.error?.message ?? message;
		} catch {
			// Not JSON: keep the fallback.
		}
		if (res.status === 429) {
			const wait = Number(res.headers.get('Retry-After'));
			if (wait > 0) message = `Too many tries. Please wait ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''} and try again.`;
		}
		throw new ApiError(res.status, code, message);
	}
	if (res.status === 202 || res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

/** The plain message to show for any thrown value. */
export function errorText(e: unknown): string {
	return e instanceof PlainError ? e.message : FALLBACK_MESSAGE;
}
