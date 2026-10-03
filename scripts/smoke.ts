// Contract-level smoke test for a running Colander origin (docs/contracts.md, docs/deploy.md).
// It needs nothing but Node 24, so CI runs it without installing the workspace.
//
//   COLANDER_BASE_URL=https://getcolander.com COLANDER_PUBLIC_KEYS=<base64,...> node scripts/smoke.ts
//
// Flags:
//   --mutating       staging only: adds a tag round trip with a throwaway install ID and a staff
//                    decision that must reach the edge as a signed delta within 60 seconds
//                    (needs COLANDER_REVIEWER_TOKEN, the reviewer token of a staff account)
//   --expect-cache   requires `cf-cache-status: HIT` on a repeated snapshot and delta request
//   --since <seq>    a sequence clients held before a deploy; its delta must still be served
//   --spa-fallback   the Go server answers unknown pages with the SPA shell (200) instead of 404;
//                    remove this flag with server/
//
// CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, when set, are sent on every request so the
// test passes Cloudflare Access on staging.
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto';
import { parseArgs } from 'node:util';

const env = (name: string): string => {
	const v = process.env[name]?.trim();
	if (!v) throw new Error(`${name} is not set`);
	return v;
};

export const baseURL = (): string => env('COLANDER_BASE_URL').replace(/\/+$/, '');

/** One request to the origin under test, with the Access service token when one is configured. */
export async function http(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const id = process.env.CF_ACCESS_CLIENT_ID;
	const secret = process.env.CF_ACCESS_CLIENT_SECRET;
	if (id && secret) {
		headers.set('CF-Access-Client-Id', id);
		headers.set('CF-Access-Client-Secret', secret);
	}
	return fetch(baseURL() + path, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
}

export async function json(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${res.url} answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`);
	}
}

export function expect(cond: unknown, message: string): asserts cond {
	if (!cond) throw new Error(message);
}

export const header = (res: Response, name: string): string => res.headers.get(name) ?? '';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- The signed list, contracts section 3 ----

export interface Entry {
	hash: string;
	verdict: number;
	flags: number;
}
export interface List {
	kind: number;
	sequence: bigint;
	base: bigint;
	created: number;
	keyId: string;
	entries: Entry[];
}

/** The trusted keys by key ID (first 8 bytes of SHA-256 over the raw public key, hex). */
export function trustedKeys(csv: string): Map<string, KeyObject> {
	const keys = new Map<string, KeyObject>();
	for (const b64 of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
		const raw = Buffer.from(b64, 'base64');
		expect(raw.length === 32, `public key ${b64} is not 32 bytes of base64`);
		const id = createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex');
		keys.set(id, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }));
	}
	expect(keys.size > 0, 'no public keys given');
	return keys;
}

/** Parses a list file and checks everything a client checks: magic, version, length, order, key and signature. */
export function parseList(buf: Buffer, keys: Map<string, KeyObject>): List {
	expect(buf.length >= 104, `list file is ${buf.length} bytes, shorter than header and trailer`);
	expect(buf.subarray(0, 4).toString('latin1') === 'CLDL', 'list magic is not CLDL');
	expect(buf[4] === 1, `list version is ${buf[4]}, not 1`);
	const kind = buf[5]!;
	expect(kind === 0 || kind === 1, `list kind is ${kind}`);
	const count = buf.readUInt32LE(28);
	expect(buf.length === 32 + 16 * count + 72, `list length ${buf.length} does not match ${count} entries`);
	const entries: Entry[] = [];
	for (let i = 0; i < count; i++) {
		const e = buf.subarray(32 + 16 * i, 48 + 16 * i);
		if (i > 0) expect(Buffer.compare(buf.subarray(16 + 16 * i, 24 + 16 * i), e.subarray(0, 8)) < 0, `entry ${i} is out of order`);
		entries.push({ hash: e.subarray(0, 8).toString('hex'), verdict: e[8]!, flags: e[9]! });
	}
	const trailer = buf.length - 72;
	const keyId = buf.subarray(trailer, trailer + 8).toString('hex');
	const key = keys.get(keyId);
	expect(key, `list is signed by key ${keyId}, which is not one of the trusted keys (${[...keys.keys()].join(', ')})`);
	expect(verify(null, buf.subarray(0, trailer), key, buf.subarray(trailer + 8)), 'list signature does not verify');
	return { kind, sequence: buf.readBigUInt64LE(8), base: buf.readBigUInt64LE(16), created: buf.readUInt32LE(24), keyId, entries };
}

/** The list hash of a target key, contracts section 2.3. */
export const targetHash = (key: string) => createHash('sha256').update(key, 'utf8').digest().subarray(0, 8).toString('hex');

export async function fetchSnapshot(keys: Map<string, KeyObject>): Promise<{ res: Response; list: List }> {
	const res = await http('/v1/list/snapshot');
	expect(res.status === 200, `snapshot answered ${res.status}`);
	const list = parseList(Buffer.from(await res.arrayBuffer()), keys);
	expect(list.kind === 0 && list.base === 0n, 'snapshot header is not a snapshot (kind 0, base 0)');
	expect(header(res, 'x-colander-sequence') === String(list.sequence),
		`X-Colander-Sequence ${header(res, 'x-colander-sequence')} differs from the file's sequence ${list.sequence}`);
	return { res, list };
}

/** A delta from `since`; returns the parsed list for 200, null for 204, and throws for anything else. */
export async function fetchDelta(since: bigint, keys: Map<string, KeyObject>): Promise<List | null> {
	const res = await http(`/v1/list/delta?since=${since}`);
	if (res.status === 204) return null;
	expect(res.status === 200, `delta since ${since} answered ${res.status}`);
	const list = parseList(Buffer.from(await res.arrayBuffer()), keys);
	expect(list.kind === 1 && list.base === since, `delta since ${since} has kind ${list.kind} and base ${list.base}`);
	expect(list.sequence > since, `delta since ${since} brings the client to ${list.sequence}`);
	return list;
}

// ---- The checks ----

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`ok    ${name}`);
	} catch (err) {
		failures.push(name);
		console.log(`FAIL  ${name}: ${(err as Error).message}`);
	}
}

const isHTML = (res: Response) => header(res, 'content-type').startsWith('text/html');
const cacheControl = (res: Response) => header(res, 'cache-control').split(',').map((s) => s.trim());

async function expectCacheHit(path: string): Promise<void> {
	const seen: string[] = [];
	for (let i = 0; i < 3; i++) {
		const res = await http(path);
		await res.arrayBuffer();
		seen.push(header(res, 'cf-cache-status') || '(none)');
		if (seen.at(-1) === 'HIT') return;
		await sleep(1000);
	}
	throw new Error(`no cf-cache-status HIT on repeat; saw ${seen.join(', ')}`);
}

async function main(): Promise<void> {
	const { values: opts } = parseArgs({
		options: {
			mutating: { type: 'boolean', default: false },
			'expect-cache': { type: 'boolean', default: false },
			since: { type: 'string' },
			'spa-fallback': { type: 'boolean', default: false }
		}
	});
	const keys = trustedKeys(env('COLANDER_PUBLIC_KEYS'));
	const reviewerToken = opts.mutating ? env('COLANDER_REVIEWER_TOKEN') : '';
	const nonce = randomBytes(6).toString('hex');
	console.log(`Smoke test of ${baseURL()} (${opts.mutating ? 'mutating' : 'read-only'})`);

	for (const path of ['/', '/privacy', '/s/yt/UCX6OQ3DkcsbYNE6H8uQQuVA', '/appeal/yt/UCX6OQ3DkcsbYNE6H8uQQuVA']) {
		await check(`page ${path}`, async () => {
			const res = await http(path);
			const body = await res.text();
			expect(res.status === 200 && isHTML(res), `answered ${res.status} ${header(res, 'content-type')}`);
			expect(/<html/i.test(body), 'body is not an HTML document');
			expect(header(res, 'x-content-type-options') === 'nosniff', 'X-Content-Type-Options is not nosniff');
			expect(header(res, 'content-security-policy').includes("frame-ancestors 'none'"), "CSP lacks frame-ancestors 'none'");
		});
	}
	await check('unknown page', async () => {
		const res = await http(`/smoke-missing-${nonce}`);
		await res.text();
		const want = opts['spa-fallback'] ? 200 : 404;
		expect(res.status === want && isHTML(res), `answered ${res.status} ${header(res, 'content-type')}, want ${want} HTML`);
	});
	await check('unknown API route', async () => {
		const res = await http(`/v1/smoke-missing-${nonce}`);
		const body = await json(res);
		expect(res.status === 404 && typeof body?.error?.code === 'string', `answered ${res.status} ${JSON.stringify(body)}`);
	});
	await check('/healthz', async () => {
		const res = await http('/healthz');
		const body = await json(res);
		expect(res.status === 200 && body?.ok === true, `answered ${res.status} ${JSON.stringify(body)}`);
		expect(cacheControl(res).includes('no-store'), `Cache-Control is "${header(res, 'cache-control')}", not no-store`);
	});

	await check('CORS preflight on /v1/tags', async () => {
		const res = await http('/v1/tags', {
			method: 'OPTIONS',
			headers: {
				Origin: 'chrome-extension://nninnogmbhfebflkcgghlmjmplmpodlc',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'authorization,content-type'
			}
		});
		await res.arrayBuffer();
		expect(res.status === 204 || res.status === 200, `answered ${res.status}`);
		expect(header(res, 'access-control-allow-origin') === '*', 'Access-Control-Allow-Origin is not *');
		expect(/\bPOST\b/i.test(header(res, 'access-control-allow-methods')), 'POST is not an allowed method');
		expect(/\bauthorization\b/i.test(header(res, 'access-control-allow-headers')), 'Authorization is not an allowed header');
	});
	await check('cookie routes are same-origin only', async () => {
		const res = await http('/v1/account', { headers: { Origin: 'https://example.com' } });
		await res.arrayBuffer();
		expect(res.status === 401, `GET /v1/account without a session answered ${res.status}`);
		expect(!res.headers.has('access-control-allow-origin'), 'GET /v1/account allows a cross-origin read');
	});

	let head: bigint | undefined;
	await check('snapshot is signed by a trusted key', async () => {
		const { res, list } = await fetchSnapshot(keys);
		head = list.sequence;
		const cc = cacheControl(res);
		expect(cc.includes('public') && cc.includes('max-age=60'), `Cache-Control is "${header(res, 'cache-control')}"`);
		expect(header(res, 'access-control-allow-origin') === '*', 'snapshot lacks Access-Control-Allow-Origin: *');
		expect(/x-colander-sequence/i.test(header(res, 'access-control-expose-headers')), 'X-Colander-Sequence is not exposed to the extension');
		console.log(`      sequence ${list.sequence}, ${list.entries.length} entries, key ${list.keyId}`);
	});
	const atHead = (): bigint => {
		expect(head !== undefined, 'no verified snapshot to start from');
		return head;
	};

	await check('delta at head is 204', async () => {
		const res = await http(`/v1/list/delta?since=${atHead()}`);
		if (res.status === 200) {
			// The list moved on between the two requests: the delta must still be valid.
			const list = parseList(Buffer.from(await res.arrayBuffer()), keys);
			expect(list.kind === 1 && list.base === atHead(), `delta base ${list.base} is not ${atHead()}`);
			return;
		}
		await res.arrayBuffer();
		expect(res.status === 204, `answered ${res.status}`);
		const cc = cacheControl(res);
		expect(cc.includes('public') && cc.includes('max-age=60'), `Cache-Control is "${header(res, 'cache-control')}"`);
	});
	await check('delta from an unknown sequence is 410', async () => {
		const res = await http(`/v1/list/delta?since=${atHead() + 1n}`);
		const body = await json(res);
		expect(res.status === 410 && typeof body?.error?.code === 'string', `answered ${res.status} ${JSON.stringify(body)}`);
	});
	await check('delta with a malformed since is 400', async () => {
		const res = await http('/v1/list/delta?since=abc');
		await res.arrayBuffer();
		expect(res.status === 400, `answered ${res.status}`);
	});
	if (opts.since !== undefined) {
		await check(`delta from the earlier sequence ${opts.since}`, async () => {
			const since = BigInt(opts.since!);
			const delta = await fetchDelta(since, keys);
			if (since === atHead()) expect(delta === null, 'the head answered 200 instead of 204');
			else expect(delta !== null, `answered 204 although the head is ${atHead()}`);
		});
	}
	if (opts['expect-cache']) {
		await check('snapshot is served from the edge cache', () => expectCacheHit('/v1/list/snapshot'));
		await check('delta at head is served from the edge cache', () => expectCacheHit(`/v1/list/delta?since=${atHead()}`));
	}

	if (opts.mutating) {
		const install = randomBytes(16).toString('base64url');
		await check('tag round trip with a throwaway install', async () => {
			const tag = {
				client_id: randomUUID(), platform: 'yt', target_type: 'source', target_id: '@colander-smoke', verdict: 'not_slop',
				platform_label: false, created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ext_version: 'smoke'
			};
			for (const attempt of ['first', 'repeated']) {
				const res = await http('/v1/tags', {
					method: 'POST',
					headers: { Authorization: `Install ${install}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ tags: [tag] })
				});
				const body = await json(res);
				expect(res.status === 200, `${attempt} POST answered ${res.status} ${JSON.stringify(body)}`);
				expect(JSON.stringify(body.accepted) === JSON.stringify([tag.client_id]) && body.rejected?.length === 0,
					`${attempt} POST answered ${JSON.stringify(body)}`);
				expect(header(res, 'access-control-allow-origin') === '*', 'tags answer lacks Access-Control-Allow-Origin: *');
			}
			const res = await http('/v1/reports', { headers: { Authorization: `Install ${install}` } });
			const body = await json(res);
			expect(res.status === 200 && Array.isArray(body.reports) && body.reports.length === 0,
				`GET /v1/reports for the new install answered ${res.status} ${JSON.stringify(body)}`);
		});
		await check('a staff decision reaches the edge as a signed delta within 60 s', async () => {
			const before = atHead();
			const auth = { Authorization: `Bearer ${reviewerToken}`, 'Content-Type': 'application/json' };
			const path = '/v1/review/sources/yt/@colander-smoke';
			const current = await http(path, { headers: auth });
			const state = await json(current);
			expect(current.status === 200 || current.status === 404, `GET ${path} answered ${current.status} ${JSON.stringify(state)}`);
			// Toggle between Clear and not rated, so every run changes the list.
			const verdict = state?.source?.verdict === 'clear' ? 'none' : 'clear';
			const started = Date.now();
			const res = await http(`${path}/decision`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ verdict, reason: `Smoke test ${nonce}: set to ${verdict}.`, signals: [], tests: [] })
			});
			const decided = await json(res);
			expect(res.status === 200, `decision answered ${res.status} ${JSON.stringify(decided)}`);
			const hash = targetHash('yt:s:@colander-smoke');
			const want = verdict === 'clear' ? 5 : 0;
			for (;;) {
				const delta = await fetchDelta(before, keys);
				if (delta?.entries.some((e) => e.hash === hash && e.verdict === want)) break;
				const waited = (Date.now() - started) / 1000;
				expect(waited < 60, `the decision was not in a delta from ${before} after ${waited.toFixed(0)} s`);
				await sleep(2000);
			}
			console.log(`      ${verdict} reached the edge after ${((Date.now() - started) / 1000).toFixed(1)} s`);
		});
	}

	if (failures.length) {
		console.log(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
		process.exit(1);
	}
	console.log('\nAll checks passed.');
}

if (import.meta.main) await main();
