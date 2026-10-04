// Go's API test harness (server/internal/api/api_test.go) for the Store: one fresh Store per test,
// a clock the Store reads, dev mail captured as Go captured it in a buffer, and requests sent to
// the Store as the edge forwards them (the client address already reduced to a hash).
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { b64url } from '@colander/shared/bytes';
import { IP_HASH_HEADER } from '../src/http';
import type { Store } from '../src/store/store';

let stores = 0;

export class Harness {
	/** Go's harness clock: 2026-10-01 12:00 UTC, in unix milliseconds. */
	clock = Date.UTC(2026, 9, 1, 12);
	/** Dev mail printed since the last reset. */
	mail = '';
	readonly stub: DurableObjectStub<Store>;

	private constructor(name: string) {
		this.stub = env.STORE.getByName(name);
	}

	static async create(): Promise<Harness> {
		const h = new Harness(`api-${++stores}-${crypto.randomUUID()}`);
		await h.run((store) => {
			store.now = () => h.clock;
			store.mailer.out = (text) => void (h.mail += text + '\n');
		});
		return h;
	}

	/** The clock in unix seconds. */
	get s(): number {
		return Math.floor(this.clock / 1000);
	}

	run<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
		return runInDurableObject(this.stub, fn);
	}

	/** Sends a request. headers alternate name, value; a string body is sent as is. */
	async do(method: string, path: string, body?: unknown, ...headers: string[]): Promise<Response> {
		const h = new Headers({ [IP_HASH_HEADER]: 'ip-hash-192.0.2.1' });
		for (let i = 0; i + 1 < headers.length; i += 2) h.set(headers[i]!, headers[i + 1]!);
		const init: RequestInit = { method, headers: h };
		if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
		return this.stub.fetch(new Request(`https://getcolander.com${path}`, init));
	}

	/** Runs the dev-mode magic link flow for email and returns the session cookie header. */
	async signIn(email: string): Promise<string> {
		this.mail = '';
		await expectStatus(await this.do('POST', '/v1/auth/email', { email, next: '/review' }), 202);
		const token = /token=([A-Za-z0-9_-]+)/.exec(this.mail)?.[1];
		if (!token) throw new Error(`no sign-in link in dev mail output: ${this.mail}`);
		const res = await this.do('POST', '/v1/auth/verify', { token }, 'X-Colander-CSRF', '1');
		await expectStatus(res, 200);
		const cookie = /^(colander_session=[^;]*)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
		if (!cookie) throw new Error('no session cookie');
		return cookie;
	}
}

/** Fails with the body when the status differs, as Go's expect did. */
export async function expectStatus(res: Response, status: number): Promise<void> {
	if (res.status !== status) expect.fail(`status ${res.status}, want ${status}: ${await res.clone().text()}`);
}

export async function errorCode(res: Response): Promise<string> {
	return ((await res.clone().json()) as { error: { code: string } }).error.code;
}

/** A test install ID: 16 bytes with the first set to n, as unpadded base64url (Go's installID). */
export function installId(n: number): string {
	const b = new Uint8Array(16);
	b[0] = n;
	return b64url(b);
}
