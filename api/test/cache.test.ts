// Cache-Control on every route, through the whole Worker (hosting plan section 2): list 200 and 204
// for clients and the edge, delta 410 briefly at the edge only, the adapter configuration for 5
// minutes, the public GETs (supporters included) for 60 s, and no-store on everything else, errors
// included. Each row also checks CORS (contract 6: extension routes answer any origin, the rest are
// same-origin), and the table must name every route of the Store's router, so a new route cannot
// ship without one.
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { b64url } from '@colander/shared/bytes';
import type { Appeal, Report } from '@colander/shared/api';
import { isCorsPath } from '../src/http';
import { hashToken, newToken } from '../src/auth';
import { decide } from '../src/scoring/actions';
import { getAccount, grantRole, putFlow, setReviewerToken } from '../src/store/accounts';
import { ensureSource } from '../src/store/sources';
import { saveAdapterConfig } from '../src/store/misc';
import { latestSequence } from '../src/store/list';
import { Store } from '../src/store/store';
import { accessHeaders, ADMIN_ORIGIN } from './tokens';

const ORIGIN = 'https://getcolander.com';
const files = inject('contract');
const primary = () => env.STORE.getByName('primary');

/** The plan's policies: [Cache-Control, Cloudflare-CDN-Cache-Control]. */
const POLICY = {
	none: ['no-store', null],
	list: ['public, max-age=60', 'public, max-age=15, stale-if-error=86400'],
	gone: ['no-store', 'public, max-age=15'],
	config: ['public, max-age=300', 'public, max-age=300, stale-if-error=86400'],
	public: ['public, max-age=60', 'public, max-age=60']
} as const;

let client = 0;
const covered = new Set<string>();

/**
 * Sends a request through the Worker and checks status, cache headers, CORS and the route pattern
 * the Worker logged for it.
 */
async function check(
	route: string,
	method: string,
	path: string,
	status: number,
	policy: keyof typeof POLICY,
	init: { headers?: Record<string, string>; body?: unknown; origin?: string } = {}
): Promise<Response> {
	const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
	const headers = { 'CF-Connecting-IP': `198.18.0.${++client}`, Origin: 'chrome-extension://abc', ...init.headers };
	const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
	const origin = init.origin ?? ORIGIN;
	const res = await exports.default.fetch(new Request(origin + path, { method, headers, body }));
	const logged = logs.mock.calls
		.map((c) => {
			try {
				return JSON.parse(String(c[0])) as { route?: string; status?: number };
			} catch {
				return {};
			}
		})
		.filter((l) => l.route !== undefined && l.status !== undefined)
		.at(-1);
	logs.mockRestore();
	const what = `${method} ${path}`;
	expect(res.status, `${what}: ${res.status === status ? '' : await res.clone().text()}`).toBe(status);
	expect(logged?.route, what).toBe(route);
	expect([res.headers.get('Cache-Control'), res.headers.get('Cloudflare-CDN-Cache-Control')], what).toEqual(POLICY[policy]);
	// The admin host never answers CORS.
	expect(res.headers.get('Access-Control-Allow-Origin'), what).toBe(isCorsPath(path.split('?')[0]!) && origin === ORIGIN ? '*' : null);
	expect(res.headers.get('Access-Control-Allow-Credentials'), what).toBeNull();
	covered.add(route);
	return res;
}

const install = { Authorization: 'Install ' + b64url(new Uint8Array(16).fill(7)) };
let bearer: Record<string, string>;

beforeAll(async () => {
	const { raw, hash } = newToken();
	bearer = { Authorization: 'Bearer ' + raw };
	await runInDurableObject(primary(), async (store: Store) => {
		const staff = grantRole(store.db, 'rae@colander.test', 'staff', Math.floor(Date.now() / 1000), { host: 'job' });
		setReviewerToken(store.db, staff.id, hash, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7 * 86_400);
		const ref = ensureSource(store.db, 'yt', '@chan', 'Chan', Math.floor(Date.now() / 1000));
		decide(store.engine, { sourceRef: ref, verdict: 'slop', reason: 'Generated.', signals: 1 << 3, actor: 'staff' });
		await store.publisher.publish(store.now());
	});
});

afterAll(async () => {
	await env.LISTS.delete('list/snapshot.bin');
});

describe('Cache-Control on every route', () => {
	it('sets the plan policy on each answer', async () => {
		await check('GET /healthz', 'GET', '/healthz', 200, 'none');
		await check('OPTIONS (preflight)', 'OPTIONS', '/v1/tags', 204, 'none', { headers: { 'Access-Control-Request-Method': 'POST' } });

		// Lists: the snapshot from R2, the delta from the Store.
		await check('GET /v1/list/snapshot', 'GET', '/v1/list/snapshot', 200, 'list');
		const first = await runInDurableObject(primary(), (s: Store) => latestSequence(s.db).seq);
		await check('GET /v1/list/delta', 'GET', `/v1/list/delta?since=${first}`, 204, 'list');
		await check('GET /v1/list/delta', 'GET', '/v1/list/delta?since=1', 410, 'gone');
		await check('GET /v1/list/delta', 'GET', '/v1/list/delta?since=x', 400, 'none');

		await check('GET /v1/config/adapters', 'GET', '/v1/config/adapters', 404, 'none');
		await runInDurableObject(primary(), (s: Store) => saveAdapterConfig(s.db, 7, files.configEnvelope, 1));
		await check('GET /v1/config/adapters', 'GET', '/v1/config/adapters', 200, 'config');

		// The extension's install routes.
		const tag = { client_id: crypto.randomUUID(), platform: 'yt', target_type: 'source', target_id: '@chan', verdict: 'slop', platform_label: false };
		await check('POST /v1/tags', 'POST', '/v1/tags', 200, 'none', { headers: install, body: { tags: [tag] } });
		await check('POST /v1/tags', 'POST', '/v1/tags', 401, 'none', { body: { tags: [tag] } });
		const reported = await check('POST /v1/reports', 'POST', '/v1/reports', 201, 'none', {
			headers: install,
			body: { client_id: 'r-1', platform: 'yt', source_id: '@chan', reason: 'Generated.' }
		});
		const report = ((await reported.json()) as { report: Report }).report;
		await check('GET /v1/reports', 'GET', '/v1/reports', 200, 'none', { headers: install });
		const trial = await check('POST /v1/trial', 'POST', '/v1/trial', 200, 'none', { headers: install });
		const plan = { Authorization: 'Plan ' + ((await trial.json()) as { token: string }).token };
		await check('GET /v1/sync', 'GET', '/v1/sync', 200, 'none', { headers: plan });
		await check('PUT /v1/sync', 'PUT', '/v1/sync', 200, 'none', { headers: plan, body: { version: 0, data: { strictness: 'strict' } } });

		// Public GETs, the same for every viewer; their errors are not cached.
		await check('GET /v1/sources/:platform/:source_id', 'GET', '/v1/sources/yt/@chan', 200, 'public');
		await check('GET /v1/sources/:platform/:source_id', 'GET', '/v1/sources/yt/@nobody', 404, 'none');
		await check('GET /v1/log', 'GET', '/v1/log', 200, 'public');
		await check('GET /v1/log', 'GET', '/v1/log?limit=0', 400, 'none');
		await check('GET /v1/stats', 'GET', '/v1/stats', 200, 'public');

		// Appeals.
		const filed = await check('POST /v1/appeals', 'POST', '/v1/appeals', 201, 'none', {
			body: { platform: 'yt', source_id: '@chan', email: 'a@example.test', statement: 'Mine.' }
		});
		const { appeal, secret } = (await filed.json()) as { appeal: Appeal; secret: string };
		await check('GET /v1/appeals/:id', 'GET', `/v1/appeals/${appeal.id}?secret=${secret}`, 200, 'none');
		await check('POST /v1/appeals/:id/verify', 'POST', `/v1/appeals/${appeal.id}/verify`, 200, 'none', { body: { secret } });

		// Review: the side panel's bearer token on the main host, staff through Access on the admin host.
		const staff = { origin: ADMIN_ORIGIN, headers: await accessHeaders('rae@colander.test') };
		await check('GET /v1/review/queue', 'GET', '/v1/review/queue', 200, 'none', { headers: bearer });
		await check('GET /v1/review/sources/:platform/:source_id', 'GET', '/v1/review/sources/yt/@chan', 200, 'none', { headers: bearer });
		// The appeal is under review, so deciding the source needs staff: a reviewer token carries curator authority only.
		await check('POST /v1/review/sources/:platform/:source_id/decision', 'POST', '/v1/review/sources/yt/@chan/decision', 403, 'none', {
			headers: bearer,
			body: { verdict: 'slop', reason: 'Still generated.', signals: ['watermark'] }
		});
		await check('POST /v1/review/sources/:platform/:source_id/decision', 'POST', '/v1/review/sources/yt/@chan/decision', 200, 'none', {
			...staff,
			body: { verdict: 'slop', reason: 'Still generated.', signals: ['watermark'] }
		});
		// Seed list suppressions need staff authority, which exists on the admin host only.
		await check('POST /v1/review/sources/:platform/:source_id/suppress-seeds', 'POST', '/v1/review/sources/yt/@chan/suppress-seeds', 403, 'none', {
			headers: bearer,
			body: { reason: 'Objection by email.' }
		});
		await check('POST /v1/review/sources/:platform/:source_id/suppress-seeds', 'POST', '/v1/review/sources/yt/@chan/suppress-seeds', 200, 'none', {
			...staff,
			body: { reason: 'Objection by email.' }
		});
		await check('GET /v1/review/calibration/next', 'GET', '/v1/review/calibration/next', 200, 'none', { headers: bearer });
		await check('POST /v1/review/calibration/:platform/:source_id/label', 'POST', '/v1/review/calibration/yt/@chan/label', 404, 'none', {
			headers: bearer,
			body: { label: 'slop', tests: [], evidence: [], language: 'en', kind: 'video' }
		});
		await check('POST /v1/review/items/:platform/:item_id/decision', 'POST', '/v1/review/items/yt/abcdefghijk/decision', 200, 'none', {
			...staff,
			body: { verdict: 'clear', reason: 'Original.', source_id: '@chan' }
		});
		await check('POST /v1/review/reports/:id/dismiss', 'POST', `/v1/review/reports/${report.id}/dismiss`, 409, 'none', {
			...staff,
			body: { reason: 'Decided already.' }
		});
		await check('POST /v1/review/appeals/:id/verify', 'POST', `/v1/review/appeals/${appeal.id}/verify`, 403, 'none', { headers: bearer });
		await check('POST /v1/review/appeals/:id/verify', 'POST', `/v1/review/appeals/${appeal.id}/verify`, 200, 'none', staff);
		await check('POST /v1/review/appeals/:id/resolve', 'POST', `/v1/review/appeals/${appeal.id}/resolve`, 200, 'none', {
			...staff,
			body: { outcome: 'denied', reasoning: 'The footage is generated.' }
		});
		await check('GET (access required)', 'GET', '/v1/review/queue', 403, 'none', { origin: ADMIN_ORIGIN });

		// Accounts (contract 6.6): a code sign-in, the account, its passkeys, data and reviewer token.
		const CSRF = { 'X-Colander-CSRF': '1', 'Sec-Fetch-Site': 'same-origin' };
		await check('POST /v1/auth/code', 'POST', '/v1/auth/code', 202, 'none', { headers: CSRF, body: { email: 'cache@example.test', next: '/account' } });
		const flow = newToken();
		await runInDurableObject(primary(), (s: Store) => {
			const now = Math.floor(s.now() / 1000);
			putFlow(s.db, { tokenHash: flow.hash, kind: 'email_code', email: 'cache@example.test', secretHash: hashToken(flow.raw + '123456'), createdAt: now, expiresAt: now + 600 });
		});
		const verified = await check('POST /v1/auth/code/verify', 'POST', '/v1/auth/code/verify', 200, 'none', {
			headers: { ...CSRF, Cookie: `colander_flow=${flow.raw}` },
			body: { code: '123456' }
		});
		const signedIn = { Cookie: verified.headers.getSetCookie()[0]!.split(';')[0]!, ...CSRF };
		await check('GET /v1/account', 'GET', '/v1/account', 200, 'none', { headers: signedIn });
		await check('PATCH /v1/account', 'PATCH', '/v1/account', 200, 'none', { headers: signedIn, body: { display_name: 'Cache' } });
		await check('GET /v1/account/passkeys', 'GET', '/v1/account/passkeys', 200, 'none', { headers: signedIn });
		await check('POST /v1/account/passkeys/options', 'POST', '/v1/account/passkeys/options', 200, 'none', { headers: signedIn });
		await check('POST /v1/account/passkeys', 'POST', '/v1/account/passkeys', 400, 'none', { headers: signedIn, body: { credential: {} } });
		await check('DELETE /v1/account/passkeys/:id', 'DELETE', '/v1/account/passkeys/pk_none', 403, 'none', { headers: signedIn });
		await check('POST /v1/auth/passkey/options', 'POST', '/v1/auth/passkey/options', 200, 'none', { headers: CSRF });
		await check('POST /v1/auth/passkey/verify', 'POST', '/v1/auth/passkey/verify', 400, 'none', { headers: CSRF, body: { credential: {} } });
		await check('POST /v1/auth/invite/options', 'POST', '/v1/auth/invite/options', 400, 'none', { headers: signedIn, body: { invite: 'inv_x' } });
		await check('POST /v1/auth/invite/verify', 'POST', '/v1/auth/invite/verify', 400, 'none', { headers: signedIn, body: { invite: 'inv_x', credential: {} } });
		await check('POST /v1/auth/verify', 'POST', '/v1/auth/verify', 400, 'none', { headers: CSRF, body: { token: 'old-link' } });
		await check('POST /v1/account/requests', 'POST', '/v1/account/requests', 409, 'none', { headers: signedIn, body: { kind: 'delete' } });
		await check('DELETE /v1/account/requests/:id', 'DELETE', '/v1/account/requests/req_none', 404, 'none', { headers: signedIn });
		await check('POST /v1/auth/cancel', 'POST', '/v1/auth/cancel', 404, 'none', { headers: CSRF, body: { secret: 'nothing' } });
		await check('GET /v1/account/export', 'GET', '/v1/account/export', 200, 'none', { headers: signedIn });
		await check('DELETE /v1/account/reviewer-token', 'DELETE', '/v1/account/reviewer-token', 204, 'none', { headers: signedIn });

		// The admin API, only on the admin host and only through Access.
		await check('GET /v1/admin/me', 'GET', '/v1/admin/me', 200, 'none', staff);
		await check('GET /v1/admin/people', 'GET', '/v1/admin/people?q=cache', 200, 'none', staff);
		const granted = await check('PUT /v1/admin/people/role', 'PUT', '/v1/admin/people/role', 200, 'none', {
			...staff,
			body: { email: 'new.curator@example.test', role: 'curator' }
		});
		const curatorId = ((await granted.json()) as { person: { id: string } }).person.id;
		await check('POST /v1/admin/people/:id/invite', 'POST', `/v1/admin/people/${curatorId}/invite`, 201, 'none', staff);
		await check('POST /v1/admin/people/:id/revoke', 'POST', `/v1/admin/people/${curatorId}/revoke`, 403, 'none', staff);
		await check('PUT /v1/admin/people/:id/email', 'PUT', `/v1/admin/people/${curatorId}/email`, 403, 'none', {
			...staff,
			body: { email: 'x@example.test', checkout_session: 'cs_x', amount_cents: 300, date: '2026-10-01' }
		});
		await check('POST /v1/admin/donations/:id/credit', 'POST', '/v1/admin/donations/cs_x/credit', 403, 'none', { ...staff, body: { credit_name: '' } });
		await check('GET /v1/admin/audit', 'GET', '/v1/admin/audit', 403, 'none', staff);
		await check('GET (unmatched)', 'GET', '/v1/admin/me', 404, 'none');
		expect(await runInDurableObject(primary(), (s: Store) => getAccount(s.db, curatorId)?.role)).toBe('curator');

		// Pairing (contract 7): a member without a plan gets no code and no reviewer code; the claim answers any origin.
		await check('POST /v1/pair', 'POST', '/v1/pair', 404, 'none', { headers: signedIn, body: { kind: 'plan' } });
		await check('POST /v1/pair', 'POST', '/v1/pair', 403, 'none', { headers: signedIn, body: { kind: 'reviewer' } });
		await check('GET /v1/pair/:id', 'GET', '/v1/pair/pair_none', 404, 'none', { headers: signedIn });
		await check('POST /v1/pair/claim', 'POST', '/v1/pair/claim', 404, 'none', { body: { code: 'KXQ4-JP7M', ext_version: '1.0.0', browser: 'chrome' } });

		// Billing and entitlements (contract 6.8): without Stripe keys payments are off; the
		// supporters page is the same for every viewer.
		await check('POST /v1/billing/checkout', 'POST', '/v1/billing/checkout', 503, 'none', { headers: signedIn, body: { price: 'plus_yearly' } });
		await check('POST /v1/billing/donate', 'POST', '/v1/billing/donate', 503, 'none', { body: { amount_cents: 500, recurring: false, credit_name: '' } });
		await check('POST /v1/billing/cancel', 'POST', '/v1/billing/cancel', 503, 'none', { headers: signedIn, body: { refund: false } });
		await check('POST /v1/billing/webhook', 'POST', '/v1/billing/webhook', 503, 'none', { body: '{}' });
		await check('POST /v1/entitlement', 'POST', '/v1/entitlement', 404, 'none', { headers: signedIn });
		await check('POST /v1/entitlement/refresh', 'POST', '/v1/entitlement/refresh', 400, 'none', { body: { token: 'x' } });
		await check('GET /v1/supporters', 'GET', '/v1/supporters', 200, 'public');
		await check('DELETE /v1/account', 'DELETE', '/v1/account', 204, 'none', { headers: signedIn });
		await check('POST /v1/auth/logout', 'POST', '/v1/auth/logout', 204, 'none', { headers: signedIn });

		// An install erasing its server data.
		await check('DELETE /v1/install', 'DELETE', '/v1/install', 204, 'none', { headers: { Authorization: 'Install ' + b64url(new Uint8Array(16).fill(9)) } });

		// Dev-only routes, which exist only with COLANDER_DEV=1.
		await check('POST /__dev/seed', 'POST', '/__dev/seed', 409, 'none');
		await check('POST /__dev/settle', 'POST', '/__dev/settle', 200, 'none');
		await check('GET /__dev/dump', 'GET', '/__dev/dump', 200, 'none');

		await check('GET (unmatched)', 'GET', '/v1/nothing', 404, 'none');
	});

	it('answers a cached GET with a non-canonical query at the edge, so junk keys never reach the Store', async () => {
		const store = vi.spyOn(Store.prototype, 'fetch');
		const cases: [string, string, string][] = [
			['/v1/list/snapshot?r=1', 'GET /v1/list/snapshot', 'invalid_query'],
			['/v1/config/adapters?r=1', 'GET /v1/config/adapters', 'invalid_query'],
			['/v1/sources/yt/@chan?r=1', 'GET /v1/sources/:platform/:source_id', 'invalid_query'],
			['/v1/sources/yt/@chan?', 'GET /v1/sources/:platform/:source_id', ''],
			['/v1/stats?r=2', 'GET /v1/stats', 'invalid_query'],
			['/v1/supporters?r=3', 'GET /v1/supporters', 'invalid_query'],
			['/v1/log?r=1', 'GET /v1/log', 'invalid_query'],
			['/v1/log?limit=5&r=1', 'GET /v1/log', 'invalid_query'],
			['/v1/log?limit=5&limit=6', 'GET /v1/log', 'invalid_query'],
			['/v1/log?platform=yt&limit=5', 'GET /v1/log', 'invalid_query'],
			['/v1/log?limit=', 'GET /v1/log', 'invalid_query'],
			['/v1/log?cursor', 'GET /v1/log', 'invalid_query'],
			['/v1/log?limit=05', 'GET /v1/log', 'invalid_limit'],
			['/v1/log?limit=201', 'GET /v1/log', 'invalid_limit'],
			['/v1/log?platform=YT', 'GET /v1/log', 'invalid_platform'],
			['/v1/log?verdict=sloppy', 'GET /v1/log', 'invalid_verdict'],
			['/v1/log?cursor=7', 'GET /v1/log', 'invalid_cursor'],
			['/v1/log?cursor=log_007', 'GET /v1/log', 'invalid_cursor']
		];
		for (const [path, route, code] of cases) {
			const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
			const res = await exports.default.fetch(new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': `198.18.1.${++client}` } }));
			const logged = JSON.parse(String(logs.mock.calls.at(-1)![0])) as { route: string };
			logs.mockRestore();
			expect(logged.route, path).toBe(route);
			if (code === '') {
				// An empty query is no query at all.
				expect(res.status, path).toBe(200);
				continue;
			}
			expect(res.status, path).toBe(400);
			expect([res.headers.get('Cache-Control'), res.headers.get('Cloudflare-CDN-Cache-Control')], path).toEqual(POLICY.none);
			expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe(code);
		}
		expect(store.mock.calls.map((c) => new URL((c[0] as Request).url).pathname)).toEqual(['/v1/sources/yt/@chan']);
		// The website's own forms pass.
		for (const path of ['/v1/log?limit=3', '/v1/log?limit=50&platform=yt&verdict=likely_slop&cursor=log_12', '/v1/log?verdict=clear']) {
			const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
			const res = await exports.default.fetch(new Request(ORIGIN + path, { headers: { 'CF-Connecting-IP': `198.18.1.${++client}` } }));
			logs.mockRestore();
			expect(res.status, path).toBe(200);
		}
		store.mockRestore();
	});

	it('covers every route of the Store', async () => {
		const routes = await runInDurableObject(primary(), (s: Store) => s.routes.map((r) => `${r.method} ${r.pattern}`));
		expect(routes.filter((r) => !covered.has(r))).toEqual([]);
	});
});
