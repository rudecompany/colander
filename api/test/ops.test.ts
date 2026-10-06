// The ops channel (src/ops.ts) through the edge as the workflows call it, and the Store's half of
// each command: status for the probes, grant-role, import-seed (Go's TestImportSeed), sign-config
// against the contract fixture, the restores with their restart, publication and cache purge,
// and the dump drill.
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { b64decode, hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { CONFIG_CONTEXT, importKeys, verifyEnvelope } from '@colander/shared/signing';
import worker from '../src/index';
import { AUDIT_EXPORTED, AUDIT_PREFIX, dump, DUMP_PREFIX, dumpKey } from '../src/backup';
import { STATUS } from '../src/jobs';
import { ADAPTER_CONFIG_PATH, ADMIN_BOOTSTRAPPED, PITR_PREFIX, SEED_PREFIX, storeOps } from '../src/ops';
import { addPasskey, audit, createSession, ensureAccount, getAccount, grantRole, holdRequest, revokeCredentials } from '../src/store/accounts';
import { claimPairing, createPairing } from '../src/store/pairings';
import { log } from '../src/store/verdicts';
import { findSource, getSource, sourceRefs } from '../src/store/sources';
import { SNAPSHOT_KEY } from '../src/store/list';
import type { Store } from '../src/store/store';
import { accessHeaders, ADMIN_ORIGIN, opsAuth, RUN_SHA } from './tokens';

const files = inject('contract');
const keys = await importKeys([files.devPublicKey]);
const T = 1_900_000_000_000;
const S = T / 1000;

let client = 0;
/** Workers Cache as the edge sees it in ctx.cache: absent in local runtimes, so tests set it. */
let edgeCache: CacheContext | undefined;
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** POST /ops/<command> through the edge's fetch handler with a GitHub OIDC token from the Ops workflow on main. */
async function op(command: string, body: unknown = {}, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const request = new IncomingRequest(`https://getcolander.com/ops/${command}`, {
		method: 'POST',
		body: typeof body === 'string' ? body : JSON.stringify(body),
		...init,
		headers: { ...(await opsAuth()), 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${++client % 250}`, ...init.headers }
	} as RequestInit<IncomingRequestCfProperties>);
	const res = await worker.fetch(request, env, { waitUntil: () => {}, passThroughOnException: () => {}, cache: edgeCache } as unknown as ExecutionContext);
	expect(res.headers.get('Content-Type')).toBe('application/json');
	expect(res.headers.get('Cache-Control')).toBe('no-store');
	return { status: res.status, body: await res.json() };
}

const primary = () => env.STORE.getByName('primary');
let n = 0;
const fresh = () => env.STORE.getByName(`ops-${++n}`);

/** Runs one Store command directly, with the Store's clock at time. */
const inStore = (stub: DurableObjectStub<Store>, time: number, command: string, args: Record<string, unknown> = {}) =>
	runInDurableObject(stub, (store: Store, state) => {
		store.now = () => time;
		return storeOps(store, state, env, command, args);
	});

async function resetPrimary(): Promise<void> {
	await runInDurableObject(primary(), async (store: Store, state) => {
		store.db.tx(() => {
			store.db.run('PRAGMA defer_foreign_keys = ON');
			for (const t of ['tags', 'items', 'source_aliases', 'decision_log', 'decisions', 'escalations', 'reports', 'appeals', 'sources', 'seed_imports', 'installs', 'accounts', 'adapter_configs', 'list_sequences', 'jobs']) {
				store.db.run(`DELETE FROM ${t}`);
			}
		});
		for (const key of [...Object.values(STATUS), ADMIN_BOOTSTRAPPED, AUDIT_EXPORTED]) state.storage.kv.delete(key);
		await state.storage.deleteAlarm();
	});
	await env.LISTS.delete(SNAPSHOT_KEY);
	for (const prefix of [DUMP_PREFIX, PITR_PREFIX, SEED_PREFIX, AUDIT_PREFIX]) for (const o of (await env.BACKUPS.list({ prefix })).objects) await env.BACKUPS.delete(o.key);
}

beforeEach(resetPrimary);
afterEach(() => {
	vi.restoreAllMocks();
	edgeCache = undefined;
});

describe('the channel', () => {
	it('answers only POST with a JSON object body, for the contract commands', async () => {
		expect((await op('nothing')).body.error.code).toBe('unknown_command');
		expect((await op('restart')).status, 'internal Store commands are not exposed').toBe(404);
		expect((await op('status', undefined, { method: 'GET', body: undefined })).status).toBe(405);
		for (const body of ['not json', '[]', '"x"', 'null']) {
			const res = await op('status', body);
			expect(res.status).toBe(400);
			expect(res.body.error.code).toBe('invalid_body');
		}
	});
});

describe('status', () => {
	it('reports the heads, the job ages and how long the oldest list change has waited', async () => {
		await runInDurableObject(primary(), (store: Store, state) => {
			state.storage.kv.put(STATUS.pass, { at: T - 90_000, ms: 1, sources: 1, changes: 0, rowsRead: 1234 });
			state.storage.kv.put(STATUS.dump, { at: T - 3_600_000, ms: 870 });
			store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?), (?, ?)', S - 500, S - 500, S - 100, S - 100);
		});
		await env.LISTS.put(SNAPSHOT_KEY, 'x', { customMetadata: { seq: String(S - 500) } });
		expect((await inStore(primary(), T, 'status')).body).toEqual({
			head_seq: S - 100,
			r2_seq: S - 500,
			pass_age_s: 90,
			// R2 lacks the sequence published 100 seconds ago.
			publish_lag_s: 100,
			dump_age_s: 3600,
			dump_ms: 870,
			rows_read_last_pass: 1234
		});

		await env.LISTS.put(SNAPSHOT_KEY, 'x', { customMetadata: { seq: String(S - 100) } });
		expect((await inStore(primary(), T, 'status')).body.publish_lag_s, 'R2 holds the head').toBe(0);
		// A verdict change after the head that no sequence holds yet waits too.
		await runInDurableObject(primary(), (store: Store) => {
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at, verdict, changed_at) VALUES ('yt', '@changed', 1, 'slop', ?)", S - 40);
		});
		expect((await inStore(primary(), T, 'status')).body.publish_lag_s).toBe(40);

		// Through the edge, before any pass or dump: the probes fail on the nulls.
		await resetPrimary();
		const res = await op('status');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ head_seq: 0, r2_seq: 0, pass_age_s: null, publish_lag_s: 0, dump_age_s: null, dump_ms: null, rows_read_last_pass: null });
	});
});

describe('grant-role', () => {
	beforeEach(() => runInDurableObject(primary(), (store: Store) => store.db.run("DELETE FROM accounts")));

	it('sets a role on a normalized email, creating the account, and audits it with the GitHub run', async () => {
		const res = await op('grant-role', { email: '  Sam@Example.COM ', role: 'curator' });
		expect(res.status).toBe(200);
		expect(res.body.account).toMatchObject({ email: 'sam@example.com', role: 'curator', display_name: null });
		expect(res.body.account.id).toMatch(/^acc_[a-z2-9]{16}$/);
		expect(res.body.account.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
		expect(res.body.message).toBe(`sam@example.com (${res.body.account.id}) is now curator. It needs a passkey invite from the admin host before it can review.`);
		const again = await op('grant-role', { email: 'sam@example.com', role: 'staff' });
		expect(again.body.account).toMatchObject({ id: res.body.account.id, role: 'staff' });
		const audited = await runInDurableObject(primary(), (store: Store) =>
			store.db.all("SELECT action, host, actor_sub, request_id, reason, target, after FROM audit_log WHERE target = ? OR action LIKE 'ops:%' ORDER BY id DESC LIMIT 2", res.body.account.id)
		);
		expect(audited).toEqual([
			{ action: 'role_changed', host: 'ops', actor_sub: 'github:slantview', request_id: '4242', reason: null, target: res.body.account.id, after: 'staff' },
			{ action: 'ops:grant-role', host: 'ops', actor_sub: 'github:slantview', request_id: '4242', reason: '.github/workflows/ops.yml', target: null, after: null }
		]);
	});

	it('grants staff and admin only until it first grants admin, then moves only members and curators, even with no admin left', async () => {
		const owner = await op('grant-role', { email: 'owner@example.com', role: 'admin' });
		expect(owner.status).toBe(200);
		// The only admin cannot invite their own account: they review on the admin host.
		expect(owner.body.message).toBe(
			`owner@example.com (${owner.body.account.id}) is now admin. It reviews on the admin host through Access; a passkey for getcolander.com needs an invite from another admin.`
		);
		for (const [args, status] of [
			[{ email: 'new@example.com', role: 'staff' }, 403],
			[{ email: 'new@example.com', role: 'admin' }, 403],
			// No ops run can demote the admin, or the last admin would be gone.
			[{ email: 'owner@example.com', role: 'member' }, 403],
			[{ email: 'new@example.com', role: 'curator' }, 200],
			[{ email: 'new@example.com', role: 'member' }, 200]
		] as const) {
			const res = await op('grant-role', args);
			expect(res.status, JSON.stringify(args)).toBe(status);
			if (status === 403) expect(res.body.error.code).toBe('admin_exists');
		}
		// The admin is gone (a restore, a slip in the database): the bootstrap stays closed.
		await runInDurableObject(primary(), (store: Store) => store.db.run("DELETE FROM accounts WHERE role = 'admin'"));
		const again = await op('grant-role', { email: 'eve@example.com', role: 'admin' });
		expect([again.status, again.body.error.code]).toEqual([403, 'admin_exists']);
	});

	it('tells a new staff member how they review', async () => {
		const res = await op('grant-role', { email: 'rae@example.com', role: 'staff' });
		expect(res.body.message).toBe(
			`rae@example.com (${res.body.account.id}) is now staff. It reviews on the admin host through Access; a passkey for getcolander.com needs an invite from an admin.`
		);
	});

	it("trims as Go's strings.TrimSpace did: U+0085 is space, a byte order mark is not", async () => {
		expect((await op('grant-role', { email: '\u0085Nel@Example.com\u3000', role: 'member' })).body.account.email).toBe('nel@example.com');
		expect((await op('grant-role', { email: '\ufeffbom@example.com', role: 'member' })).body.account.email).toBe('\ufeffbom@example.com');
	});

	it.each([
		[{ email: 'Sam <sam@example.com>', role: 'staff' }, 'invalid_email', '"Sam <sam@example.com>" is not an email address.'],
		[{ email: 'not-an-email', role: 'staff' }, 'invalid_email', '"not-an-email" is not an email address.'],
		[{ role: 'staff' }, 'invalid_email', '"" is not an email address.'],
		[{ email: 'sam@example.com', role: 'owner' }, 'invalid_role', 'role must be member, curator, staff or admin, not "owner".']
	])('refuses %j', async (args, code, message) => {
		const res = await op('grant-role', args);
		expect(res.status).toBe(400);
		expect(res.body.error).toEqual({ code, message });
	});
});

describe('pin-subject', () => {
	const staffMe = async (subject: string) =>
		(await exports.default.fetch(new Request(`${ADMIN_ORIGIN}/v1/admin/me`, { headers: await accessHeaders('rae@example.com', { subject }) }))).status;

	it('binds a staff account to the A3T subject the owner checked, so no other subject ever signs in as it', async () => {
		const rae = await runInDurableObject(primary(), (store: Store) => grantRole(store.db, 'rae@example.com', 'staff', S, { host: 'job' }));
		const res = await op('pin-subject', { email: ' Rae@Example.com', subject: 'a3t-rae' });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ account: { id: rae.id, role: 'staff', access_pinned: true }, message: `rae@example.com (${rae.id}) now signs in to the admin host only as a3t:a3t-rae.` });
		// The first A3T sign-in no longer decides it.
		expect(await staffMe('a3t-mallory')).toBe(403);
		expect(await staffMe('a3t-rae')).toBe(200);
		// A new A3T identity after a lost one is pinned again; the old subject stops working.
		expect((await op('pin-subject', { email: 'rae@example.com', subject: 'a3t-rae-2' })).status).toBe(200);
		expect(await staffMe('a3t-rae')).toBe(403);
		expect(
			await runInDurableObject(primary(), (store: Store) =>
				store.db.all("SELECT actor_sub, before, after FROM audit_log WHERE action = 'access_pinned' AND host = 'ops' ORDER BY id")
			)
		).toEqual([
			{ actor_sub: 'github:slantview', before: null, after: 'a3t:a3t-rae' },
			{ actor_sub: 'github:slantview', before: 'a3t:a3t-rae', after: 'a3t:a3t-rae-2' }
		]);
	});

	it('refuses members, curators, unknown addresses, a blank subject and one another account holds', async () => {
		await runInDurableObject(primary(), (store: Store) => {
			grantRole(store.db, 'sam@example.com', 'curator', S, { host: 'job' });
			grantRole(store.db, 'rae@example.com', 'staff', S, { host: 'job' });
			grantRole(store.db, 'lee@example.com', 'staff', S, { host: 'job' });
		});
		expect((await op('pin-subject', { email: 'rae@example.com', subject: 'a3t-rae' })).status).toBe(200);
		for (const [args, status, code] of [
			[{ email: 'sam@example.com', subject: 'a3t-sam' }, 400, 'not_staff'],
			[{ email: 'nobody@example.com', subject: 'a3t-x' }, 400, 'not_staff'],
			[{ email: 'lee@example.com', subject: ' ' }, 400, 'invalid_subject'],
			[{ email: 'lee@example.com', subject: 'a\nb' }, 400, 'invalid_subject'],
			[{ email: 'lee', subject: 'a3t-lee' }, 400, 'invalid_email'],
			[{ email: 'lee@example.com', subject: 'a3t-rae' }, 409, 'subject_taken']
		] as const) {
			const res = await op('pin-subject', args);
			expect([res.status, res.body.error.code], JSON.stringify(args)).toEqual([status, code]);
		}
	});
});

describe('import-seed', () => {
	const seed = '! A tiny synthetic list\n@SlopFarmOne\r\n\nUCzzzzzzzzzzzzzzzzzzzzz9\nnot a channel\n';
	const fields = { file: seed, list: 'blocklist', source_name: 'Open Seed List', license: 'CC0-1.0' };
	const how = 'Ask its maintainer for written permission and import it as LicenseRef-written-grant with permission_doc.';
	const refused = `Refusing to import: the list's license does not allow use in a paid product. Non-commercial, no-derivatives, share-alike and GPL lists are refused. ${how}`;
	let seeds = 0;
	/** Puts a seed object in the backup bucket, as the runbook does with wrangler, and returns its key. */
	const put = async (body: unknown): Promise<string> => {
		const key = `${SEED_PREFIX}${++seeds}.json`;
		await env.BACKUPS.put(key, typeof body === 'string' ? body : JSON.stringify(body));
		return key;
	};
	const untouched = async () =>
		expect(await runInDurableObject(primary(), (store: Store) => [sourceRefs(store.db), store.db.all('SELECT * FROM seed_imports')])).toEqual([[], []]);

	it.each([
		['CC BY-NC 4.0', 'license_refused', refused],
		['CC-BY-NC-SA-4.0', 'license_refused', refused],
		['CC-BY-ND-4.0', 'license_refused', refused],
		['CC-BY-SA-4.0', 'license_refused', refused],
		['GPL-3.0-only', 'license_refused', refused],
		['', 'license_refused', `Refusing to import: the list has no license, and unlicensed lists may not be used. ${how}`],
		['NOASSERTION', 'license_refused', `Refusing to import: the list has no license, and unlicensed lists may not be used. ${how}`],
		['Apache-2.0', 'invalid_license', 'license must be one of CC0-1.0, CC-BY-4.0, MIT, LicenseRef-written-grant.']
	])('refuses a list licensed %j, and touches nothing', async (license, code, message) => {
		const res = await op('import-seed', { key: await put({ ...fields, license }) });
		expect(res).toEqual({ status: 400, body: { error: { code, message } } });
		await untouched();
	});

	it('needs the credit CC BY and MIT ask for, the written grant, and the other fields of the object', async () => {
		for (const [bad, message] of [
			[{ ...fields, file: '' }, 'file and source_name are required.'],
			[{ ...fields, source_name: ' ' }, 'file and source_name are required.'],
			[{ ...fields, list: 'greylist' }, 'list must be blocklist or warnlist.'],
			[{ ...fields, license: 'CC-BY-4.0' }, 'CC-BY-4.0 and MIT need attribution: the credit or copyright notice the license asks for.'],
			[{ ...fields, license: 'mit' }, 'CC-BY-4.0 and MIT need attribution: the credit or copyright notice the license asks for.'],
			[{ ...fields, license: 'LicenseRef-written-grant' }, 'LicenseRef-written-grant needs permission_doc: where the written grant is kept.'],
			['not json', ' does not hold a JSON object.'],
			[['a list'], ' does not hold a JSON object.']
		] as const) {
			const key = await put(bad);
			expect((await op('import-seed', { key })).body.error.message).toBe(message.startsWith(' ') ? key + message : message);
		}
		await untouched();
	});

	// The ops workflow logs its arguments and answer where anyone can read them, so a list, its name
	// and its license only ever travel in a private object of the backup bucket.
	it('takes only the key of an object under seeds/ in the backup bucket, and answers without naming the list', async () => {
		const only = `import-seed takes only key: an object under ${SEED_PREFIX} in the backup bucket that holds the list and its license. The ops run log is public, so nothing about a list may be in the arguments.`;
		for (const args of [fields, { ...fields, key: await put(fields) }, {}, { key: 'dumps/2026-10-03T03:17:00.000Z.sql.gz' }, { key: SEED_PREFIX }]) {
			expect(await op('import-seed', args)).toEqual({ status: 400, body: { error: { code: 'invalid_args', message: only } } });
		}
		expect(await op('import-seed', { key: 'seeds/none.json' })).toEqual({ status: 404, body: { error: { code: 'no_seed', message: 'There is no object seeds/none.json in the backup bucket.' } } });
		await untouched();
		const res = await op('import-seed', { key: await put({ ...fields, license: 'CC-BY-4.0', attribution: 'Open Seed List by Example Maintainer, CC BY 4.0' }) });
		expect(res.status).toBe(200);
		expect(JSON.stringify(res.body)).not.toMatch(/open seed list|example maintainer|CC-BY|blocklist/i);
	});

	// Seed entries are review leads: the scoring pass gives them no verdict and puts them in the
	// review queue, and the run is recorded with its license, credit and file hash.
	it('imports the whole file in one transaction as review leads, recorded for audits', async () => {
		const stub = fresh();
		// A reviewer named the list in the public log before Colander imported it.
		await runInDurableObject(stub, (store: Store) => {
			store.db.run("INSERT INTO decision_log (at, platform, target_type, target_id, source_key, reason, actor) VALUES (1, 'yt', 'source', '@x', '@x', 'Also on the open seed list.', 'staff')");
		});
		const key = await put({ ...fields, license: 'cc-by-4.0', attribution: 'Open Seed List by Example Maintainer, CC BY 4.0' });
		const res = await inStore(stub, T, 'import-seed', { key });
		expect(res).toEqual({
			status: 200,
			body: {
				imported: 2,
				skipped: 1,
				batch: 1,
				message: 'Imported 2 YouTube channels as review leads, skipped 1 lines. They never give a verdict; the scoring pass now puts them in the review queue.'
			}
		});
		await runInDurableObject(stub, async (store: Store) => {
			store.now = () => T;
			expect(store.db.all('SELECT reason, reason_original FROM decision_log')).toEqual([{ reason: 'Also on the [withheld].', reason_original: 'Also on the open seed list.' }]);
			store.db.run('DELETE FROM decision_log');
			await store.engine.fullPass(T);
			const refs = sourceRefs(store.db);
			expect(refs).toHaveLength(2);
			for (const ref of refs) {
				const src = getSource(store.db, ref)!;
				expect(src).toMatchObject({ importSource: 'Open Seed List', importLicense: 'CC-BY-4.0', importList: 'blocklist', importBatch: 1 });
				expect(src.state).toMatchObject({ verdict: '', flags: 0 });
			}
			expect(findSource(store.db, 'yt', '@slopfarmone'), 'the handle is lowercased to its canonical form').toBeDefined();
			expect(log(store.db, { limit: 1 })).toEqual([]);
			expect(store.db.all("SELECT kind FROM escalations WHERE resolved_at IS NULL")).toEqual([{ kind: 'seed' }, { kind: 'seed' }]);
			const sha = hex(sha256(utf8(seed)));
			expect(store.db.all('SELECT * FROM seed_imports')).toEqual([
				{
					id: 1,
					source_name: 'Open Seed List',
					list: 'blocklist',
					license: 'CC-BY-4.0',
					attribution: 'Open Seed List by Example Maintainer, CC BY 4.0',
					permission_doc: null,
					sha256: sha,
					entries: 2,
					imported_at: S,
					cleared_at: null
				}
			]);
		});
		const grant = await inStore(stub, T, 'import-seed', {
			key: await put({ file: '@aimadebutfine\n', list: 'warnlist', source_name: 'Partner List', license: 'LicenseRef-written-grant', permission_doc: 'contracts/partner-2026-10.pdf' })
		});
		expect(grant.body).toMatchObject({ imported: 1, batch: 2 });
		await runInDurableObject(stub, (store: Store) => {
			expect(store.db.get("SELECT license, permission_doc FROM seed_imports WHERE id = 2")).toEqual({ license: 'LicenseRef-written-grant', permission_doc: 'contracts/partner-2026-10.pdf' });
		});
	});

	it("reads lines as Go's import-seed did: a byte order mark stays, so that line is skipped; U+0085 is trimmed", async () => {
		const stub = fresh();
		const res = await inStore(stub, T, 'import-seed', { key: await put({ ...fields, file: '\ufeff@BomFirst\n@NelChannel\u0085\n\u2003@Spaced\u3000\n' }) });
		expect(res.body).toMatchObject({ imported: 2, skipped: 1 });
		await runInDurableObject(stub, (store: Store) => {
			expect(findSource(store.db, 'yt', '@nelchannel')).toBeDefined();
			expect(findSource(store.db, 'yt', '@spaced')).toBeDefined();
			expect(findSource(store.db, 'yt', '@bomfirst')).toBeUndefined();
		});
	});

	it('starts the scoring pass at once in the primary Store', async () => {
		const res = await inStore(primary(), T, 'import-seed', { key: await put(fields) });
		expect(res.status).toBe(200);
		await runInDurableObject(primary(), async (store: Store, state) => {
			expect(store.db.all('SELECT name, due_at FROM jobs')).toEqual([{ name: 'pass', due_at: T }]);
			expect(await state.storage.getAlarm()).toBe(T);
		});
	});
});

describe('sign-config', () => {
	const RAW = `https://raw.githubusercontent.com/rudecompany/colander/${RUN_SHA}/${ADAPTER_CONFIG_PATH}`;
	/** GitHub serving the repository file at the run's commit, and nothing else. */
	function github(file: string, status = 200) {
		const real = globalThis.fetch.bind(globalThis);
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
			String(input).startsWith('https://raw.githubusercontent.com/') ? new Response(file, { status }) : real(input, init)
		);
	}
	const stored = () => runInDurableObject(primary(), (store: Store) => store.db.get<{ version: number; envelope: string }>('SELECT version, envelope FROM adapter_configs'));

	it('signs the adapter configuration committed at the run\'s commit byte for byte with the Worker key, as the contract fixture shows', async () => {
		const file = '{"version":7,"note":"contract fixture"}';
		const fetch = github(file);
		const res = await op('sign-config', {});
		expect(res.status).toBe(200);
		expect(fetch.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith('https://raw.'))).toEqual([RAW]);
		expect(res.body).toEqual({
			version: 7,
			key_id: '941afaf31a9c228e',
			message: 'Signed adapter configuration version 7 with key 941afaf31a9c228e. GET /v1/config/adapters now serves it.',
			commit: RUN_SHA
		});
		const signed = await stored();
		expect(signed!.version).toBe(7);
		expect(signed!.envelope).toBe(JSON.stringify(JSON.parse(files.configEnvelope)));
		expect(new TextDecoder().decode(b64decode(JSON.parse(signed!.envelope).payload))).toBe(file);
		expect(await verifyEnvelope(JSON.parse(signed!.envelope), CONFIG_CONTEXT, keys)).toEqual(JSON.parse(file));
	});

	it('never signs text from the run: a file argument, a token without a commit, or a file GitHub does not serve is refused', async () => {
		github('{"version": 3}');
		const sent = await op('sign-config', { file: '{"version": 99, "selectors": "anything"}' });
		expect([sent.status, sent.body.error.code]).toEqual([400, 'invalid_args']);
		const noCommit = await op('sign-config', {}, { headers: await opsAuth({ sha: undefined }) });
		expect([noCommit.status, noCommit.body.error.code]).toEqual([400, 'no_commit']);
		vi.restoreAllMocks();
		github('Not Found', 404);
		const missing = await op('sign-config', {});
		expect([missing.status, missing.body.error.code]).toEqual([502, 'repository_unavailable']);
		expect(await stored()).toBeUndefined();
	});

	it.each([
		['{"version": 12, "selectors": {"version": "x"}}', 12],
		['{"Version": "8"}', 8],
		['{"version": 1, "VERSION": 3}', 3],
		['{"version": -2}', -2],
		// Go's json.Decoder read the first object and ignored the rest; the port keeps that.
		['  {"version": 9, "s": "}{\\"x"} and then {not json', 9]
	])('reads the version of %s as Go did', async (file, version) => {
		const res = await inStore(fresh(), T, 'sign-config', { file });
		expect(res.status).toBe(200);
		expect(res.body.version).toBe(version);
	});

	it.each([
		['[1]', 'The file is not a JSON object.'],
		['not json', 'The file is not a JSON object.'],
		['{"version": true}', 'The file is not a JSON object.'],
		['{"version": "seven"}', 'The file is not a JSON object.'],
		['null', 'The file needs a top-level integer version.'],
		['{"note": 1}', 'The file needs a top-level integer version.'],
		['{"version": 7.5}', 'The file needs a top-level integer version.'],
		['{"version": 7.0}', 'The file needs a top-level integer version.'],
		['{"version": 1e3}', 'The file needs a top-level integer version.'],
		['{"version": "7.5"}', 'The file needs a top-level integer version.'],
		['', 'file is required: the adapter configuration JSON.']
	])('refuses %s', async (file, message) => {
		const res = await inStore(fresh(), T, 'sign-config', { file });
		expect(res.status).toBe(400);
		expect((res.body.error as { message: string }).message).toBe(message);
	});
});

describe('restores', () => {
	/** Puts a source on the list and publishes, so R2 holds a head. */
	async function publishOne(alias: string): Promise<number> {
		return runInDurableObject(primary(), async (store: Store) => {
			store.db.run("INSERT INTO sources (platform, canonical_id, created_at, verdict, changed_at) VALUES ('yt', ?, 1, 'slop', 1)", alias);
			const id = store.db.get<{ id: number }>('SELECT id FROM sources WHERE canonical_id = ?', alias)!.id;
			store.db.run("INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', ?, ?)", alias, id);
			return (await store.publisher.publish(Date.now())).seq;
		});
	}

	it('pitr-restore needs the time typed twice, in the last 30 days', async () => {
		const now = new Date(Date.now() - 60_000).toISOString();
		for (const [args, code] of [
			[{ at: now }, 'confirmation_required'],
			[{ at: now, confirm: now.replace('Z', '+00:00') }, 'confirmation_required'],
			[{ at: 'yesterday', confirm: 'yesterday' }, 'invalid_time'],
			[{ at: '2020-01-01T00:00:00Z', confirm: '2020-01-01T00:00:00Z' }, 'invalid_time'],
			[{ at: '2999-01-01T00:00:00Z', confirm: '2999-01-01T00:00:00Z' }, 'invalid_time']
		] as const) {
			const res = await op('pitr-restore', args);
			expect(res.status, JSON.stringify(args)).toBe(400);
			expect(res.body.error.code).toBe(code);
		}
	});

	/** Local runtimes keep no history, so the two PITR calls are stand-ins; the marker shows a restart. */
	const standIns = (asked: number[] = []) =>
		runInDurableObject(primary(), (store: Store, state) => {
			Object.assign(state.storage, {
				getBookmarkForTime: async (t: number) => (asked.push(t), 'bookmark-at'),
				onNextSessionRestoreBookmark: async (b: string) => `undo-before-${b}`
			});
			(store as unknown as { marker: string }).marker = 'old instance';
		});
	const marker = () => runInDurableObject(primary(), (store: Store) => (store as unknown as { marker?: string }).marker);

	it('pitr-restore arms the bookmark, restarts the Store, publishes above R2 and purges the edge cache', async () => {
		const erased = await publishOne('@before');
		const at = new Date(Date.now() - 3_600_000).toISOString();
		const asked: number[] = [];
		await standIns(asked);
		const purge = vi.fn(async () => ({ success: true, errors: [] }));
		edgeCache = { purge, invalidate: purge } as unknown as CacheContext;
		const res = await op('pitr-restore', { at, confirm: at });
		expect(res.status).toBe(200);
		expect(asked).toEqual([Date.parse(at)]);
		expect(res.body).toMatchObject({ at, bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at', r2_seq: res.body.head_seq, cache_purged: true });
		expect(res.body.head_seq).toBeGreaterThanOrEqual(erased);
		expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
		expect(await marker(), 'the Store restarted').toBeUndefined();
		const records = (await env.BACKUPS.list({ prefix: PITR_PREFIX })).objects;
		expect(records).toHaveLength(1);
		expect(await (await env.BACKUPS.get(records[0]!.key))!.json()).toEqual({ bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at' });
	});

	it('pitr-restore restarts the Store in the same call that arms it, so no armed restore waits for a later restart', async () => {
		await standIns();
		const record = `${PITR_PREFIX}direct.json`;
		await expect(inStore(primary(), T, 'pitr-restore', { at: T - 3_600_000, record })).rejects.toThrow();
		expect(await marker(), 'the Store restarted without a second call').toBeUndefined();
		expect(await (await env.BACKUPS.get(record))!.json()).toEqual({ bookmark: 'bookmark-at', undo_bookmark: 'undo-before-bookmark-at' });
	});

	/** The rows of every audit copy in the backup bucket, oldest first. */
	const copies = async () => {
		const rows: { id: number; action: string }[] = [];
		for (const o of (await env.BACKUPS.list({ prefix: AUDIT_PREFIX })).objects) {
			for (const line of (await (await env.BACKUPS.get(o.key))!.text()).split('\n')) if (line) rows.push(JSON.parse(line));
		}
		return rows;
	};

	it('pitr-restore copies the audit log, its own row included, to the locked copies before it arms', async () => {
		await standIns();
		await runInDurableObject(primary(), (store: Store) => audit(store.db, { host: 'main', action: 'signed_in', target: 'acc_late' }, Math.floor(Date.now() / 1000)));
		const at = new Date(Date.now() - 3_600_000).toISOString();
		const res = await op('pitr-restore', { at, confirm: at });
		expect(res.status).toBe(200);
		// Every row so far is copied (the log keeps those of earlier tests too); the newest two are these.
		expect((await copies()).slice(-2).map((r) => r.action)).toEqual(['signed_in', 'ops:pitr-restore']);
		// The stand-ins restore nothing, so the log still holds every row and none comes back twice.
		expect(res.body.audit_restored).toBe(0);
		expect(await runInDurableObject(primary(), (store: Store) => store.db.all("SELECT action FROM audit_log WHERE target = 'acc_late'"))).toEqual([{ action: 'signed_in' }]);
	});

	it('reapply-audit puts back the copied rows from the restore point on that the restored log lacks, in order and once', async () => {
		const stub = fresh();
		// A day no other test's copies carry: 2030-03-17.
		const since = T;
		const s = since / 1000;
		const row = (id: number, at: number, action: string) => ({
			id, at, actor_id: null, actor_sub: 'github:slantview', actor_email: null, host: 'ops', action, target: 'acc_1', before: null, after: null, reason: null, request_id: '4242'
		});
		const ndjson = (...rows: object[]) => rows.map((r) => JSON.stringify(r) + '\n').join('');
		await env.BACKUPS.put(`${AUDIT_PREFIX}2030-03-16-000000000001.ndjson`, ndjson(row(1, s - 86_400, 'old')));
		await env.BACKUPS.put(`${AUDIT_PREFIX}2030-03-17-000000000002.ndjson`, ndjson(row(2, s - 60, 'kept'), row(3, s + 5, 'lost'), row(4, s + 9, 'ops:pitr-restore')));
		// The restored log ends at the restore point.
		await runInDurableObject(stub, (store: Store) => {
			audit(store.db, { host: 'ops', actorSub: 'github:slantview', action: 'old', target: 'acc_1', requestId: '4242' }, s - 86_400);
			audit(store.db, { host: 'ops', actorSub: 'github:slantview', action: 'kept', target: 'acc_1', requestId: '4242' }, s - 60);
		});
		expect((await inStore(stub, T, 'reapply-audit', { since })).body).toEqual({ audit_restored: 2 });
		const log = () => runInDurableObject(stub, (store: Store) => store.db.all('SELECT at, action, actor_sub, request_id FROM audit_log ORDER BY id'));
		const want = [
			{ at: s - 86_400, action: 'old', actor_sub: 'github:slantview', request_id: '4242' },
			{ at: s - 60, action: 'kept', actor_sub: 'github:slantview', request_id: '4242' },
			{ at: s + 5, action: 'lost', actor_sub: 'github:slantview', request_id: '4242' },
			{ at: s + 9, action: 'ops:pitr-restore', actor_sub: 'github:slantview', request_id: '4242' }
		];
		expect(await log()).toEqual(want);
		expect((await inStore(stub, T, 'reapply-audit', { since })).body).toEqual({ audit_restored: 0 });
		expect(await log()).toEqual(want);
	});

	it('restore-dump replaces the data with a dump, then restarts, publishes above R2 and reports an unpurged cache', async () => {
		await publishOne('@kept');
		const key = await runInDurableObject(primary(), async (store: Store, state) => (await dump(state, store.db, env.BACKUPS, Date.now())).key);
		const lost = await publishOne('@lost');
		expect((await op('restore-dump', { key })).body.error.code).toBe('confirmation_required');
		expect((await op('restore-dump', { key: 'dumps/none', confirm: 'dumps/none' })).status).toBe(404);

		const res = await op('restore-dump', { key, confirm: key });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ key, rows: { sources: 1, source_aliases: 1 }, cache_purged: false });
		expect(res.body.head_seq).toBeGreaterThan(lost);
		expect(res.body.r2_seq).toBe(res.body.head_seq);
		await runInDurableObject(primary(), (store: Store) => {
			expect(store.db.all('SELECT canonical_id FROM sources')).toEqual([{ canonical_id: '@kept' }]);
		});
	});

	/** A passkey for the account, made at time. */
	const passkey = (store: Store, accountId: string, name: string, at: number) =>
		addPasskey(store.db, { accountId, credentialId: `cred-${name}`, publicKey: new Uint8Array([1]), signCount: 0, transports: [], backedUp: false, name }, at);

	// The incident case: an admin revokes a compromised curator, then restores to the last good moment.
	it('restore-dump never gives back a credential or a role that was taken away after the dump', async () => {
		const early = Math.floor(Date.now() / 1000) - 100;
		const rex = await runInDurableObject(primary(), (store: Store) => {
			const a = grantRole(store.db, 'rex@example.test', 'curator', early, { host: 'job' });
			const passkeyId = passkey(store, a.id, 'rex', early);
			createSession(store.db, { tokenHash: 'session-rex', accountId: a.id, method: 'passkey', passkeyId, now: early, expires: early + 86_400 });
			createPairing(store.db, a.id, 'reviewer', 'code-rex', early, early + 86_400);
			return { id: a.id, token: store.auth.issueReviewerToken(a.id).token };
		});
		const key = await runInDurableObject(primary(), async (store: Store, state) => (await dump(state, store.db, env.BACKUPS, Date.now())).key);
		const later = Math.floor(Date.now() / 1000);
		await runInDurableObject(primary(), (store: Store) => {
			const who = { host: 'admin' as const, actorId: 'acc_rae' };
			revokeCredentials(store.db, rex.id);
			audit(store.db, { ...who, action: 'revoked', target: rex.id }, later);
			grantRole(store.db, 'rex@example.test', 'member', later, who);
		});

		const res = await op('restore-dump', { key, confirm: key });
		expect(res.status).toBe(200);
		expect(res.body.revocations_reapplied).toBeGreaterThanOrEqual(2);
		await runInDurableObject(primary(), (store: Store) => {
			const db = store.db;
			expect(store.auth.reviewerAccount(rex.token)).toBeUndefined();
			expect(getAccount(db, rex.id)!.role).toBe('member');
			for (const t of ['sessions', 'passkeys', 'reviewer_tokens', 'pairings']) expect(db.all(`SELECT 1 FROM ${t} WHERE account_id = ?`, rex.id), t).toEqual([]);
			// The audit log still says what happened, and now the data agrees with it.
			expect(db.all<{ action: string }>('SELECT action FROM audit_log WHERE target = ? ORDER BY id', rex.id).map((r) => r.action)).toEqual(['role_changed', 'revoked', 'role_changed']);
		});
	});

	it('reapply-revocations ends every session, token, code and flow, takes away again what ended after the restore point, and gives nothing back', async () => {
		const stub = fresh();
		const ids = await runInDurableObject(stub, (store: Store) => {
			const db = store.db;
			const before = S - 100;
			const who = { host: 'admin' as const, actorId: 'acc_rae' };
			// The restored data, as it was at the restore point S.
			const ann = grantRole(db, 'ann@example.test', 'staff', before, { host: 'ops' });
			passkey(store, ann.id, 'ann', before);
			const bob = grantRole(db, 'bob@example.test', 'curator', before, who);
			const bobKeys = ['bob-1', 'bob-2', 'bob-3'].map((n) => passkey(store, bob.id, n, before));
			const cat = grantRole(db, 'cat@example.test', 'curator', before, who);
			passkey(store, cat.id, 'cat', before);
			const dan = grantRole(db, 'dan@example.test', 'staff', before, { host: 'ops' });
			db.run("UPDATE accounts SET access_subject = 'a3t:lost' WHERE id = ?", dan.id);
			const eve = ensureAccount(db, 'eve@example.test', before);
			for (const kind of ['delete', 'email_change'] as const) holdRequest(db, { accountId: eve.id, kind, cancelHash: `cancel-${kind}`, dueAt: S + 3600 }, before);
			// Fay was revoked long before the restore point and enrolled again since: that stays.
			const fay = grantRole(db, 'fay@example.test', 'curator', before - 100, who);
			audit(db, { ...who, action: 'revoked', target: fay.id }, before - 50);
			passkey(store, fay.id, 'fay', before);
			createSession(db, { tokenHash: 'session-bob', accountId: bob.id, method: 'email', now: before, expires: S + 86_400 });
			store.auth.issueReviewerToken(bob.id);
			createPairing(db, bob.id, 'reviewer', 'code-waiting', before, S + 600);
			createPairing(db, bob.id, 'plan', 'code-used', before, S + 600);
			claimPairing(db, 'code-used', '1.0.0', 'chrome', before);
			db.run("INSERT INTO auth_flows (token_hash, kind, account_id, role, created_at, expires_at) VALUES ('invite-cat', 'invite', ?, 'curator', ?, ?)", cat.id, before, S + 86_400);

			// The audit log since the restore point, which the restore kept.
			const at = (n: number) => S + n;
			audit(db, { ...who, action: 'role_changed', target: ann.id, before: 'staff', after: 'member' }, at(1));
			audit(db, { ...who, action: 'role_changed', target: ann.id, before: 'member', after: 'curator' }, at(2));
			audit(db, { host: 'main', action: 'passkey_removed', target: bob.id, before: bobKeys[0] }, at(3));
			audit(db, { host: 'main', action: 'signed_out_everywhere', target: bob.id, after: bobKeys[2] }, at(4));
			audit(db, { ...who, action: 'revoked', target: cat.id }, at(5));
			audit(db, { host: 'ops', action: 'access_pinned', target: dan.id, before: 'a3t:lost', after: 'a3t:new' }, at(6));
			audit(db, { host: 'main', action: 'request_cancelled', target: eve.id, before: 'delete', reason: 'passkey sign-in' }, at(7));
			audit(db, { host: 'job', action: 'email_change_refused', target: eve.id, reason: 'only member accounts move to a new address' }, at(8));
			return { ann: ann.id, bob: bob.id, cat: cat.id, dan: dan.id, eve: eve.id, fay: fay.id, bobKeys };
		});

		expect((await inStore(stub, T + 60_000, 'reapply-revocations', { since: T })).body).toEqual({ revocations_reapplied: 8 });
		await runInDurableObject(stub, (store: Store) => {
			const db = store.db;
			const role = (id: string) => getAccount(db, id)!.role;
			const keys = (id: string) => db.all<{ id: string }>('SELECT id FROM passkeys WHERE account_id = ? ORDER BY id', id).map((r) => r.id);
			// Lowered again; the raise after it is not repeated, so the member's own passkey stays harmless.
			expect([role(ids.ann), keys(ids.ann)]).toEqual(['member', [expect.any(String)]]);
			expect(keys(ids.bob)).toEqual([ids.bobKeys[2]]);
			expect([role(ids.cat), keys(ids.cat)]).toEqual(['curator', []]);
			expect(getAccount(db, ids.dan)!.accessSubject).toBe('a3t:new');
			expect(db.all('SELECT kind FROM account_requests WHERE account_id = ? AND cancelled_at IS NULL', ids.eve)).toEqual([]);
			expect(keys(ids.fay)).toHaveLength(1);
			for (const t of ['sessions', 'reviewer_tokens', 'auth_flows']) expect(db.all(`SELECT 1 FROM ${t}`), t).toEqual([]);
			expect(db.all('SELECT kind FROM pairings')).toEqual([{ kind: 'plan' }]);
		});
	});

	it('purge-cache needs the typed word, and says when the cache refused', async () => {
		expect((await op('purge-cache')).body.error.code).toBe('confirmation_required');
		expect((await op('purge-cache', { confirm: 'purge-cache' })).body).toEqual({ purged: false, reason: 'This runtime has no Workers Cache to purge.' });
		edgeCache = { purge: async () => ({ success: true, errors: [] }) } as unknown as CacheContext;
		expect(await op('purge-cache', { confirm: 'purge-cache' })).toEqual({ status: 200, body: { purged: true } });
		edgeCache = { purge: async () => ({ success: false, errors: [{ code: 1134, message: 'rate limited' }] }) } as unknown as CacheContext;
		const refused = await op('purge-cache', { confirm: 'purge-cache' });
		expect(refused.status).toBe(502);
		expect(refused.body).toMatchObject({ error: { code: 'purge_failed' }, errors: [{ code: 1134, message: 'rate limited' }] });
	});
});

describe('drill', () => {
	async function dumpPrimary(at = Date.now()): Promise<string> {
		return runInDurableObject(primary(), async (store: Store, state) => (await dump(state, store.db, env.BACKUPS, at)).key);
	}
	const sources = (count: number) =>
		runInDurableObject(primary(), (store: Store) =>
			store.db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO sources (platform, canonical_id, created_at) SELECT 'tt', '@s' || i || '-' || random(), 1 FROM n`,
				count
			)
		);

	it('fails without a dump', async () => {
		const res = await op('drill');
		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({ error: { code: 'drill_failed', message: 'There is no dump in the backup bucket.' }, ok: false });
	});

	it('loads the newest dump into the scratch Store, checks it against primary and deletes it', async () => {
		await sources(300);
		await dumpPrimary(Date.now() - 3_600_000);
		const key = await dumpPrimary();
		const res = await op('drill');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, key, quick_check: ['ok'], foreign_key_violations: 0 });
		expect(res.body.age_s).toBeLessThan(60);
		expect(res.body.tables.sources).toEqual({ dump: 300, primary: 300, ok: true });
		expect(Object.values(res.body.tables).every((t: any) => t.ok)).toBe(true);
		const left = await runInDurableObject(env.STORE.getByName('drill'), (store: Store) =>
			store.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*'")
		);
		expect(left, 'the scratch data is gone').toEqual([]);
		// The scratch Store migrates again for the next drill.
		expect((await op('drill')).status).toBe(200);
	});

	it('fails on a stale dump or counts that drifted too far', async () => {
		await dumpPrimary();
		await sources(300);
		const drifted = await op('drill');
		expect(drifted.status).toBe(500);
		expect(drifted.body.ok).toBe(false);
		expect(drifted.body.tables.sources).toEqual({ dump: 0, primary: 300, ok: false });
		expect(drifted.body.error.message).toBe('Table sources has 0 rows in the dump and 300 in primary.');

		await dumpPrimary();
		const later = Date.now() + 7 * 3_600_000;
		vi.spyOn(Date, 'now').mockReturnValue(later);
		const stale = await op('drill');
		expect(stale.status).toBe(500);
		expect(stale.body.error.message).toMatch(/^The newest dump is 7\.0 hours old\.$/);
	});

	it('never loads a dump into primary', async () => {
		const key = dumpKey(T);
		expect((await inStore(primary(), T, 'drill-check', { key })).status).toBe(409);
	});
});

describe('check-decision', () => {
	it('toggles a check channel between Clear and not rated on staging, and never runs in production', async () => {
		const stub = fresh();
		const run = (environment: string, args: Record<string, unknown>) =>
			runInDurableObject(stub, (store: Store, state) => {
				store.now = () => T;
				return storeOps(store, state, { ...env, OPS_GITHUB_ENVIRONMENT: environment }, 'check-decision', args);
			});
		expect((await run('staging', { source: '@colander-smoke', reason: 'Smoke 1.' })).body).toEqual({ source: '@colander-smoke', verdict: 'clear' });
		expect((await run('staging', { source: '@colander-smoke', reason: 'Smoke 2.' })).body).toEqual({ source: '@colander-smoke', verdict: 'none' });
		expect((await run('staging', { source: '@someone-else', reason: 'x' })).status).toBe(400);
		expect((await run('staging', { source: '@colander-drill', reason: '' })).status).toBe(400);
		expect((await run('production', { source: '@colander-smoke', reason: 'Smoke.' })).status).toBe(403);
	});
});
