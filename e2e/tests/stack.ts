// The running stack from Node's side: paths, the server origin, its log, and plain API calls.
// Global setup starts the Worker under `wrangler dev` on http://localhost (passkeys need a domain,
// not an IP address, and the admin host is admin.localhost) and puts its origin and a staff
// member's dev Access token in the environment. With COLANDER_E2E_BASE_URL it starts nothing and the specs that need the local
// stack (dev mail, the seeded data, the server log) skip themselves.
import { expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../..');
export const RUN = resolve(REPO, 'e2e/.run');
export const LOG = resolve(RUN, 'server.log');
export const EXT_ID = 'nninnogmbhfebflkcgghlmjmplmpodlc';
export const EXT_DIR = resolve(RUN, 'extension/chrome-mv3-e2e');
// Set by global setup before any test file loads; Node-side calls read it when they run.
export const ORIGIN = process.env.COLANDER_E2E_ORIGIN ?? '';
const origin = () => process.env.COLANDER_E2E_ORIGIN!;

/** A deployed origin to test instead of the local stack, such as https://staging.getcolander.com. */
export const BASE_URL = process.env.COLANDER_E2E_BASE_URL?.replace(/\/+$/, '') ?? '';
/** Why the journeys skip against a deployed origin. */
export const LOCAL_ONLY = 'needs the local stack: the seeded data, dev mail and the server log';

export const STAFF = 'rae@colander.test';
export const CURATOR = 'sam@colander.test';
/** Made admin through the ops channel's bootstrap in global setup, as the owner does once. */
export const ADMIN = 'ada@colander.test';

/** The admin host of the local stack: admin.localhost on the same port. */
export const adminOrigin = () => origin().replace('//localhost', '//admin.localhost');

/** The server log as bytes written so far; pass it to `mailsSince` to read only what follows. */
export const logMark = () => statSync(LOG).size;
/**
 * What the Worker logged. `wrangler dev` adds a `[wrangler:info] <method> <path>` line per request,
 * which production never writes (invocation logs are off), so those lines are left out.
 */
export const serverLog = () =>
	readFileSync(LOG, 'utf8')
		.split('\n')
		.filter((l) => !l.startsWith('[wrangler:'))
		.join('\n');

/** Emails the Worker printed instead of sending (COLANDER_DEV=1), oldest first. */
export function mailsSince(mark: number): { to: string; subject: string; body: string }[] {
	const text = readFileSync(LOG).subarray(mark).toString('utf8');
	return text
		.split('==== Colander dev mail (not sent) ====')
		.slice(1)
		.map((block) => ({
			to: /^To: (.+)$/m.exec(block)?.[1] ?? '',
			subject: /^Subject: (.+)$/m.exec(block)?.[1] ?? '',
			body: block.split('======================================')[0]!
		}));
}

/** Waits for the sign-in code mailed to `email` after `mark` and returns it. */
export async function signInCode(email: string, mark: number): Promise<string> {
	let code = '';
	await expect
		.poll(() => {
			const mail = mailsSince(mark).find((m) => m.to === email && / is your Colander sign-in code$/.test(m.subject));
			code = /^ {4}(\d{6})$/m.exec(mail?.body ?? '')?.[1] ?? '';
			return code;
		}, { message: `sign-in code for ${email} in the server log` })
		.not.toBe('');
	return code;
}

export interface Reply<T> {
	status: number;
	json: T;
	headers: Headers;
}

/**
 * One request to the origin under test, with the Cloudflare Access service token when
 * CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are set (staging sits behind Access).
 */
export function http(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const id = process.env.CF_ACCESS_CLIENT_ID;
	const secret = process.env.CF_ACCESS_CLIENT_SECRET;
	if (id && secret) {
		headers.set('CF-Access-Client-Id', id);
		headers.set('CF-Access-Client-Secret', secret);
	}
	return fetch(`${origin()}${path}`, { ...init, headers });
}

/**
 * One API call from Node. Non-GET calls carry what a same-origin fetch from the website carries:
 * the CSRF header and Sec-Fetch-Site: same-origin, which cookie routes require.
 */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; cookie?: string; auth?: string } = {}): Promise<Reply<T>> {
	const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	if (method !== 'GET') {
		headers['X-Colander-CSRF'] = '1';
		headers['Sec-Fetch-Site'] = 'same-origin';
	}
	if (init.cookie) headers.Cookie = init.cookie;
	if (init.auth) headers.Authorization = init.auth;
	const res = await http(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
	const text = await res.text();
	return { status: res.status, json: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

/** Signs in with an emailed code and returns the session cookie: member rights only. */
export async function apiSignIn(email: string): Promise<string> {
	const mark = logMark();
	const sent = await api('/v1/auth/code', { body: { email, next: '/account' } });
	expect(sent.status).toBe(202);
	const flow = sent.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
	const res = await api('/v1/auth/code/verify', { body: { code: await signInCode(email, mark) }, cookie: flow });
	expect(res.status).toBe(200);
	return res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}

/**
 * One request to the admin host. Node resolves admin.localhost to ::1 only, where the stack does
 * not listen, so this goes to 127.0.0.1 with the Host header the browser would send.
 */
export function adminHttp(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply<any>> {
	const target = new URL(adminOrigin());
	return new Promise((done, fail) => {
		const req = httpRequest(
			{ host: '127.0.0.1', port: Number(target.port), path, method: init.method ?? 'GET', headers: { ...init.headers, Host: target.host } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					const headers = new Headers();
					for (const [k, v] of Object.entries(res.headers)) for (const one of [v].flat()) if (one !== undefined) headers.append(k, one);
					done({ status: res.statusCode ?? 0, json: text && headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, headers });
				});
			}
		);
		req.on('error', fail);
		req.end(init.body);
	});
}

/** A dev Access token for email from the stub on admin.localhost (dev mode only). */
export async function devAccess(email: string): Promise<string> {
	const res = await adminHttp('/__dev/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
	expect(res.status, JSON.stringify(res.json)).toBe(200);
	return res.json.token as string;
}

/** Admin and review API calls as staff on the admin host, with the Access token global setup got. */
export async function asStaff<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply<T>> {
	const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
	const headers: Record<string, string> = { 'Cf-Access-Jwt-Assertion': process.env.COLANDER_E2E_STAFF_ACCESS! };
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	if (method !== 'GET') Object.assign(headers, { 'X-Colander-CSRF': '1', 'Sec-Fetch-Site': 'same-origin' });
	return adminHttp(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

export const listSequence = async () => (await api<{ list_sequence: number }>('/v1/stats')).json.list_sequence;

/** Waits until the Worker publishes a list sequence after `seq` (at most one publication per 10 seconds). */
export async function publishedAfter(seq: number): Promise<number> {
	await expect.poll(listSequence, { timeout: 20_000, message: 'a new list publication' }).toBeGreaterThan(seq);
	return listSequence();
}
