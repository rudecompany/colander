// The edge Worker through its fetch handler: list endpoints and their cache headers, CORS,
// `since` checks, the miss limiter, the ops guard, dev routes and what reaches the Store and logs.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { b64decode, hex } from '@colander/shared/bytes';
import { encodeEntry, ENTRY, HEADER, verifyList } from '@colander/shared/list';
import { importKeys } from '@colander/shared/signing';
import { ipKey } from '../src/http';
import worker from '../src/index';
import { Store } from '../src/store/store';
import { githubToken, opsAuth } from './tokens';

const files = inject('contract');
const snapshotBytes = b64decode(files.snapshot);
const deltaBytes = b64decode(files.delta);
const ORIGIN = 'https://getcolander.com';
const now = () => Math.floor(Date.now() / 1000);

// Each request comes from its own address unless a test sets one, so only the limiter test
// ever meets the miss limiter.
let client = 0;
function withClient(init?: RequestInit): RequestInit {
	const headers = new Headers(init?.headers);
	if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `198.18.${(++client >> 8) & 255}.${client & 255}`);
	return { ...init, headers };
}
const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(ORIGIN + path, withClient(init)));
/** Calls the handler directly, for an env that differs from the configured one. */
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const getWith = (overrides: Partial<Env>, path: string, init?: RequestInit<IncomingRequestCfProperties>) =>
	worker.fetch(new IncomingRequest(ORIGIN + path, withClient(init) as RequestInit<IncomingRequestCfProperties>), { ...env, ...overrides }, createExecutionContext());
const primary = () => env.STORE.getByName('primary');

const LIST_CLIENT = 'public, max-age=60';
const LIST_EDGE = 'public, max-age=15, stale-if-error=86400';

afterEach(() => vi.restoreAllMocks());

describe('GET /v1/list/snapshot', () => {
	beforeEach(() => env.LISTS.delete('list/snapshot.bin'));

	it('serves the R2 snapshot with its sequence and list cache headers, without the Store', async () => {
		await env.LISTS.put('list/snapshot.bin', snapshotBytes, { customMetadata: { seq: '42', created: '1790000000' } });
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await get('/v1/list/snapshot');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(res.headers.get('X-Colander-Sequence')).toBe('42');
		expect(res.headers.get('Cache-Control')).toBe(LIST_CLIENT);
		expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe(LIST_EDGE);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(res.headers.get('Access-Control-Expose-Headers')).toBe('X-Colander-Sequence, Retry-After');
		expect(hex(new Uint8Array(await res.arrayBuffer()))).toBe(hex(snapshotBytes));
		expect(store).not.toHaveBeenCalled();
	});

	it('answers HEAD with the same headers and no body', async () => {
		await env.LISTS.put('list/snapshot.bin', snapshotBytes, { customMetadata: { seq: '42' } });
		const res = await get('/v1/list/snapshot', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Colander-Sequence')).toBe('42');
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it('is a 503 that nothing caches before the first publication, from R2 or the Store', async () => {
		for (const seed of [null, {}]) {
			if (seed) await env.LISTS.put('list/snapshot.bin', snapshotBytes, { customMetadata: seed });
			const res = await get('/v1/list/snapshot');
			expect(res.status).toBe(503);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
			expect(res.headers.get('Retry-After')).toBe('30');
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_unavailable');
		}
	});

	it('falls back to the Store when R2 cannot be read', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const down = { get: () => Promise.reject(new Error('R2 is unavailable')) } as unknown as R2Bucket;
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await getWith({ LISTS: down }, '/v1/list/snapshot');
		expect(store).toHaveBeenCalledOnce();
		// This Store has published nothing yet; with a head it serves it (the next test).
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('list_unavailable');
		expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual({ message: 'reading the snapshot from R2 failed', error: 'Error: R2 is unavailable' });
	});

	it('falls back to the Store when R2 has no valid snapshot', async () => {
		const seq = now();
		await runInDurableObject(primary(), async (store: Store) => {
			store.db.run("INSERT INTO sources (id, platform, canonical_id, verdict, created_at) VALUES (1, 'yt', '@a', 'slop', 1)");
			store.db.run("INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', '@a', 1)");
			store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', seq - 1, seq - 1);
			await store.publisher.publish(seq * 1000);
			await env.LISTS.delete('list/snapshot.bin');
		});
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await get('/v1/list/snapshot');
		expect(res.status).toBe(200);
		expect(store).toHaveBeenCalledOnce();
		expect(res.headers.get('X-Colander-Sequence')).toBe(String(seq));
		expect(res.headers.get('Cache-Control')).toBe(LIST_CLIENT);
		expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe(LIST_EDGE);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const list = await verifyList(new Uint8Array(await res.arrayBuffer()), await importKeys([files.devPublicKey]));
		expect([list.kind, list.sequence, list.count]).toEqual(['snapshot', seq, 1]);
		await runInDurableObject(primary(), (s: Store) => s.db.run('DELETE FROM list_entries; DELETE FROM list_sequences; DELETE FROM source_aliases; DELETE FROM sources'));
	});
});

describe('GET /v1/list/delta', () => {
	// The fixture delta brings sequence 42 to 43; its three entries are the changes of sequence 43.
	const fixtureRows = Array.from({ length: (deltaBytes.length - HEADER - 72) / ENTRY }, (_, i) =>
		deltaBytes.slice(HEADER + i * ENTRY, HEADER + (i + 1) * ENTRY)
	);

	async function seed(sequences: [number, number][], changes: [number, Uint8Array][]) {
		await runInDurableObject(primary(), (store: Store) => {
			store.db.run('DELETE FROM list_changes; DELETE FROM list_sequences');
			for (const [seq, created] of sequences) store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', seq, created);
			for (const [seq, entry] of changes) store.db.run('INSERT INTO list_changes (seq, hash, entry) VALUES (?, ?, ?)', seq, entry.slice(0, 8).buffer, entry.slice().buffer);
		});
	}

	it('serves the signed delta from the Store, byte for byte the contract fixture', async () => {
		await seed([[42, now() - 3600], [43, 1790003600]], fixtureRows.map((r) => [43, r]));
		const res = await get('/v1/list/delta?since=42');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(res.headers.get('X-Colander-Sequence')).toBe('43');
		expect(res.headers.get('Cache-Control')).toBe(LIST_CLIENT);
		expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe(LIST_EDGE);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(hex(new Uint8Array(await res.arrayBuffer()))).toBe(hex(deltaBytes));
	});

	it('coalesces several sequences into the final state of each hash', async () => {
		const first = fixtureRows[0]!;
		const later = encodeEntry({ hash: first.slice(0, 8), verdict: 4, flags: first[9]!, signals: 0, detail: 0, updated: 2466 });
		await seed([[42, now() - 3600], [43, now() - 60], [44, now()]], [...fixtureRows.map((r): [number, Uint8Array] => [43, r]), [44, later]]);
		const res = await get('/v1/list/delta?since=42');
		const delta = await verifyList(new Uint8Array(await res.arrayBuffer()), await importKeys([files.devPublicKey]));
		expect([delta.kind, delta.base, delta.sequence, delta.count]).toEqual(['delta', 42, 44, 3]);
		const rows = Array.from({ length: delta.count }, (_, i) => hex(delta.entries.subarray(i * ENTRY, (i + 1) * ENTRY)));
		expect(rows).toContain(hex(later));
		expect(rows).not.toContain(hex(first));
	});

	it('is 204 with list cache headers at the latest sequence', async () => {
		await seed([[42, now() - 3600], [43, now()]], []);
		const res = await get('/v1/list/delta?since=43');
		expect(res.status).toBe(204);
		expect(res.headers.get('X-Colander-Sequence')).toBe('43');
		expect(res.headers.get('Cache-Control')).toBe(LIST_CLIENT);
		expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe(LIST_EDGE);
	});

	it('is 410, cached briefly at the edge only, for an unknown, newer, zero or expired base', async () => {
		await seed([[42, now() - 31 * 86400], [43, now() - 3600], [45, now()]], []);
		for (const since of [42, 44, 46, 0]) {
			const res = await get(`/v1/list/delta?since=${since}`);
			expect(res.status, `since=${since}`).toBe(410);
			expect(res.headers.get('X-Colander-Sequence')).toBe('45');
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=15');
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('sequence_unknown');
		}
		expect((await get('/v1/list/delta?since=43')).status).toBe(200);
	});

	it('is 410 before anything was published', async () => {
		await seed([], []);
		const res = await get('/v1/list/delta?since=42');
		expect(res.status).toBe(410);
		expect(res.headers.get('X-Colander-Sequence')).toBe('0');
	});

	it('rejects any query that is not exactly a canonical since at the edge', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		const tooLate = now() + 120;
		for (const q of ['', '?since=', '?since=abc', '?since=-1', '?since=042', '?since=1.5', '?since=1&x=2', '?x=2&since=1', '?since=1234567890123456', `?since=${tooLate}`]) {
			const res = await get(`/v1/list/delta${q}`);
			expect(res.status, q).toBe(400);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('Cloudflare-CDN-Cache-Control')).toBeNull();
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_since');
		}
		expect(store).not.toHaveBeenCalled();
	});

	it('turns a Store failure into a 500 that names no data', async () => {
		await seed([[42, now() - 3600], [43, now()]], [[43, fixtureRows[0]!.slice(0, 15)]]);
		const errors = vi.spyOn(console, 'error');
		const res = await get('/v1/list/delta?since=42');
		expect(res.status).toBe(500);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal');
		expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])).route)).toContain('GET /v1/list/delta');
	});
});

describe('CORS', () => {
	it('answers preflights on extension routes without the Store', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		for (const path of ['/v1/list/delta', '/v1/tags', '/v1/tags/x', '/v1/review/queue', '/v1/sources/yt/@x', '/v1/sync', '/v1/entitlement/refresh']) {
			const res = await get(path, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST' } });
			expect(res.status, path).toBe(204);
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
			expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
			expect(res.headers.get('Access-Control-Max-Age')).toBe('7200');
			expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
		}
		expect(store).not.toHaveBeenCalled();
	});

	it('keeps cookie routes same-origin', async () => {
		for (const path of ['/v1/account', '/v1/auth/email', '/v1/tagsx', '/v1/entitlement', '/v1/billing/checkout']) {
			const pre = await get(path, { method: 'OPTIONS' });
			expect(pre.status, path).toBe(404);
			expect(pre.headers.get('Access-Control-Allow-Origin')).toBeNull();
			expect((await get(path)).headers.get('Access-Control-Allow-Origin')).toBeNull();
		}
	});

	it('adds CORS headers to every response on extension routes, errors included', async () => {
		const res = await get('/v1/sources/yt/@nobody');
		expect(res.status).toBe(404);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(res.headers.get('Access-Control-Expose-Headers')).toBe('X-Colander-Sequence, Retry-After');
	});
});

describe('forwarding to the Store', () => {
	it('replaces the client address with the salted hash and drops a forged hash', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		await get('/v1/reports', {
			headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7', 'X-Colander-Ip-Hash': 'forged', Authorization: 'Install abc' }
		});
		const seen = store.mock.calls[0]![0] as Request;
		const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-ip-salt'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const want = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('203.0.113.7'))));
		expect(seen.headers.get('x-colander-ip-hash')).toBe(want);
		expect(seen.headers.get('cf-connecting-ip')).toBeNull();
		expect(seen.headers.get('x-forwarded-for')).toBeNull();
		expect(seen.headers.get('authorization')).toBe('Install abc');
	});

	it('hashes an IPv6 client by its /64 and an IPv4-mapped one as its IPv4 address', async () => {
		expect(
			['203.0.113.7', '2001:db8:1:2::1', '2001:0DB8:0001:0002:ffff:0:0:9', '2001:db8:1:3::1', '::1', '::ffff:203.0.113.7', '::ffff:cb00:7107', '2001:db8::1.2.3.4', 'fe80::1%eth0', 'junk'].map((ip) => ipKey(ip))
		).toEqual(['203.0.113.7', '2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', '0:0:0:0::/64', '203.0.113.7', '203.0.113.7', '2001:db8:0:0::/64', 'fe80::1%eth0', 'junk']);
		const store = vi.spyOn(Store.prototype, 'fetch');
		for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:3::1', '::ffff:203.0.113.7', '203.0.113.7']) {
			await get('/v1/reports', { headers: { 'CF-Connecting-IP': ip, Authorization: 'Install abc' } });
		}
		const hashes = store.mock.calls.map((c) => (c[0] as Request).headers.get('x-colander-ip-hash'));
		expect(hashes[0]).toBe(hashes[1]);
		expect(hashes[2]).not.toBe(hashes[0]);
		expect(hashes[3]).toBe(hashes[4]);
	});

	// A free tunnel hands out a whole /48: 65,536 /64s would each get their own guesses.
	it('hashes a pairing claim from IPv6 by its /48', async () => {
		expect(['2001:db8:1:2::1', '2001:db8:1:ffff::9', '203.0.113.7', '::ffff:203.0.113.7'].map((ip) => ipKey(ip, 48))).toEqual([
			'2001:db8:1::/48',
			'2001:db8:1::/48',
			'203.0.113.7',
			'203.0.113.7'
		]);
		const store = vi.spyOn(Store.prototype, 'fetch');
		const claim = (ip: string) =>
			get('/v1/pair/claim', { method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA', ext_version: '1.0.0', browser: 'chrome' }) });
		for (const ip of ['2001:db8:1:2::1', '2001:db8:1:3::1', '2001:db8:2:2::1']) await claim(ip);
		await get('/v1/reports', { headers: { 'CF-Connecting-IP': '2001:db8:1:2::1', Authorization: 'Install abc' } });
		const hashes = store.mock.calls.map((c) => (c[0] as Request).headers.get('x-colander-ip-hash'));
		expect(hashes[0]).toBe(hashes[1]);
		expect(hashes[2]).not.toBe(hashes[0]);
		// Every other route still counts the /64.
		expect(hashes[3]).not.toBe(hashes[0]);
	});

	it('logs the route pattern, status and duration only', async () => {
		const logs = vi.spyOn(console, 'log');
		await get('/v1/sources/yt/@private-channel-name?ref=secret', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
		await get('/v1/list/delta?since=1700000123');
		const lines = logs.mock.calls.map((c) => String(c[0]));
		expect(lines.map((l) => Object.keys(JSON.parse(l)).sort())).toEqual([
			['host', 'ms', 'route', 'status'],
			['host', 'ms', 'route', 'status']
		]);
		expect(lines.map((l) => JSON.parse(l).host)).toEqual(['main', 'main']);
		expect(lines.map((l) => JSON.parse(l).route)).toEqual(['GET /v1/sources/:platform/:source_id', 'GET /v1/list/delta']);
		for (const secret of ['private-channel-name', 'secret', '198.51.100.9', '1700000123']) expect(lines.join('\n')).not.toContain(secret);
	});

	it('sets security headers and no-store on what the Worker generates', async () => {
		const res = await get('/v1/account');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('X-Frame-Options')).toBe('DENY');
		expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
		expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
		expect(res.headers.get('x-colander-route')).toBeNull();
	});
});

describe('GET /healthz', () => {
	it('reaches the Store and answers ok', async () => {
		const res = await get('/healthz');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('miss limiter', () => {
	const prod = { COLANDER_DEV: '' };

	it('answers 429 with Retry-After once one address exceeds 120 a minute', async () => {
		const headers = { 'CF-Connecting-IP': '192.0.2.44' };
		const statuses: number[] = [];
		for (let i = 0; i < 125; i++) statuses.push((await getWith(prod, '/v1/list/delta?since=x', { headers })).status);
		expect(statuses.filter((s) => s === 400)).toHaveLength(120);
		const res = await getWith(prod, '/v1/list/delta?since=x', { headers });
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		// Other addresses are unaffected.
		expect((await getWith(prod, '/v1/list/delta?since=x', { headers: { 'CF-Connecting-IP': '192.0.2.45' } })).status).toBe(400);
	});

	it('counts every address of an IPv6 /64 as one', async () => {
		const statuses: number[] = [];
		for (let i = 1; i <= 121; i++) statuses.push((await getWith(prod, '/v1/list/delta?since=x', { headers: { 'CF-Connecting-IP': `2001:db8:44:1::${i.toString(16)}` } })).status);
		expect(statuses.slice(0, 120).every((s) => s === 400)).toBe(true);
		expect(statuses[120]).toBe(429);
		expect((await getWith(prod, '/v1/list/delta?since=x', { headers: { 'CF-Connecting-IP': '2001:db8:44:2::1' } })).status).toBe(400);
	});

	it('stays out of dev mode, where every request is a miss', async () => {
		const headers = { 'CF-Connecting-IP': '192.0.2.46' };
		const statuses = new Set<number>();
		for (let i = 0; i < 125; i++) statuses.add((await get('/v1/list/delta?since=x', { headers })).status);
		expect([...statuses]).toEqual([400]);
	});
});

describe('list request counts', () => {
	const counted = () => runInDurableObject(primary(), (s: Store) => s.db.get<{ n: number }>('SELECT ifnull(sum(count), 0) AS n FROM list_requests')!.n);

	it('come from edge analytics in production, so the edge counts nothing', async () => {
		const before = await counted();
		await getWith({ COLANDER_DEV: '' }, '/v1/list/delta?since=x');
		expect(await counted()).toBe(before);
	});

	it('are counted at the edge in dev mode, every snapshot and delta request as Go did', async () => {
		const before = await counted();
		await get('/v1/list/snapshot', { method: 'HEAD' });
		await get('/v1/list/delta?since=x');
		await get('/v1/list/delta?since=1');
		await get('/v1/stats');
		expect(await counted()).toBe(before + 3);
	});
});

describe('/ops/*', () => {
	const status = (headers: Record<string, string>, overrides: Record<string, string> = {}) =>
		getWith(overrides as Partial<Env>, '/ops/status', { method: 'POST', headers, body: '{}' });

	it('takes a GitHub Actions OIDC token from a workflow of this repository on main, in this environment', async () => {
		const none = await get('/ops/status');
		expect(none.status).toBe(401);
		expect(none.headers.get('WWW-Authenticate')).toBe('Bearer');
		expect((await get('/ops/status', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
		const ok = await status(await opsAuth());
		expect(ok.status).toBe(200);
		expect(await ok.json()).toHaveProperty('head_seq');
	});

	it('refuses every other token: another repository, branch, workflow ref, environment, audience, issuer, key or an expired one', async () => {
		const refused: Record<string, unknown>[] = [
			{ repository: 'someone/colander' },
			{ repository_id: '1' },
			{ ref: 'refs/heads/feature' },
			{ ref: 'refs/pull/7/merge' },
			{ workflow_ref: 'rudecompany/colander/.github/workflows/ops.yml@refs/heads/feature' },
			{ workflow_ref: 'someone/else/.github/workflows/ops.yml@refs/heads/main' },
			{ environment: 'staging' },
			{ environment: undefined },
			{ aud: 'https://staging.getcolander.com' },
			{ iss: 'https://token.actions.example.com' },
			{ exp: now() - 1 }
		];
		for (const claims of refused) expect((await status(await opsAuth(claims))).status, JSON.stringify(claims)).toBe(401);
		// A key the JWKS does not hold.
		expect((await status({ Authorization: 'Bearer ' + (await githubToken({}, 'unknown-kid')) })).status).toBe(401);
		// The dev bearer is not taken outside dev mode on localhost.
		expect((await status({ Authorization: 'Bearer dev-ops-token' }, { OPS_TOKEN: 'dev-ops-token' })).status).toBe(401);
		expect((await status({ Authorization: 'Bearer dev-ops-token' }, { OPS_TOKEN: 'dev-ops-token', COLANDER_DEV: '', PUBLIC_URL: 'http://localhost:8787' })).status).toBe(401);
	});

	it('lets each workflow run only the commands its jobs need, so a token minted next to npm code cannot change roles or sign', async () => {
		const as = async (workflow: string, command: string, environment = 'production') => {
			const staging = environment === 'staging';
			const headers = await opsAuth({
				workflow_ref: `rudecompany/colander/.github/workflows/${workflow}@refs/heads/main`,
				environment,
				...(staging ? { aud: 'https://staging.getcolander.com' } : {})
			});
			const overrides = staging ? { OPS_GITHUB_ENVIRONMENT: 'staging', PUBLIC_URL: 'https://staging.getcolander.com' } : {};
			const res = await getWith(overrides, `/ops/${command}`, { method: 'POST', headers, body: '{}' });
			return [res.status, ((await res.json()) as { error?: { code: string } }).error?.code ?? 'ok'];
		};
		const refused = [403, 'not_this_workflow'];
		expect(await as('probes.yml', 'status')).toEqual([200, 'ok']);
		expect(await as('probes.yml', 'grant-role')).toEqual(refused);
		// deploy-staging installs and builds npm code: its token decides the check channel and nothing else.
		for (const command of ['status', 'grant-role', 'pin-subject', 'sign-config', 'import-seed', 'restore-dump', 'pitr-restore', 'purge-cache']) {
			expect(await as('deploy-staging.yml', command, 'staging'), command).toEqual(refused);
		}
		// Past the workflow check: the Store here runs with production's settings, which refuse check-decision.
		expect(await as('deploy-staging.yml', 'check-decision', 'staging')).toEqual([403, 'not_here']);
		// The drills: the dump drill on production, the point-in-time drill on staging.
		expect(await as('drills.yml', 'status')).toEqual(refused);
		expect(await as('drills.yml', 'pitr-restore')).toEqual(refused);
		expect(await as('drills.yml', 'status', 'staging')).toEqual([200, 'ok']);
		expect(await as('drills.yml', 'pitr-restore', 'staging')).toEqual([400, 'confirmation_required']);
		expect(await as('drills.yml', 'grant-role', 'staging')).toEqual(refused);
		// Any other workflow of the repository runs nothing; the Ops workflow runs everything.
		expect(await as('release.yml', 'status')).toEqual(refused);
		expect(await as('ci.yml', 'status')).toEqual(refused);
		expect(await as('ops.yml', 'grant-role')).toEqual([400, 'invalid_email']);
	});

	it('is closed when no repository or environment is configured', async () => {
		expect((await status(await opsAuth(), { OPS_GITHUB_ENVIRONMENT: '' })).status).toBe(503);
		expect((await status(await opsAuth(), { OPS_GITHUB_REPOSITORY: '' })).status).toBe(503);
	});

	it('takes the dev bearer of api/.dev.vars only in dev mode on localhost', async () => {
		const dev = { OPS_TOKEN: 'dev-ops-token', PUBLIC_URL: 'http://localhost:8787' };
		expect((await status({ Authorization: 'Bearer dev-ops-token' }, dev)).status).toBe(200);
		expect((await status({ Authorization: 'Bearer wrong' }, dev)).status).toBe(401);
	});
});

describe('/__dev/*', () => {
	it('reaches the Store router in dev mode', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await get('/__dev/dump');
		expect(store).toHaveBeenCalledOnce();
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/sql; charset=utf-8');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const notThere = await get('/__dev/nothing');
		expect(notThere.status).toBe(404);
		expect(notThere.headers.get('Content-Type')).toBe('application/json');
	});

	it('does not exist otherwise: the site answers as for any unknown path', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await getWith({ COLANDER_DEV: '' }, '/__dev/seed');
		expect(res.status).toBe(404);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		const post = await getWith({ COLANDER_DEV: '' }, '/__dev/seed', { method: 'POST' });
		expect(post.status).toBe((await env.ASSETS.fetch(`${ORIGIN}/no-such-page`, { method: 'POST' })).status);
		expect(store).not.toHaveBeenCalled();
	});
});

it('runs inside workerd', () => {
	expect(navigator.userAgent).toBe('Cloudflare-Workers');
});
