// HTTP to the Colander API (docs/contracts.md section 6). The server sends CORS headers, so
// the extension needs no host permission for it. No request carries a page URL (section 8).
import { b64url } from '@colander/shared/bytes';
import { API } from '../lib/env';
import { K } from '../lib/settings';

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly retryAfterMs = 0
	) {
		super(message);
	}
}

/** 16 random bytes as unpadded base64url, made once per install (contract 2.4). */
export async function installId(): Promise<string> {
	const got = await chrome.storage.local.get(K.installId);
	const have = got[K.installId] as string | undefined;
	if (have) return have;
	const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
	await chrome.storage.local.set({ [K.installId]: id });
	return id;
}

export type Auth = { install: true } | { plan: string } | { reviewer: string } | null;

export async function request(path: string, init: { method?: string; body?: unknown; auth?: Auth } = {}): Promise<Response> {
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	const a = init.auth;
	if (a && 'install' in a) headers.Authorization = `Install ${await installId()}`;
	else if (a && 'plan' in a) headers.Authorization = `Plan ${a.plan}`;
	else if (a && 'reviewer' in a) headers.Authorization = `Bearer ${a.reviewer}`;
	return fetch(`${API}${path}`, {
		method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
		headers,
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		credentials: 'omit',
		cache: 'no-store'
	});
}

/** Throws ApiError with the server's plain-language message for any non-2xx answer. */
export async function json<T>(res: Response): Promise<T> {
	if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
	let code = 'http_' + res.status, message = 'Something went wrong. Try again in a moment.';
	try {
		const e = (await res.json()) as { error?: { code?: string; message?: string } };
		if (e.error?.code) code = e.error.code;
		if (e.error?.message) message = e.error.message;
	} catch {
		// Not JSON; keep the generic message.
	}
	const retry = Number(res.headers.get('Retry-After'));
	throw new ApiError(res.status, code, message, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0);
}
