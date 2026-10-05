// The running stack from Node's side: paths, the server origin, its log, and plain API calls.
// Global setup starts the Worker under `wrangler dev` and puts its origin and a staff session in
// the environment. With COLANDER_E2E_BASE_URL it starts nothing and the specs that need the local
// stack (dev mail, the seeded data, the server log) skip themselves.
import { expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
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

/** The store listings the local website is built with: every store, as production once Firefox ships. */
export const STORES = {
	PUBLIC_STORE_CHROME: 'https://chromewebstore.google.com/detail/colander-e2e',
	PUBLIC_STORE_EDGE: 'https://microsoftedge.microsoft.com/addons/detail/colander-e2e',
	PUBLIC_STORE_FIREFOX: 'https://addons.mozilla.org/firefox/addon/colander-e2e/'
};

export const STAFF = 'rae@colander.test';
export const CURATOR = 'sam@colander.test';
/** A member whose yearly Plus the seed stores as the Stripe webhook would. */
export const PLUS_MEMBER = 'pat@colander.test';

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

/** Waits for the sign-in link mailed to `email` after `mark` and returns it. */
export async function signInLink(email: string, mark: number): Promise<string> {
	let link = '';
	await expect
		.poll(() => {
			const mail = mailsSince(mark).find((m) => m.to === email && m.subject === 'Your Colander sign-in link');
			link = /^https?:\/\/\S+\/auth\/callback\?\S+$/m.exec(mail?.body ?? '')?.[0] ?? '';
			return link;
		}, { message: `sign-in link for ${email} in the server log` })
		.not.toBe('');
	return link;
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

/** One API call from Node. Non-GET calls carry the CSRF header that cookie routes require. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; cookie?: string; auth?: string } = {}): Promise<Reply<T>> {
	const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	if (method !== 'GET') headers['X-Colander-CSRF'] = '1';
	if (init.cookie) headers.Cookie = init.cookie;
	if (init.auth) headers.Authorization = init.auth;
	const res = await http(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
	const text = await res.text();
	return { status: res.status, json: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

/** Signs in through the emailed link and returns the session cookie. */
export async function apiSignIn(email: string): Promise<string> {
	const mark = logMark();
	expect((await api('/v1/auth/email', { body: { email, next: '/console' } })).status).toBe(202);
	const token = new URL(await signInLink(email, mark)).searchParams.get('token');
	const res = await fetch(`${origin()}/v1/auth/verify`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Colander-CSRF': '1' },
		body: JSON.stringify({ token })
	});
	expect(res.status).toBe(200);
	return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Review API calls as staff, with the session global setup opened. */
export const asStaff = <T = any>(path: string, init: { method?: string; body?: unknown } = {}) =>
	api<T>(path, { ...init, cookie: process.env.COLANDER_E2E_STAFF_COOKIE });

export const listSequence = async () => (await api<{ list_sequence: number }>('/v1/stats')).json.list_sequence;

/** Waits until the Worker publishes a list sequence after `seq` (at most one publication per 10 seconds). */
export async function publishedAfter(seq: number): Promise<number> {
	await expect.poll(listSequence, { timeout: 20_000, message: 'a new list publication' }).toBeGreaterThan(seq);
	return listSequence();
}
