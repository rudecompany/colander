// The API routes of the extension, the public site, appeals and review (src/routes/*): the port of
// server/internal/api/api_test.go and ids_test.go for these routes, run against a fresh Store
// inside workerd through its own router, plus the strict request decoding of respond.go. The
// edge in front of them (CORS, cache headers on every route) is covered in cache.test.ts.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { b64url, hex } from '@colander/shared/bytes';
import { keyHash, targetKey } from '@colander/shared/ids';
import { decodeEntry, ENTRY, verifyList } from '@colander/shared/list';
import { importKeys, issuePlanToken, SigningKey, verifyPlanToken } from '@colander/shared/signing';
import { b64decode } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { utf8 } from '@colander/shared/bytes';
import type { Appeal, LogEntry, QueueItem, Report, ReviewSourceResponse, Source, Stats } from '@colander/shared/api';
import { IP_HASH_HEADER } from '../src/http';
import { CookieName, hashInstall, hashToken, newToken, normalizeEmail } from '../src/auth';
import { canonicalSource } from '../src/routes/ids';
import { decode, goFixed, goQuote, parseRFC3339 } from '../src/routes/respond';
import { unix } from '../src/scoring/engine';
import { createSession, grantRole, setDisplayName, setReviewerToken } from '../src/store/accounts';
import { saveSubscription } from '../src/store/billing';
import { latestSequence, setListRequests, SNAPSHOT_KEY } from '../src/store/list';
import { saveAdapterConfig } from '../src/store/misc';
import { addCalibrationItems } from '../src/store/calibration';
import { SeedRegistry } from '../src/store/seeds';
import { ensureSource, findItem, findSource, getSource, setYouTube } from '../src/store/sources';
import { loadSourceData } from '../src/store/verdicts';
import type { Store } from '../src/store/store';
import { clearedEntry, listSeed } from './seed-fixtures';

const files = inject('contract');
const keys = await importKeys([files.devPublicKey]);
const ORIGIN = 'https://getcolander.com';
const DAY = 24 * 3_600_000;

type Body = Record<string, unknown>;
type ErrorBody = { error: { code: string; message: string } };

/** Go's harness: one Store, a clock the Store reads, dev mail captured, and requests through the Store's router. */
class Harness {
	/** Dev mail printed so far, as Go's harness kept it in a buffer. */
	mail = '';

	constructor(
		readonly store: Store,
		public clock = Date.UTC(2026, 9, 1, 12)
	) {
		store.now = () => this.clock;
		store.mailer.out = (text) => void (this.mail += text + '\n');
	}

	get db() {
		return this.store.db;
	}

	/** Sends a request as the edge forwards it, from one client address unless headers say otherwise. */
	do(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
		const h = new Headers(headers);
		if (!h.has(IP_HASH_HEADER)) h.set(IP_HASH_HEADER, 'hash-of-192.0.2.1');
		return this.store.fetch(
			new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
		);
	}

	async publish(): Promise<number> {
		await this.store.publisher.publish(this.clock);
		return latestSequence(this.db).seq;
	}

	/** A session for email, as the magic link flow leaves one: the Cookie header. */
	signIn(email: string): string {
		const account = grantRole(this.db, email, 'member', unix(this.clock));
		return this.session(account.id);
	}

	session(accountId: string): string {
		const { raw, hash } = newToken();
		createSession(this.db, hash, accountId, unix(this.clock), unix(this.clock + 30 * DAY));
		return `${CookieName}=${raw}`;
	}

	/** Signs in a curator or staff member; the headers a review console write sends. */
	reviewer(email: string, role: string, name: string): Record<string, string> {
		const account = grantRole(this.db, email, role, unix(this.clock));
		setDisplayName(this.db, account.id, name);
		return { Cookie: this.session(account.id), 'X-Colander-CSRF': '1' };
	}

	/** A reviewer bearer token, as POST /v1/account/reviewer-token issues one. */
	bearer(email: string, role: string, name: string): Record<string, string> {
		const account = grantRole(this.db, email, role, unix(this.clock));
		setDisplayName(this.db, account.id, name);
		const { raw, hash } = newToken();
		setReviewerToken(this.db, account.id, hash, unix(this.clock));
		return { Authorization: 'Bearer ' + raw };
	}
}

let stores = 0;
const withHarness = (fn: (h: Harness) => Promise<void>) =>
	runInDurableObject(env.STORE.getByName(`routes-${++stores}`), async (store: Store) => {
		const h = new Harness(store);
		await h.publish();
		await fn(h);
	});

const code = async (res: Response): Promise<string> => ((await res.json()) as ErrorBody).error.code;

async function expectStatus(res: Response | Promise<Response>, status: number): Promise<Response> {
	const r = await res;
	if (r.status !== status) throw new Error(`status ${r.status}, want ${status}: ${await r.text()}`);
	return r;
}

function installID(n: number): string {
	const b = new Uint8Array(16);
	b[0] = n;
	return b64url(b);
}

const installAuth = (n: number) => ({ Authorization: 'Install ' + installID(n) });

/** A readable test name as a stable client UUID. */
function uuid(name: string): string {
	const h = hex(sha256(utf8(name)));
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function tag(clientId: string, targetType: string, target: string, source: string, verdict: string): Body {
	const t: Body = {
		client_id: uuid(clientId),
		platform: 'yt',
		target_type: targetType,
		target_id: target,
		verdict,
		platform_label: true,
		created_at: '2026-10-01T11:00:00Z',
		ext_version: '1.0.0'
	};
	if (source !== '') t.source_id = source;
	return t;
}

/** A delta's entries by hex hash. */
async function listEntries(res: Response) {
	const file = await verifyList(new Uint8Array(await res.arrayBuffer()), keys);
	const out = new Map<string, ReturnType<typeof decodeEntry>>();
	for (let i = 0; i < file.count; i++) out.set(hex(file.entries.subarray(i * ENTRY, i * ENTRY + 8)), decodeEntry(file.entries, i * ENTRY));
	return { file, entries: out };
}

const sourceHash = (alias: string) => hex(keyHash(targetKey('yt', 'source', alias)));

beforeEach(async () => {
	// Every Store in this file publishes to the same bucket; start each test without a snapshot.
	await env.LISTS.delete(SNAPSHOT_KEY);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('tags', () => {
	it('validates each tag and rejects unknown fields (TestTagValidation)', () =>
		withHarness(async (h) => {
			const unknown = `{"tags":[{"client_id":"a","platform":"yt","target_type":"source","target_id":"@x","verdict":"slop","page_url":"https://example.com"}]}`;
			const w = await expectStatus(h.do('POST', '/v1/tags', unknown, installAuth(1)), 400);
			expect(await w.json()).toEqual({
				error: { code: 'unknown_field', message: 'The request has a field this API does not accept: "page_url".' }
			});
			await expectStatus(h.do('POST', '/v1/tags', { tags: [tag('a', 'source', '@x', '', 'slop')] }), 401);

			const notUUID = { ...tag('x', 'source', '@somechannel', '', 'slop'), client_id: 'not-a-uuid' };
			const typedNotSlop = { ...tag('typed-not-slop', 'source', '@somechannel', '', 'not_slop'), slop_type: 'filler' };
			const testedAIFine = { ...tag('tested-ai-fine', 'item', 'abcdefghijk', '@somechannel', 'ai_fine'), tests: ['hollow'] };
			const emptyExtras = { ...tag('empty-extras', 'source', '@other', '', 'not_slop'), slop_type: '', tests: [] };
			const res = await expectStatus(
				h.do(
					'POST',
					'/v1/tags',
					{
						tags: [
							tag('ok-1', 'item', 'abcdefghijk', '@somechannel', 'slop'),
							tag('no-source', 'item', 'bcdefghijkl', '', 'slop'), // the card did not show the source
							emptyExtras,
							tag('bad-target', 'source', 'not a handle', '', 'slop'),
							tag('bad-verdict', 'source', '@somechannel', '', 'fake'),
							notUUID,
							typedNotSlop,
							testedAIFine,
							tag('source-with-source', 'source', '@somechannel', '@somechannel', 'slop')
						]
					},
					installAuth(1)
				),
				200
			);
			expect(await res.json()).toEqual({
				accepted: [uuid('ok-1'), uuid('no-source'), uuid('empty-extras')],
				rejected: [
					{ client_id: uuid('bad-target'), error: 'invalid_target' },
					{ client_id: uuid('bad-verdict'), error: 'invalid_verdict' },
					{ client_id: 'not-a-uuid', error: 'invalid_field' },
					{ client_id: uuid('typed-not-slop'), error: 'invalid_field' },
					{ client_id: uuid('tested-ai-fine'), error: 'invalid_field' },
					{ client_id: uuid('source-with-source'), error: 'invalid_field' }
				]
			});
			// The item without a source is kept apart from every real source.
			const it = findItem(h.db, 'yt', 'bcdefghijkl');
			expect(getSource(h.db, it!.sourceRef)!.canonicalId).toBe('');
		}));

	it('rejects malformed fields with their own codes', () =>
		withHarness(async (h) => {
			const res = await expectStatus(
				h.do(
					'POST',
					'/v1/tags',
					{
						tags: [
							{ ...tag('p', 'source', '@a', '', 'slop'), platform: 'xx' },
							{ ...tag('s', 'item', 'abcdefghijk', 'not a handle', 'slop') },
							{ ...tag('t', 'source', '@a', '', 'slop'), slop_type: 'spam' },
							{ ...tag('u', 'source', '@a', '', 'slop'), tests: ['boring'] },
							{ ...tag('c', 'source', '@a', '', 'slop'), created_at: 'yesterday' },
							{ ...tag('e', 'source', '@a', '', 'slop'), ext_version: 'x'.repeat(33) }
						]
					},
					installAuth(1)
				),
				200
			);
			const body = (await res.json()) as { rejected: { error: string }[] };
			expect(body.rejected.map((r) => r.error)).toEqual([
				'invalid_platform',
				'invalid_source',
				'invalid_slop_type',
				'invalid_tests',
				'invalid_created_at',
				'invalid_ext_version'
			]);
			await expectStatus(h.do('POST', '/v1/tags', { tags: [] }, installAuth(1)), 400);
			const big = Array.from({ length: 51 }, (_, i) => tag(`b${i}`, 'source', '@a', '', 'slop'));
			expect(await code(await h.do('POST', '/v1/tags', { tags: big }, installAuth(1)))).toBe('invalid_batch');
			expect(await code(await h.do('POST', '/v1/tags', { tags: [] }, { Authorization: 'Install short' }))).toBe('invalid_install');
		}));

	it('keeps the latest tag per install and target (TestTagIdempotencyAndLatestWins)', () =>
		withHarness(async (h) => {
			const send = (clientId: string, verdict: string, at: string) =>
				expectStatus(h.do('POST', '/v1/tags', { tags: [{ ...tag(clientId, 'source', '@somechannel', '', verdict), created_at: at }] }, installAuth(1)), 200);
			await send('c1', 'slop', '2026-10-01T10:00:00Z');
			await send('c1', 'slop', '2026-10-01T10:00:00Z'); // a retry
			await send('c2', 'not_slop', '2026-10-01T10:30:00Z');
			await send('c0', 'ai_fine', '2026-10-01T09:00:00Z'); // older, delivered late: ignored
			const ref = findSource(h.db, 'yt', '@somechannel')!;
			const votes = loadSourceData(h.db, ref, unix(h.clock))!.votes;
			expect(votes.map((v) => v.verdict)).toEqual(['not_slop']);
		}));

	it('limits tags per install (TestTagRateLimit)', () =>
		withHarness(async (h) => {
			const batch = (prefix: string) => ({
				tags: Array.from({ length: 40 }, (_, i) => tag(`${prefix}-${i}`, 'source', `@channel${i}`, '', 'slop'))
			});
			await expectStatus(h.do('POST', '/v1/tags', batch('a'), installAuth(1)), 200);
			const w = await expectStatus(h.do('POST', '/v1/tags', batch('b'), installAuth(1)), 429);
			expect(Number(w.headers.get('Retry-After'))).toBeGreaterThan(0);
			expect(await code(w)).toBe('rate_limited');
			// Another install is not affected, and the first recovers as time passes.
			await expectStatus(h.do('POST', '/v1/tags', batch('c'), installAuth(2)), 200);
			h.clock += 60_000;
			await expectStatus(h.do('POST', '/v1/tags', batch('d'), installAuth(1)), 200);
		}));
});

describe('reports', () => {
	it('follows a report from filing to a staff verdict (TestReportLifecycle)', () =>
		withHarness(async (h) => {
			const report = {
				client_id: 'r-1',
				platform: 'yt',
				source_id: '@AncientWondersDaily',
				source_name: 'Ancient Wonders Daily AI',
				examples: ['abcdefghijk'],
				reason: 'Posts 40 AI history videos a day with the same voice.',
				slop_type: 'filler',
				tests: ['mass_produced'],
				ext_version: '1.0.0'
			};
			const w = await expectStatus(h.do('POST', '/v1/reports', report, installAuth(1)), 201);
			const created = ((await w.json()) as { report: Report }).report;
			expect(created).toMatchObject({ status: 'under_review', verdict: null, source_id: '@ancientwondersdaily', protects: 0 });
			// The same client_id again is the same report.
			const again = await h.do('POST', '/v1/reports', report, installAuth(1));
			expect(((await again.json()) as { report: Report }).report.id).toBe(created.id);
			// 48 list syncs in the last 24 hours means 2 active installs.
			setListRequests(h.db, Math.floor(unix(h.clock) / 3600), 48);

			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const decision = {
				verdict: 'slop',
				reason: 'Staff review confirmed mass-produced narration.',
				signals: ['high_volume', 'community_consensus', 'watermark'],
				slop_type: 'filler',
				tests: ['mass_produced', 'low_effort']
			};
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@ancientwondersdaily/decision', decision, staff), 200);

			const list = ((await (await expectStatus(h.do('GET', '/v1/reports', undefined, installAuth(1)), 200)).json()) as { reports: Report[] }).reports;
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({ status: 'slop', verdict: 'slop', protects: 2 });
			// Another install sees none of them.
			const other = (await (await h.do('GET', '/v1/reports', undefined, installAuth(2))).json()) as { reports: Report[] };
			expect(other.reports).toHaveLength(0);
			// The decision is public, with the reviewer's reason and name.
			const page = (await (await expectStatus(h.do('GET', '/v1/sources/yt/@ancientwondersdaily'), 200)).json()) as {
				source: Source;
				history: LogEntry[];
			};
			expect(page.source.verdict).toBe('slop');
			expect(page.history).toHaveLength(1);
			expect(page.history[0]).toMatchObject({ actor: 'staff', actor_name: 'Rae' });
			// Hand-set community_consensus is ignored; staff_review is computed.
			expect(page.source.signals).toContain('staff_review');
			expect(page.source.signals).not.toContain('community_consensus');
		}));

	it('validates reports', () =>
		withHarness(async (h) => {
			const base = { client_id: 'r-2', platform: 'yt', source_id: '@chan', reason: 'Generated.', ext_version: '1.0.0' };
			const cases: [Body, string][] = [
				[{ ...base, client_id: 'not a uuid!' }, 'invalid_client_id'],
				[{ ...base, platform: 'xx' }, 'invalid_platform'],
				[{ ...base, reason: '   ' }, 'invalid_reason'],
				[{ ...base, reason: 'é'.repeat(501) }, 'invalid_reason'],
				[{ ...base, source_name: 'n'.repeat(121) }, 'invalid_source_name'],
				[{ ...base, examples: ['abcdefghijk', 'abcdefghijl', 'abcdefghijm', 'abcdefghijn'] }, 'invalid_examples'],
				[{ ...base, ext_version: 'v'.repeat(33) }, 'invalid_ext_version'],
				[{ ...base, source_id: 'no handle' }, 'invalid_source'],
				[{ ...base, examples: ['short'] }, 'invalid_examples'],
				[{ ...base, slop_type: 'spam' }, 'invalid_slop_type'],
				[{ ...base, tests: ['boring'] }, 'invalid_tests']
			];
			for (const [body, want] of cases) expect(await code(await expectStatus(h.do('POST', '/v1/reports', body, installAuth(1)), 400)), want).toBe(want);
			// 500 characters, counted as characters, not bytes, are fine.
			await expectStatus(h.do('POST', '/v1/reports', { ...base, reason: 'é'.repeat(500) }, installAuth(1)), 201);
		}));

	it('limits reports to 20 per install per day', () =>
		withHarness(async (h) => {
			for (let i = 0; i < 20; i++) {
				await expectStatus(h.do('POST', '/v1/reports', { client_id: `r-${i}`, platform: 'yt', source_id: '@chan', reason: 'Generated.' }, installAuth(1)), 201);
			}
			const w = await expectStatus(h.do('POST', '/v1/reports', { client_id: 'r-20', platform: 'yt', source_id: '@chan', reason: 'Generated.' }, installAuth(1)), 429);
			expect(Number(w.headers.get('Retry-After'))).toBe(4320);
		}));

	it('follows the community verdict once it lands (TestReportFollowsCommunityVerdict)', () =>
		withHarness(async (h) => {
			await expectStatus(
				h.do('POST', '/v1/reports', { client_id: uuid('r-1'), platform: 'yt', source_id: '@farm', reason: 'Generated narration.', ext_version: '1.0.0' }, installAuth(1)),
				201
			);
			setListRequests(h.db, Math.floor(unix(h.clock) / 3600), 24);
			for (let i = 0; i < 3; i++) {
				await expectStatus(h.do('POST', '/v1/tags', { tags: [tag(`ai-${i}`, 'source', '@farm', '', 'ai_fine')] }, installAuth(10 + i)), 200);
			}
			await h.store.engine.fullPass(h.clock);
			const list = ((await (await h.do('GET', '/v1/reports', undefined, installAuth(1))).json()) as { reports: Report[] }).reports;
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({ status: 'ai_made', verdict: 'ai_made', protects: 1 });
		}));
});

describe('appeals', () => {
	it('runs an appeal from filing to upheld (TestAppealFlow)', () =>
		withHarness(async (h) => {
			const channel = 'UCzzzzzzzzzzzzzzzzzzzz42';
			const ref = ensureSource(h.db, 'yt', '@oceanmysteries', 'Ocean Mysteries', unix(h.clock));
			setYouTube(h.db, ref, { channelId: channel, handle: '@oceanmysteries', subscribers: null, uploadsPerDay: null }, unix(h.clock));
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(
				h.do(
					'POST',
					'/v1/review/sources/yt/@oceanmysteries/decision',
					{ verdict: 'slop', reason: 'Generated narration over stock clips.', signals: ['templated', 'watermark'] },
					staff
				),
				200
			);
			h.clock += 1000;
			const seq = await h.publish();

			// The creator appeals; the secret comes back once and by email.
			const w = await expectStatus(
				h.do('POST', '/v1/appeals', { platform: 'yt', source_id: channel, email: 'Studio@Example.test', statement: 'We film our own dives.' }),
				201
			);
			const created = (await w.json()) as { appeal: Appeal; secret: string };
			expect(created.appeal).toMatchObject({ status: 'awaiting_verification', source_id: channel, source_name: 'Ocean Mysteries', outcome: null });
			expect(created.appeal.code).toMatch(/^colander-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
			expect(h.mail).toContain('To: studio@example.test\nSubject: Your Colander appeal for Ocean Mysteries\n');
			expect(h.mail).toContain(`add this code to its description:\n\n    ${created.appeal.code}\n`);
			expect(h.mail).toContain(`https://getcolander.com/appeal/status/${created.appeal.id}?secret=${created.secret}\n`);
			await expectStatus(h.do('GET', `/v1/appeals/${created.appeal.id}?secret=wrong`), 404);
			await expectStatus(h.do('GET', `/v1/appeals/${created.appeal.id}?secret=${created.secret}`), 200);
			// Without a YouTube key, the creator's verify request moves the appeal to staff.
			const v = await expectStatus(h.do('POST', `/v1/appeals/${created.appeal.id}/verify`, { secret: created.secret }), 200);
			expect(((await v.json()) as { appeal: Appeal }).appeal.status).toBe('pending_manual');

			// Staff confirm the code: Disputed at once, and the next delta carries it for every alias.
			await expectStatus(h.do('POST', `/v1/review/appeals/${created.appeal.id}/verify`, undefined, staff), 200);
			h.clock += 1000;
			await h.publish();
			const delta = await expectStatus(h.do('GET', `/v1/list/delta?since=${seq}`), 200);
			const { entries } = await listEntries(delta);
			for (const alias of [channel, '@oceanmysteries']) {
				expect(entries.get(sourceHash(alias)), alias).toMatchObject({ verdict: 'disputed' });
				expect(entries.get(sourceHash(alias))!.signals).toContain('open_appeal');
			}

			// Staff uphold it: Clear, with the reasoning in the public log.
			const reason = 'The creator films original dive footage.';
			const r = await expectStatus(h.do('POST', `/v1/review/appeals/${created.appeal.id}/resolve`, { outcome: 'upheld', reasoning: reason }, staff), 200);
			const resolved = ((await r.json()) as { appeal: Appeal }).appeal;
			expect(resolved).toMatchObject({ status: 'upheld', outcome: 'upheld', reasoning: reason });
			expect(resolved.resolved_at).not.toBeNull();
			const entry = ((await (await h.do('GET', '/v1/log?limit=1')).json()) as { entries: LogEntry[] }).entries[0]!;
			expect(entry).toMatchObject({ to: 'clear', from: 'disputed', actor: 'appeal' });
			expect(entry.reason).toContain(reason);
			h.clock += 1000;
			const seq2 = await h.publish();
			const coalesced = await listEntries(await h.do('GET', `/v1/list/delta?since=${seq}`));
			expect(coalesced.entries.get(sourceHash('@oceanmysteries'))).toMatchObject({ verdict: 'clear' });
			expect(seq2).toBeGreaterThan(seq);
			// A closed appeal cannot be verified again.
			expect(await code(await h.do('POST', `/v1/appeals/${created.appeal.id}/verify`, { secret: created.secret }))).toBe('appeal_closed');
		}));

	it('validates appeals and limits them per client address', () =>
		withHarness(async (h) => {
			const base = { platform: 'yt', source_id: '@nobody', email: 'a@example.test', statement: 'Mine.' };
			expect(await code(await h.do('POST', '/v1/appeals', { ...base, platform: 'xx' }))).toBe('invalid_platform');
			expect(await code(await h.do('POST', '/v1/appeals', { ...base, email: 'A <a@example.test>' }))).toBe('invalid_email');
			expect(await code(await h.do('POST', '/v1/appeals', { ...base, statement: ' ' }))).toBe('invalid_statement');
			expect(await code(await h.do('POST', '/v1/appeals', { ...base, statement: 'x'.repeat(2001) }))).toBe('invalid_statement');
			// Unknown and unrated sources are 404 not_rated, and spend the quota as in Go.
			expect(await code(await expectStatus(h.do('POST', '/v1/appeals', base), 404))).toBe('not_rated');
			ensureSource(h.db, 'yt', '@unrated', '', unix(h.clock));
			const unrated = await expectStatus(h.do('POST', '/v1/appeals', { ...base, source_id: '@unrated' }), 404);
			expect(((await unrated.json()) as ErrorBody).error.message).toBe('This source has no verdict to appeal.');
			for (let i = 0; i < 3; i++) await expectStatus(h.do('POST', '/v1/appeals', base), 404);
			const limited = await expectStatus(h.do('POST', '/v1/appeals', base), 429);
			expect(Number(limited.headers.get('Retry-After'))).toBe(17280);
			// Another address still may.
			await expectStatus(h.do('POST', '/v1/appeals', base, { [IP_HASH_HEADER]: 'hash-of-another' }), 404);
			expect(await code(await h.do('GET', '/v1/appeals/apl_nothing?secret=x'))).toBe('not_found');
		}));
});

describe('lists', () => {
	it('answers deltas with 200, 204 and 410 (TestDeltaStatuses)', () =>
		withHarness(async (h) => {
			const seq = latestSequence(h.db).seq;
			const head = await expectStatus(h.do('GET', `/v1/list/delta?since=${seq}`), 204);
			expect(head.headers.get('Cache-Control')).toBe('public, max-age=60');

			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(
				h.do('POST', '/v1/review/sources/tt/@petpalsai/decision', { verdict: 'slop', reason: 'Generated pet clips around the clock.', signals: ['creator_statement'] }, staff),
				200
			);
			await h.publish();
			const w = await expectStatus(h.do('GET', `/v1/list/delta?since=${seq}`), 200);
			const sequence = w.headers.get('X-Colander-Sequence');
			const { file } = await listEntries(w);
			expect(file).toMatchObject({ kind: 'delta', base: seq, count: 1 });
			expect(sequence).toBe(String(file.sequence));
			await expectStatus(h.do('GET', '/v1/list/delta?since=999'), 410);
			await expectStatus(h.do('GET', '/v1/list/delta?since=0'), 410);
			// Sequences older than 30 days are gone too.
			h.clock += 31 * DAY;
			await expectStatus(h.do('GET', `/v1/list/delta?since=${seq}`), 410);

			const snap = await expectStatus(h.do('GET', '/v1/list/snapshot'), 200);
			expect(snap.headers.get('Cache-Control')).toBe('public, max-age=60');
			const snapshot = await verifyList(new Uint8Array(await snap.arrayBuffer()), keys);
			expect(snapshot).toMatchObject({ kind: 'snapshot', count: 1 });
		}));

	it('serves the signed adapter configuration, or 404 so the extension keeps its own', () =>
		withHarness(async (h) => {
			expect(await code(await expectStatus(h.do('GET', '/v1/config/adapters'), 404))).toBe('no_config');
			saveAdapterConfig(h.db, 7, files.configEnvelope, unix(h.clock));
			const w = await expectStatus(h.do('GET', '/v1/config/adapters'), 200);
			expect(w.headers.get('Content-Type')).toBe('application/json');
			expect(w.headers.get('Cache-Control')).toBe('public, max-age=300');
			expect(w.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=300, stale-if-error=86400');
			expect(await w.text()).toBe(files.configEnvelope);
		}));
});

describe('public pages', () => {
	it('pages through the decision log and checks its filters', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			for (const alias of ['@one', '@two', '@three']) {
				await expectStatus(h.do('POST', `/v1/review/sources/yt/${alias}/decision`, { verdict: 'ai_made', reason: 'Labelled AI.', signals: ['platform_label'] }, staff), 200);
			}
			await expectStatus(h.do('POST', '/v1/review/sources/tt/@four/decision', { verdict: 'clear', reason: 'Original.' }, staff), 200);
			const first = (await (await expectStatus(h.do('GET', '/v1/log?limit=2&platform=yt'), 200)).json()) as { entries: LogEntry[]; next_cursor: string };
			expect(first.entries.map((e) => e.target_id)).toEqual(['@three', '@two']);
			expect(first.next_cursor).toBe(first.entries[1]!.id);
			const rest = (await (await h.do('GET', `/v1/log?limit=2&platform=yt&cursor=${first.next_cursor}`)).json()) as { entries: LogEntry[]; next_cursor: null };
			expect(rest.entries.map((e) => e.target_id)).toEqual(['@one']);
			expect(rest.next_cursor).toBeNull();
			const clear = (await (await h.do('GET', '/v1/log?verdict=clear')).json()) as { entries: LogEntry[] };
			expect(clear.entries.map((e) => e.target_id)).toEqual(['@four']);
			expect(clear.entries[0]).toMatchObject({ platform: 'tt', from: null, to: 'clear', actor: 'staff', actor_name: 'Rae', source_name: null });
			for (const [query, want] of [
				['platform=xx', 'invalid_platform'],
				['verdict=removed', 'invalid_verdict'],
				['cursor=log_0', 'invalid_cursor'],
				['cursor=abc', 'invalid_cursor'],
				['limit=0', 'invalid_limit'],
				['limit=x', 'invalid_limit']
			]) {
				expect(await code(await expectStatus(h.do('GET', `/v1/log?${query}`), 400)), query).toBe(want);
			}
		}));

	it('shows a source by any alias, with its evidence, and 404 not_rated for unknown ones', () =>
		withHarness(async (h) => {
			const ref = ensureSource(h.db, 'yt', '@farm', 'The Farm', unix(h.clock));
			setYouTube(h.db, ref, { channelId: 'UCzzzzzzzzzzzzzzzzzzzz45', handle: '@farm', subscribers: 1000, uploadsPerDay: 14.237 }, unix(h.clock));
			for (let i = 0; i < 3; i++) {
				await expectStatus(h.do('POST', '/v1/tags', { tags: [tag(`ai-${i}`, 'source', '@farm', '', 'ai_fine')] }, installAuth(10 + i)), 200);
			}
			await h.store.engine.fullPass(h.clock);
			const byHandle = (await (await expectStatus(h.do('GET', '/v1/sources/yt/@Farm'), 200)).json()) as { source: Source; history: LogEntry[] };
			const byID = (await (await expectStatus(h.do('GET', '/v1/sources/yt/UCzzzzzzzzzzzzzzzzzzzz45'), 200)).json()) as { source: Source };
			expect(byID.source).toEqual(byHandle.source);
			expect(byHandle.source).toMatchObject({
				platform: 'yt',
				id: 'UCzzzzzzzzzzzzzzzzzzzz45',
				aliases: ['UCzzzzzzzzzzzzzzzzzzzz45', '@farm'],
				name: 'The Farm',
				verdict: 'ai_made',
				large: false,
				// The stored subscriber count feeds nothing without derived use, so the size is unknown.
				audience_known: false,
				imported: false,
				attribution: null,
				appeal_open: false,
				// YouTube Data API figures are never published, even when stored with derived use.
				evidence: { taggers: 3, tags: { slop: 0, ai_fine: 3, not_slop: 0 }, items_seen: 0, ai_item_share: null, uploads_per_day: null }
			});
			expect(byHandle.source.updated_at).toBe('2026-10-01T12:00:00Z');
			expect(byHandle.history[0]).toMatchObject({ actor: 'community', to: 'ai_made', source_id: 'UCzzzzzzzzzzzzzzzzzzzz45' });
			// Once staff record the size, it is known, large or not.
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			for (const large of [false, true]) {
				await expectStatus(h.do('POST', '/v1/review/sources/yt/@farm/decision', { verdict: 'ai_made', reason: 'Size checked.', large }, staff), 200);
				const { source } = (await (await expectStatus(h.do('GET', '/v1/sources/yt/@farm'), 200)).json()) as { source: Source };
				expect(source, `large ${large}`).toMatchObject({ large, audience_known: true });
			}
			for (const path of ['/v1/sources/yt/@nobody', '/v1/sources/yt/not%20a%20handle', '/v1/sources/xx/@farm']) {
				expect(await code(await expectStatus(h.do('GET', path), 404)), path).toBe('not_rated');
			}
			// Percent-encoded handles resolve like the raw ones.
			await expectStatus(h.do('POST', '/v1/tags', { tags: [tag('cafe', 'source', '@caféhistoire', '', 'slop')] }, installAuth(30)), 200);
			expect(findSource(h.db, 'yt', '@caféhistoire')).toBeDefined();
			await expectStatus(h.do('GET', '/v1/sources/yt/@Caf%C3%A9Histoire'), 200);
		}));

	// Public pages never name a data source (contracts 6.4): a seed list is a review lead. Every
	// reviewer sees that lists name a source and how many; only staff see which, with provenance.
	it('never names a dataset in public JSON; staff see the provenance of a seed lead, curators a count', () =>
		withHarness(async (h) => {
			const entry = clearedEntry();
			const pending = clearedEntry({ id: 'pending-list', name: 'Pending Open List', sha256: null, clearance: { status: 'pending', by: null, at: null } });
			h.store.engine.seeds = new SeedRegistry([entry, pending]);
			listSeed(h.db, entry, ['@seeded', '@seedonly'], unix(h.clock), Date.UTC(2026, 8, 1) / 1000);
			for (let i = 0; i < 3; i++) {
				await expectStatus(h.do('POST', '/v1/tags', { tags: [tag(`seeded-${i}`, 'source', '@seeded', '', 'ai_fine')] }, installAuth(40 + i)), 200);
			}
			await h.store.engine.fullPass(h.clock);
			const pages = await Promise.all(['/v1/sources/yt/@seeded', '/v1/log', '/v1/stats'].map(async (path) => (await expectStatus(h.do('GET', path), 200)).text()));
			for (const page of pages) {
				expect(page).not.toMatch(/seed list|CC0/i);
				for (const name of h.store.engine.seeds.names()) expect(page.toLowerCase()).not.toContain(name.toLowerCase());
			}
			const { source } = JSON.parse(pages[0]!) as { source: Source };
			expect(source).toMatchObject({ verdict: 'ai_made', imported: false, attribution: null });
			expect(source.evidence.uploads_per_day).toBeNull();
			// A source only a list names is unknown to the public, so no page can tell it is listed.
			expect(await code(await expectStatus(h.do('GET', '/v1/sources/yt/@seedonly'), 404))).toBe('not_rated');

			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const review = (await (await expectStatus(h.do('GET', '/v1/review/sources/yt/@seeded', undefined, staff), 200)).json()) as ReviewSourceResponse;
			expect(review.source).toMatchObject({ imported: true, attribution: 'Secret Seed List (CC0-1.0), lead' });
			expect(review.seed_lists).toBe(1);
			expect(review.seeds).toEqual([
				{
					seed: 'secret-list',
					name: 'Secret Seed List',
					license: 'CC0-1.0',
					use: 'lead',
					platform: 'yt',
					alias: '@seeded',
					batch: 1,
					imported_at: '2026-10-01T12:00:00Z',
					listed_at: '2026-09-01T00:00:00Z',
					expires_at: '2027-09-01T00:00:00Z'
				}
			]);
			expect(review.seed_suppression).toBeNull();
			expect(review.layers.provenance.detail).toBe('3 installs saw a platform AI label; listed on Secret Seed List (CC0-1.0) as a lead, a review lead that is not evidence.');

			const curator = h.reviewer('sam@colander.test', 'curator', 'Sam');
			const res = await expectStatus(h.do('GET', '/v1/review/sources/yt/@seeded', undefined, curator), 200);
			const text = await res.text();
			expect(text).not.toMatch(/secret/i);
			const asCurator = JSON.parse(text) as ReviewSourceResponse;
			expect(asCurator.source).toMatchObject({ imported: true, attribution: null });
			expect(asCurator.seed_lists).toBe(1);
			expect(asCurator).not.toHaveProperty('seeds');
			expect(asCurator).not.toHaveProperty('seed_suppression');
			expect(asCurator.layers.provenance.detail).toBe('3 installs saw a platform AI label; on 1 seed list, a review lead that is not evidence.');

			// Leads come last in the queue, summarized without a name, and alone under kind=leads.
			const queue = async (kind: string) => {
				const r = await expectStatus(h.do('GET', `/v1/review/queue?kind=${kind}`, undefined, curator), 200);
				const t = await r.text();
				expect(t).not.toMatch(/secret/i);
				return (JSON.parse(t) as { items: QueueItem[] }).items;
			};
			const leads = await queue('leads');
			expect(leads.map((q) => [q.source_id, q.kind, q.lead, q.priority, q.summary])).toEqual([
				['@seeded', 'escalation', true, 4, 'Seed lead on 1 seed list, not evidence'],
				['@seedonly', 'escalation', true, 4, 'Seed lead on 1 seed list, not evidence']
			]);
			expect((await queue('all')).map((q) => q.source_id)).toEqual(['@seeded', '@seedonly']);
			expect(await queue('reports')).toEqual([]);
			// A slop tag backs a lead: it moves up to the priority of a report.
			await expectStatus(h.do('POST', '/v1/tags', { tags: [tag('backing', 'source', '@seedonly', '', 'slop')] }, installAuth(50)), 200);
			expect((await queue('leads')).map((q) => [q.source_id, q.priority])).toEqual([
				['@seedonly', 3],
				['@seeded', 4]
			]);

			// Reviewers cannot name a dataset in the public log by accident, imported or not.
			for (const [reason, name] of [
				['Also on the secret seed list.', 'Secret Seed List'],
				['Also on the Pending Open List.', 'Pending Open List'],
				['Listed in pending-list.', 'Pending Open List']
			]) {
				const named = await expectStatus(h.do('POST', '/v1/review/sources/yt/@seeded/decision', { verdict: 'ai_made', reason, signals: [] }, staff), 400);
				expect(await named.json()).toEqual({
					error: { code: 'source_named', message: `The text names the seed list ${name}. The decision log is public and never names a data source.` }
				});
			}

			// An import from before the license check or the registry is no lead for reviewers either.
			const legacy = ensureSource(h.db, 'yt', '@legacyseed', '', unix(h.clock));
			h.db.run("UPDATE sources SET import_list = 'blocklist', import_source = 'Old List', import_license = 'CC BY-NC 4.0', imported_at = 1 WHERE id = ?", legacy);
			const old = (await (await expectStatus(h.do('GET', '/v1/review/sources/yt/@legacyseed', undefined, staff), 200)).json()) as ReviewSourceResponse;
			expect(old.source).toMatchObject({ imported: false, attribution: null });
			expect(old.seed_lists).toBe(0);
			expect(old.layers.provenance.detail).toBe('No AI evidence yet.');
		}));

	// Staff suppress seed lists on a source for an objection under GDPR Article 21: its entries go,
	// the lead closes, and no import lists it again until staff lift it.
	it('lets only staff suppress seed lists on a source, and lift it', () =>
		withHarness(async (h) => {
			const entry = clearedEntry();
			h.store.engine.seeds = new SeedRegistry([entry]);
			listSeed(h.db, entry, ['@objector'], unix(h.clock));
			await h.store.engine.fullPass(h.clock);
			const curator = h.reviewer('sam@colander.test', 'curator', 'Sam');
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const path = '/v1/review/sources/yt/@objector/suppress-seeds';
			expect(await code(await expectStatus(h.do('POST', path, { reason: 'Objection by email' }, curator), 403))).toBe('staff_required');
			expect(await code(await expectStatus(h.do('POST', path, { reason: '' }, staff), 400))).toBe('invalid_reason');
			expect(await code(await expectStatus(h.do('POST', '/v1/review/sources/yt/@nobody/suppress-seeds', { reason: 'x' }, staff), 404))).toBe('not_rated');

			const done = (await (await expectStatus(h.do('POST', path, { reason: 'Objection under Article 21, case 7' }, staff), 200)).json()) as ReviewSourceResponse;
			expect(done.seeds).toEqual([]);
			expect(done.seed_suppression).toEqual({ at: '2026-10-01T12:00:00Z', reason: 'Objection under Article 21, case 7' });
			await h.store.engine.fullPass(h.clock);
			expect(((await (await expectStatus(h.do('GET', '/v1/review/queue?kind=leads', undefined, staff), 200)).json()) as { items: QueueItem[] }).items).toEqual([]);
			// The next import of the same list skips it.
			listSeed(h.db, entry, ['@objector', '@other'], unix(h.clock));
			expect(h.db.all('SELECT alias FROM seed_entries')).toEqual([{ alias: '@other' }]);

			const lifted = (await (await expectStatus(h.do('POST', path, { reason: 'The creator withdrew it', lift: true }, staff), 200)).json()) as ReviewSourceResponse;
			expect(lifted.seed_suppression).toBeNull();
			listSeed(h.db, entry, ['@objector', '@other'], unix(h.clock));
			expect(h.db.all('SELECT alias FROM seed_entries ORDER BY alias')).toEqual([{ alias: '@objector' }, { alias: '@other' }]);
		}));

	// The calibration set is labeled blind (seed design section 8): the next item carries only what
	// a labeler needs to find it, two reviewers label each, and staff settle a disagreement.
	it('serves calibration items blind, two labels each and a third from staff when they disagree', () =>
		withHarness(async (h) => {
			const now = unix(h.clock);
			await expectStatus(h.do('POST', '/v1/tags', { tags: [tag('cal', 'source', '@calone', '', 'slop')] }, installAuth(60)), 200);
			await h.store.engine.fullPass(h.clock);
			const one = findSource(h.db, 'yt', '@calone')!;
			const two = ensureSource(h.db, 'yt', 'UCzzzzzzzzzzzzzzzzzzzzc2', '', now);
			addCalibrationItems(h.db, [one], 'community', now);
			addCalibrationItems(h.db, [two], 'random:tubecensus-sample', now + 1);
			const [a, b, c] = ['a', 'b', 'c'].map((x) => h.reviewer(`${x}@colander.test`, 'curator', x.toUpperCase()));
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const next = async (who: Record<string, string>) => (await (await expectStatus(h.do('GET', '/v1/review/calibration/next', undefined, who), 200)).json()) as { item: unknown };
			const label = (who: Record<string, string>, id: string, body: Body) => h.do('POST', `/v1/review/calibration/yt/${id}/label`, { tests: [], evidence: [], ...body }, who);

			const first = await next(a!);
			expect(first).toEqual({ item: { platform: 'yt', source_id: '@calone', labels: 0 } });
			expect(await code(await expectStatus(h.do('GET', '/v1/review/calibration/next'), 401))).toBe('signed_out');
			expect(await code(await expectStatus(label(a!, '@calone', { label: 'fake' }), 400))).toBe('invalid_label');
			expect(await code(await expectStatus(label(a!, '@calone', { label: 'not_ai', tests: ['hollow'] }), 400))).toBe('invalid_tests');
			expect(await code(await expectStatus(label(a!, '@calone', { label: 'slop', evidence: ['mostly_ai'] }), 400))).toBe('invalid_evidence');
			expect(await code(await expectStatus(label(a!, '@nobody', { label: 'slop' }), 404))).toBe('not_in_calibration');

			const after = (await (await expectStatus(label(a!, '@calone', { label: 'slop', tests: ['hollow'], evidence: ['platform_label'], note: 'Labeled shorts' }), 200)).json()) as { item: unknown };
			expect(after).toEqual({ item: { platform: 'yt', source_id: 'UCzzzzzzzzzzzzzzzzzzzzc2', labels: 0 } });
			expect(await code(await expectStatus(label(a!, '@calone', { label: 'slop' }), 409))).toBe('already_labeled');
			// A half-labeled item comes first for the next labeler, so pairs finish.
			expect(await next(b!)).toEqual({ item: { platform: 'yt', source_id: '@calone', labels: 1 } });
			await expectStatus(label(b!, '@calone', { label: 'not_ai' }), 200);
			expect(await next(c!), 'two labels are enough for curators').toEqual({ item: { platform: 'yt', source_id: 'UCzzzzzzzzzzzzzzzzzzzzc2', labels: 0 } });
			expect(await code(await expectStatus(label(c!, '@calone', { label: 'slop' }), 409))).toBe('already_labeled');
			expect(await next(staff), 'staff settle the disagreement').toEqual({ item: { platform: 'yt', source_id: '@calone', labels: 2 } });
			await expectStatus(label(staff, '@calone', { label: 'slop' }), 200);
			expect(h.db.all('SELECT label, tests, evidence, note FROM calibration_labels ORDER BY labeled_at, label')).toEqual([
				{ label: 'not_ai', tests: 0, evidence: 0, note: null },
				{ label: 'slop', tests: 16, evidence: 1, note: 'Labeled shorts' },
				{ label: 'slop', tests: 0, evidence: 0, note: null }
			]);
		}));

	it('estimates active installs over the 24 whole hours the analytics pull counted', () =>
		withHarness(async (h) => {
			const hour = Math.floor(unix(h.clock) / 3600);
			const pulled = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ hour: from + i, count: 1000 }));
			const active = async () => ((await (await expectStatus(h.do('GET', '/v1/stats'), 200)).json()) as Stats).active_installs;
			// Steady 1,000 installs syncing hourly, as the pull at minute 7 writes them: whole hours up to the last one.
			h.store.setListRequests(pulled(hour - 24, hour));
			expect(await active()).toBe(1000);
			// Between the turn of the hour and the next pull the window still ends at the last counted hour.
			h.clock += 3_600_000;
			expect(await active()).toBe(1000);
			h.store.setListRequests(pulled(hour - 5, hour + 1));
			expect(await active()).toBe(1000);
		}));

	it('counts verdicts, decisions, appeals and installs for the website', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@one/decision', { verdict: 'slop', reason: 'Generated.', signals: ['watermark'] }, staff), 200);
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@two/decision', { verdict: 'clear', reason: 'Original.' }, staff), 200);
			await expectStatus(h.do('POST', '/v1/appeals', { platform: 'yt', source_id: '@one', email: 'a@example.test', statement: 'Mine.' }), 201);
			setListRequests(h.db, Math.floor(unix(h.clock) / 3600) - 1, 2400);
			h.clock += 1000;
			const seq = await h.publish();
			const stats = (await (await expectStatus(h.do('GET', '/v1/stats'), 200)).json()) as Stats;
			expect(stats).toEqual({
				sources: { slop: 1, likely_slop: 0, ai_made: 0, disputed: 0, clear: 1 },
				items: 0,
				decisions_7d: 2,
				appeals: { open: 1, median_days: null },
				active_installs: 100,
				list_sequence: seq,
				list_updated_at: new Date(h.clock - (h.clock % 1000)).toISOString().replace('.000Z', 'Z')
			});
		}));
});

describe('review', () => {
	it('enforces the curator limits, bearer tokens and AI evidence (TestCuratorLimitsAndReviewerToken)', () =>
		withHarness(async (h) => {
			const ref = ensureSource(h.db, 'yt', '@gossipnarrated', 'Celebrity Gossip Narrated', unix(h.clock));
			// With derived use the subscriber count makes it large.
			h.store.engine.derived = true;
			setYouTube(
				h.db,
				ref,
				{ channelId: 'UCzzzzzzzzzzzzzzzzzzzz43', handle: '@gossipnarrated', subscribers: 1_200_000, uploadsPerDay: null },
				unix(h.clock)
			);
			const member = h.signIn('maya@example.test');
			const bearer = h.bearer('sam@colander.test', 'curator', 'Sam');

			await expectStatus(h.do('GET', '/v1/review/queue', undefined, bearer), 200);
			expect(await code(await expectStatus(h.do('GET', '/v1/review/queue', undefined, { Authorization: 'Bearer nope' }), 401))).toBe('invalid_token');
			expect(await code(await expectStatus(h.do('GET', '/v1/review/queue', undefined, { Cookie: member }), 403))).toBe('forbidden');
			expect(await code(await expectStatus(h.do('GET', '/v1/review/queue'), 401))).toBe('signed_out');

			const decision = { verdict: 'slop', reason: 'Generated gossip narration.', signals: ['watermark'] };
			const large = await expectStatus(h.do('POST', '/v1/review/sources/yt/@gossipnarrated/decision', decision, bearer), 403);
			expect(await large.json()).toEqual({ error: { code: 'staff_required', message: 'Large sources need staff review.' } });
			// Slop needs AI evidence: without a provenance signal or met provenance layer it is refused.
			for (const v of ['slop', 'likely_slop']) {
				const w = await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', { verdict: v, reason: 'Looks generated.' }, bearer), 400);
				expect(await code(w), v).toBe('ai_evidence_required');
			}
			await expectStatus(
				h.do('POST', '/v1/review/items/yt/abcdefghijk/decision', { verdict: 'slop', reason: 'Looks generated.', source_id: '@smallslopfarm' }, bearer),
				400
			);
			// Curators may decide sources that are not large, by bearer token without CSRF.
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', decision, bearer), 200);
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', { verdict: 'slop', reason: 'x', large: true }, bearer), 403);

			let w = await expectStatus(h.do('POST', '/v1/appeals', { platform: 'yt', source_id: '@smallslopfarm', email: 'a@example.test', statement: 'Not slop.' }), 201);
			const id = ((await w.json()) as { appeal: Appeal }).appeal.id;
			w = await expectStatus(h.do('POST', `/v1/review/appeals/${id}/verify`, undefined, bearer), 403);
			expect(await w.json()).toEqual({ error: { code: 'staff_required', message: 'Appeals need staff review.' } });
			await expectStatus(h.do('POST', `/v1/review/appeals/${id}/resolve`, { outcome: 'denied', reasoning: 'x' }, bearer), 403);

			// An appeal awaiting verification is unproven, so curators may still decide. Once the creator
			// has done their part (pending_manual, then under_review) only staff decide the source.
			const clear = { verdict: 'clear', reason: 'Original work.' };
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', decision, bearer), 200);
			w = await h.do('POST', '/v1/appeals', { platform: 'yt', source_id: '@smallslopfarm', email: 'a@example.test', statement: 'Not slop.' });
			const appeal = (await w.json()) as { appeal: Appeal; secret: string };
			await expectStatus(h.do('POST', `/v1/appeals/${appeal.appeal.id}/verify`, { secret: appeal.secret }), 200);
			w = await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', clear, bearer), 403);
			expect(await w.json()).toEqual({ error: { code: 'staff_required', message: 'Sources with an open appeal need staff review.' } });
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(h.do('POST', `/v1/review/appeals/${appeal.appeal.id}/verify`, undefined, staff), 200);
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', clear, bearer), 403);
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@smallslopfarm/decision', clear, staff), 200);
			// Verifying twice is a state conflict.
			expect(await code(await expectStatus(h.do('POST', `/v1/review/appeals/${appeal.appeal.id}/verify`, undefined, staff), 409))).toBe('appeal_state');
		}));

	it('requires the CSRF header on cookie writes, never on bearer ones', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const body = { verdict: 'clear', reason: 'Original.' };
			const w = await expectStatus(h.do('POST', '/v1/review/sources/yt/@chan/decision', body, { Cookie: staff.Cookie! }), 403);
			expect(await code(w)).toBe('csrf_required');
			await expectStatus(h.do('GET', '/v1/review/queue', undefined, { Cookie: staff.Cookie! }), 200);
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@chan/decision', body, staff), 200);
			// An expired session is signed out.
			h.clock += 31 * DAY;
			expect(await code(await expectStatus(h.do('GET', '/v1/review/queue', undefined, { Cookie: staff.Cookie! }), 401))).toBe('signed_out');
		}));

	it('keeps a pending_manual appeal in the queue and escalates it after 14 days (TestPendingManualAppealInQueue)', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@farm/decision', { verdict: 'ai_made', reason: 'Labelled AI.', signals: ['platform_label'] }, staff), 200);
			const w = await h.do('POST', '/v1/appeals', { platform: 'yt', source_id: '@farm', email: 'a@example.test', statement: 'Mine.' });
			const appeal = (await w.json()) as { appeal: Appeal; secret: string };
			await expectStatus(h.do('POST', `/v1/appeals/${appeal.appeal.id}/verify`, { secret: appeal.secret }), 200);
			h.clock += 15 * DAY;
			await h.store.engine.fullPass(h.clock);
			const items = ((await (await expectStatus(h.do('GET', '/v1/review/queue', undefined, staff), 200)).json()) as { items: QueueItem[] }).items;
			expect(items.map((q) => [q.kind, q.priority])).toEqual([
				['appeal', 1],
				['escalation', 1]
			]);
			expect(items[0]!.summary).toBe('Appeal waiting for a manual check of code ' + appeal.appeal.code);
			expect(items[1]!.summary).toContain('waits for staff to check its code');
		}));

	it('shows a capped source with the scored Slop hint (TestCappedEscalationShowsScoredSlop)', () =>
		withHarness(async (h) => {
			for (let i = 0; i < 6; i++) {
				const t = { ...tag(`slop-${i}`, 'source', '@farm', '', 'slop'), tests: ['low_effort', 'mass_produced'] };
				await expectStatus(h.do('POST', '/v1/tags', { tags: [t] }, installAuth(20 + i)), 200);
			}
			// Twenty uploads a day with derived use, but the channel hides its subscriber count.
			h.store.engine.derived = true;
			const ref = findSource(h.db, 'yt', '@farm')!;
			setYouTube(h.db, ref, { channelId: 'UCzzzzzzzzzzzzzzzzzzzz44', handle: '@farm', subscribers: null, uploadsPerDay: 20 }, unix(h.clock));
			h.clock += 40 * DAY;
			await h.store.engine.fullPass(h.clock);
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			const items = ((await (await expectStatus(h.do('GET', '/v1/review/queue?kind=escalations', undefined, { Cookie: staff.Cookie! }), 200)).json()) as {
				items: QueueItem[];
			}).items;
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ kind: 'escalation', verdict: 'likely_slop', computed_verdict: 'slop', large: false, report_count: 0 });
			expect(items[0]!.summary).toContain('audience size unknown');

			// The review page explains each layer in a sentence.
			const page = (await (await expectStatus(h.do('GET', '/v1/review/sources/yt/@farm', undefined, staff), 200)).json()) as ReviewSourceResponse;
			expect(page.layers.provenance).toEqual({ met: true, signals: ['platform_label'], detail: '6 installs saw a platform AI label.' });
			expect(page.layers.behavior).toEqual({ met: true, signals: ['high_volume'], detail: 'About 20.0 uploads a day over the last 14 days.' });
			expect(page.layers.rubric.detail).toBe('Tests chosen: low effort, mass produced.');
			// Reputation is fresh here: the installs agreed with the consensus verdict, so they weigh more (Go gives the same).
			expect(page.layers.consensus).toEqual({
				met: true,
				signals: ['community_consensus'],
				detail: 'Weighted tags: slop 4.2, AI-made but fine 0.0, not slop 0.0 from 6 installs.'
			});
			expect(page.layers.rubric.signals).toEqual(['rubric_low_effort']);
			expect(page.source.evidence).toEqual({ taggers: 6, tags: { slop: 6, ai_fine: 0, not_slop: 0 }, items_seen: 0, ai_item_share: null, uploads_per_day: null });
			expect(page.history[0]!.reason).toBe(
				'Likely slop. The platform labels it AI-generated, it posts at a volume no person could sustain, taggers found little human effort, and it is tagged as slop by the community. Held at Likely slop until staff review it, because its audience size is unknown.'
			);
			expect(page.source.verdict).toBe('likely_slop');
		}));

	it('queues reports, decides items, dismisses reports and pages the queue', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			for (const [i, reason] of ['Same   voice\nevery video, forty times a day across all of the channel uploads.', 'Second.'].entries()) {
				await expectStatus(h.do('POST', '/v1/reports', { client_id: `r-${i}`, platform: 'yt', source_id: '@chan', reason }, installAuth(1 + i)), 201);
			}
			const queue = (await (await h.do('GET', '/v1/review/queue?kind=reports', undefined, staff)).json()) as { items: QueueItem[]; next_cursor: null };
			expect(queue.next_cursor).toBeNull();
			expect(queue.items).toHaveLength(1);
			expect(queue.items[0]).toMatchObject({ kind: 'report', priority: 3, source_id: '@chan', report_count: 2, verdict: null });
			expect(queue.items[0]!.summary).toBe('2 reports: Same voice every video, forty times a day across all of the…');
			expect(await code(await h.do('GET', '/v1/review/queue?kind=nothing', undefined, staff))).toBe('invalid_kind');
			expect(await code(await h.do('GET', '/v1/review/queue?cursor=-1', undefined, staff))).toBe('invalid_cursor');

			// An item Colander has not seen needs its source; then it is decided on its own.
			const item = { verdict: 'ai_made', reason: 'Labelled AI.', signals: ['platform_label'] };
			expect(await code(await expectStatus(h.do('POST', '/v1/review/items/yt/abcdefghijk/decision', item, staff), 400))).toBe('missing_source');
			expect(await code(await h.do('POST', '/v1/review/items/yt/abcdefghijk/decision', { ...item, large: false, source_id: '@chan' }, staff))).toBe('invalid_large');
			expect(await code(await h.do('POST', '/v1/review/items/yt/short/decision', { ...item, source_id: '@chan' }, staff))).toBe('invalid_target');
			const decided = (await (
				await expectStatus(h.do('POST', '/v1/review/items/yt/abcdefghijk/decision', { ...item, source_id: '@chan' }, staff), 200)
			).json()) as ReviewSourceResponse;
			expect(decided.items).toEqual([
				{ platform: 'yt', id: 'abcdefghijk', verdict: 'ai_made', signals: ['platform_label', 'staff_review'], tags: { slop: 0, ai_fine: 0, not_slop: 0 }, platform_label_reports: 0 }
			]);
			expect(decided.reports.map((r) => [r.status, r.reason])).toEqual([
				['under_review', 'Second.'],
				['under_review', 'Same   voice\nevery video, forty times a day across all of the channel uploads.']
			]);
			expect(decided.layers).toEqual({
				provenance: { met: false, signals: [], detail: 'No AI evidence yet.' },
				behavior: { met: false, signals: [], detail: '1 of 1 items with evidence carry AI evidence.' },
				rubric: { met: false, signals: [], detail: 'Needs slop tags with at least two tests chosen by half the weight.' },
				consensus: { met: false, signals: [], detail: 'Weighted tags: slop 0.0, AI-made but fine 0.0, not slop 0.0 from 0 installs.' }
			});
			expect(decided.source.evidence).toMatchObject({ items_seen: 1, ai_item_share: 1 });
			expect(decided.history[0]).toMatchObject({ target_type: 'item', target_id: 'abcdefghijk', source_id: '@chan', actor: 'staff', actor_name: 'Rae', reason: 'Labelled AI.' });

			const reportId = decided.reports[1]!.id;
			const dismissed = await expectStatus(h.do('POST', `/v1/review/reports/${reportId}/dismiss`, { reason: 'Not enough to go on.' }, staff), 200);
			expect(((await dismissed.json()) as { report: Report }).report).toMatchObject({ id: reportId, status: 'dismissed' });
			expect(await code(await expectStatus(h.do('POST', `/v1/review/reports/${reportId}/dismiss`, { reason: 'Again.' }, staff), 409))).toBe('report_closed');
			expect(await code(await expectStatus(h.do('POST', '/v1/review/reports/rpt_nothing/dismiss', { reason: 'x' }, staff), 404))).toBe('not_found');
			expect(await code(await h.do('POST', `/v1/review/reports/${reportId}/dismiss`, { reason: '' }, staff))).toBe('invalid_reason');

			// Decision bodies are checked before anything is written.
			for (const [body, want] of [
				[{ verdict: 'great', reason: 'x' }, 'invalid_verdict'],
				[{ verdict: 'none', reason: '' }, 'invalid_reason'],
				[{ verdict: 'none', reason: 'x', signals: ['nice'] }, 'invalid_signals'],
				[{ verdict: 'none', reason: 'x', slop_type: 'spam' }, 'invalid_slop_type'],
				[{ verdict: 'none', reason: 'x', tests: ['boring'] }, 'invalid_tests']
			] as const) {
				expect(await code(await expectStatus(h.do('POST', '/v1/review/sources/yt/@chan/decision', body, staff), 400)), want).toBe(want);
			}
			const signals = await h.do('POST', '/v1/review/sources/yt/@chan/decision', { verdict: 'none', reason: 'x', signals: ['nice'] }, staff);
			expect(((await signals.json()) as ErrorBody).error.message).toBe('unknown signal "nice"');
			expect(await code(await h.do('POST', '/v1/review/sources/yt/not%20valid/decision', { verdict: 'none', reason: 'x' }, staff))).toBe('invalid_source');

			// 51 open report sources page at 50.
			for (let i = 0; i < 51; i++) {
				await expectStatus(h.do('POST', '/v1/reports', { client_id: `p-${i}`, platform: 'yt', source_id: `@page${i}`, reason: 'Generated.' }, installAuth(100 + i)), 201);
			}
			const p1 = (await (await h.do('GET', '/v1/review/queue', undefined, staff)).json()) as { items: QueueItem[]; next_cursor: string };
			expect(p1.items).toHaveLength(50);
			expect(p1.next_cursor).toBe('50');
			const p2 = (await (await h.do('GET', '/v1/review/queue?cursor=50', undefined, staff)).json()) as { items: QueueItem[]; next_cursor: null };
			expect(p2.items).toHaveLength(2);
			expect(p2.next_cursor).toBeNull();
			const past = (await (await h.do('GET', '/v1/review/queue?cursor=500', undefined, staff)).json()) as { items: QueueItem[] };
			expect(past.items).toEqual([]);
		}));

	it('resolves a denied appeal and checks the resolve body', () =>
		withHarness(async (h) => {
			const staff = h.reviewer('rae@colander.test', 'staff', 'Rae');
			await expectStatus(h.do('POST', '/v1/review/sources/yt/@farm/decision', { verdict: 'slop', reason: 'Generated.', signals: ['watermark'] }, staff), 200);
			const w = await h.do('POST', '/v1/appeals', { platform: 'yt', source_id: '@farm', email: 'a@example.test', statement: 'Mine.' });
			const id = ((await w.json()) as { appeal: Appeal }).appeal.id;
			expect(await code(await h.do('POST', `/v1/review/appeals/${id}/resolve`, { outcome: 'maybe', reasoning: 'x' }, staff))).toBe('invalid_outcome');
			expect(await code(await h.do('POST', `/v1/review/appeals/${id}/resolve`, { outcome: 'denied', reasoning: ' ' }, staff))).toBe('invalid_reasoning');
			expect(await code(await h.do('POST', '/v1/review/appeals/apl_nothing/resolve', { outcome: 'denied', reasoning: 'x' }, staff))).toBe('not_found');
			expect(await code(await h.do('POST', `/v1/review/appeals/${id}/verify`, '{"x":1}', { ...staff, 'Content-Length': '7' }))).toBe('unknown_field');
			const r = await expectStatus(h.do('POST', `/v1/review/appeals/${id}/resolve`, { outcome: 'denied', reasoning: 'The footage is generated.' }, staff), 200);
			expect(((await r.json()) as { appeal: Appeal }).appeal).toMatchObject({ status: 'denied', outcome: 'denied' });
			expect(getSource(h.db, findSource(h.db, 'yt', '@farm')!)!.state.verdict).toBe('slop');
		}));
});

describe('trial and sync', () => {
	it('gives one trial per install (TestTrialOncePerInstall)', () =>
		withHarness(async (h) => {
			const w = await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(1)), 200);
			const token = ((await w.json()) as { token: string }).token;
			const c = await verifyPlanToken(token, keys);
			expect(c).toMatchObject({ v: 1, plan: 'plus', trial: true, iat: unix(h.clock) });
			expect(c!.exp - c!.iat).toBe(14 * 24 * 3600);
			expect(c!.sub).toMatch(/^trl_[a-z2-9]{16}$/);
			const again = await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(1)), 409);
			expect(await code(again)).toBe('trial_used');
			expect(await code(await expectStatus(h.do('POST', '/v1/trial'), 401))).toBe('install_required');
		}));

	it('gives at most 5 trials a day to one address, and a refused one gives its token back', () =>
		withHarness(async (h) => {
			for (let i = 1; i <= 4; i++) await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(i)), 200);
			expect(await code(await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(1)), 409))).toBe('trial_used');
			await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(5)), 200);
			const refused = await expectStatus(h.do('POST', '/v1/trial', undefined, installAuth(6)), 429);
			expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(3 * 3600);
			expect(h.db.get('SELECT 1 AS used FROM trials WHERE install_hash = ?', hashInstall(installID(6))!), 'nothing was written').toBeUndefined();
			await expectStatus(h.do('POST', '/v1/trial', undefined, { ...installAuth(6), [IP_HASH_HEADER]: 'hash-of-198.51.100.2' }), 200);
		}));

	it('syncs settings by version (TestSyncVersions)', () =>
		withHarness(async (h) => {
			const token = ((await (await h.do('POST', '/v1/trial', undefined, installAuth(1))).json()) as { token: string }).token;
			const plan = { Authorization: 'Plan ' + token };
			expect(await code(await expectStatus(h.do('GET', '/v1/sync'), 401))).toBe('plan_required');
			expect(await code(await expectStatus(h.do('GET', '/v1/sync', undefined, { Authorization: 'Plan x.y' }), 401))).toBe('invalid_plan');

			let w = await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 200);
			expect(await w.json()).toEqual({ data: null, updated_at: null, version: 0 });
			w = await expectStatus(h.do('PUT', '/v1/sync', '{"version": 0, "data": { "strictness": "strict", "n": 1.0 }}', plan), 200);
			// Stored compact, tokens as written.
			expect(await w.text()).toBe('{"data":{"strictness":"strict","n":1.0},"updated_at":"2026-10-01T12:00:00Z","version":1}\n');
			w = await expectStatus(h.do('PUT', '/v1/sync', { version: 0, data: { strictness: 'label' } }, plan), 409);
			expect(await w.json()).toEqual({
				data: { strictness: 'strict', n: 1 },
				error: { code: 'version_conflict', message: 'Settings changed elsewhere. Merge with the current copy and try again.' },
				updated_at: '2026-10-01T12:00:00Z',
				version: 1
			});
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', { version: 1, data: { x: 'a'.repeat(70_000) } }, plan), 413))).toBe('too_large');
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', { version: 1, data: [1] }, plan), 400))).toBe('invalid_data');
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', { version: 1, data: null }, plan), 400))).toBe('invalid_data');
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', { data: {} }, plan), 400))).toBe('invalid_version');
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', { version: -1, data: {} }, plan), 400))).toBe('invalid_version');
			expect(await code(await expectStatus(h.do('PUT', '/v1/sync', '{"version": 1.0, "data": {}}', plan), 400))).toBe('invalid_json');

			h.clock += 15 * DAY;
			expect(await code(await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 401))).toBe('plan_expired');
		}));

	it('stops a paid token as soon as its plan ends', () =>
		withHarness(async (h) => {
			const account = grantRole(h.db, 'maya@example.test', 'member', unix(h.clock));
			const now = unix(h.clock);
			const sub = { id: 'sub_1', accountId: account.id, customerId: 'cus_1', status: 'active', interval: 'month', periodStart: now - 86400, periodEnd: now + 29 * 86400, ending: false, startDate: now - 86400 };
			saveSubscription(h.db, sub, now);
			const key = await SigningKey.fromSeed(b64decode(files.devSeed));
			const token = await issuePlanToken(key, { v: 1, sub: account.id, plan: 'plus', trial: false, iat: now, exp: now + 32 * 86400 });
			const plan = { Authorization: 'Plan ' + token };
			await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 200);
			// past_due runs until the start of the unpaid period plus 3 days of grace.
			saveSubscription(h.db, { ...sub, status: 'past_due' }, now);
			await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 200);
			h.clock += 2 * DAY + 1000;
			expect(await code(await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 403))).toBe('no_plan');
			saveSubscription(h.db, { ...sub, status: 'canceled' }, now);
			h.clock -= 2 * DAY;
			expect(await code(await expectStatus(h.do('GET', '/v1/sync', undefined, plan), 403))).toBe('no_plan');
		}));
});

describe('respond.go and ids.go', () => {
	it('passes the canonical ID contract vectors (TestCanonicalSourceVectors)', () => {
		const vectors = JSON.parse(files.canonicalIds) as { sources: { platform: string; raw: string; source: string | null }[] };
		for (const v of vectors.sources) expect(canonicalSource(v.platform, v.raw) ?? null, `${v.platform} ${v.raw}`).toBe(v.source);
	});

	it('decodes request bodies as strictly as Go', async () => {
		const schema = { name: 'string', flag: 'bool', note: 'string?', list: 'strings', version: 'int?', data: 'raw' } as const;
		const run = (body: BodyInit | null, limit = 1024) => decode(new Request(ORIGIN, { method: 'POST', body }), limit, schema);
		const err = async (body: BodyInit | null) => {
			const res = await run(body);
			return res instanceof Response ? [(await res.json()) as ErrorBody, res.status] : res;
		};
		expect(await run('{"Name":"a","FLAG":true,"note":null,"list":["x",null],"version":7,"data":{ "a" : [1, 2.50] }}')).toEqual({
			name: 'a',
			flag: true,
			note: undefined,
			list: ['x', ''],
			version: 7,
			data: '{ "a" : [1, 2.50] }'
		});
		// Null is the zero struct, as in Go.
		expect(await run('null')).toEqual({ name: '', flag: false, note: undefined, list: undefined, version: undefined, data: '' });
		// The long s folds to S, as Go matches field names.
		expect(await run('{"LI\u017fT":[]}')).toMatchObject({ list: [] });
		expect(await run('{"name":"\\ud800"}')).toMatchObject({ name: '�' });
		for (const bad of ['', '[]', '"x"', '{"name":1}', '{"flag":"yes"}', '{"list":[1]}', '{"version":1.5}', '{"version":9223372036854775808}', '{} {}', '﻿{}']) {
			expect(await err(bad), bad).toEqual([{ error: { code: 'invalid_json', message: 'The request body is not valid JSON for this route.' } }, 400]);
		}
		expect(await err('{"name":1,"extra":2}')).toEqual([{ error: { code: 'invalid_json', message: 'The request body is not valid JSON for this route.' } }, 400]);
		expect(await err('{"extra\\n":2,"name":1}')).toEqual([
			{ error: { code: 'unknown_field', message: 'The request has a field this API does not accept: "extra\\n".' } },
			400
		]);
		expect(await err('{"name":"' + 'x'.repeat(1100) + '"}')).toEqual([
			{ error: { code: 'too_large', message: 'The request body is larger than 1024 bytes.' } },
			413
		]);
	});

	it("formats as Go's fmt and strconv do", () => {
		expect(goFixed(0.25, 1)).toBe('0.2');
		expect(goFixed(0.75, 1)).toBe('0.8');
		expect(goFixed(0.05, 1)).toBe('0.1');
		expect(goFixed(14.2, 1)).toBe('14.2');
		expect(goFixed(0, 1)).toBe('0.0');
		expect(goFixed(9.96, 1)).toBe('10.0');
		expect(goFixed(2.5, 0)).toBe('2');
		expect(goQuote('a"b\\c\n\x07\x7f­\u{1F600}é')).toBe('"a\\"b\\\\c\\n\\a\\x7f\\u00ad\u{1F600}é"');
		expect(parseRFC3339('2026-10-03T12:00:00Z')).toBe(Date.UTC(2026, 9, 3, 12) / 1000);
		expect(parseRFC3339('2026-10-03T14:00:00.5+02:00')).toBe(Date.UTC(2026, 9, 3, 12) / 1000 + 0.5);
		for (const bad of ['2026-02-29T00:00:00Z', '2026-10-03T24:00:00Z', '2026-10-03 12:00:00Z', '2026-10-03T12:00:00', 'yesterday']) {
			expect(parseRFC3339(bad), bad).toBeUndefined();
		}
		expect(parseRFC3339('2028-02-29T00:00:00Z')).toBe(Date.UTC(2028, 1, 29) / 1000);
	});

	it('normalizes email addresses as Go does', () => {
		expect(normalizeEmail('  Maya@Example.TEST ')).toBe('maya@example.test');
		expect(normalizeEmail('o.k+tag@[192.0.2.1]')).toBe('o.k+tag@[192.0.2.1]');
		expect(normalizeEmail('josé@exämple.test')).toBe('josé@exämple.test');
		for (const bad of ['', 'a', 'a@', '@b', 'a@b@c', '.a@b', 'a..b@c', 'a.@b', '"a"@b', 'A <a@b>', 'a@b (c)', 'a b@c', 'a@[1.2.3]', 'a@[01.2.3.4]', 'x'.repeat(250) + '@b.cd']) {
			expect(normalizeEmail(bad), bad).toBeUndefined();
		}
		expect(hashToken('x')).toBe(hex(sha256(utf8('x'))));
	});
});
