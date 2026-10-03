// The edge Worker through its fetch handler: list endpoints and their cache headers, CORS,
// `since` checks, the miss limiter, the ops guard, dev routes and what reaches the Store and logs.
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { b64decode, hex } from '@colander/shared/bytes';
import { encodeEntry, ENTRY, HEADER, verifyList } from '@colander/shared/list';
import { importKeys } from '@colander/shared/signing';
import worker from '../src/index';
import { Store } from '../src/store/store';

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
	worker.fetch(new IncomingRequest(ORIGIN + path, withClient(init) as RequestInit<IncomingRequestCfProperties>), { ...env, ...overrides });
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

	it('is a 503 that nothing caches before the first publication or without seq metadata', async () => {
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
			expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, OPTIONS');
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

	it('logs the route pattern, status and duration only', async () => {
		const logs = vi.spyOn(console, 'log');
		await get('/v1/sources/yt/@private-channel-name?ref=secret', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
		await get('/v1/list/delta?since=1700000123');
		const lines = logs.mock.calls.map((c) => String(c[0]));
		expect(lines.map((l) => Object.keys(JSON.parse(l)).sort())).toEqual([
			['ms', 'route', 'status'],
			['ms', 'route', 'status']
		]);
		expect(lines.map((l) => JSON.parse(l).route)).toEqual(['GET (unmatched)', 'GET /v1/list/delta']);
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
	it('answers 429 with Retry-After once one address exceeds 120 a minute', async () => {
		const headers = { 'CF-Connecting-IP': '192.0.2.44' };
		const statuses: number[] = [];
		for (let i = 0; i < 125; i++) statuses.push((await get('/v1/list/delta?since=x', { headers })).status);
		expect(statuses.filter((s) => s === 400)).toHaveLength(120);
		const res = await get('/v1/list/delta?since=x', { headers });
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		// Other addresses are unaffected.
		expect((await get('/v1/list/delta?since=x', { headers: { 'CF-Connecting-IP': '192.0.2.45' } })).status).toBe(400);
	});
});

describe('/ops/*', () => {
	it('needs the ops bearer token', async () => {
		const none = await get('/ops/status');
		expect(none.status).toBe(401);
		expect(none.headers.get('WWW-Authenticate')).toBe('Bearer');
		expect((await get('/ops/status', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
		expect((await get('/ops/status', { headers: { Authorization: 'test-ops-token' } })).status).toBe(401);
		const ok = await get('/ops/status', { method: 'POST', headers: { Authorization: 'Bearer test-ops-token' } });
		expect(ok.status).toBe(404);
		expect(((await ok.json()) as { error: { code: string } }).error.code).toBe('unknown_command');
	});

	it('is closed when no token is configured', async () => {
		expect((await getWith({ OPS_TOKEN: '' }, '/ops/status', { headers: { Authorization: 'Bearer ' } })).status).toBe(503);
	});
});

describe('/__dev/*', () => {
	it('reaches the Store router in dev mode', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		const res = await get('/__dev/seed', { method: 'POST' });
		expect(store).toHaveBeenCalledOnce();
		// No dev route is ported yet, so the Store answers with its JSON 404.
		expect(res.status).toBe(404);
		expect(res.headers.get('Content-Type')).toBe('application/json');
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
