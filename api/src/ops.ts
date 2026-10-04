// The ops channel (hosting plan section 2, flow 13; the contract is "The ops channel" in
// docs/deploy.md). GitHub workflows POST /ops/<command> with OPS_TOKEN; the edge has already
// checked the token. Commands that change data run in the Store through its ops() RPC; the edge
// orchestrates the restores (restart the Store, publish above R2, purge the edge cache) and the
// restore drill, which loads the newest dump into the scratch Store "drill".
//
// They replace the Go binary's operator commands: grant-role, import-seed and sign-config behave
// as `colander <command>` did, with JSON arguments instead of flags. The workflow's run log is
// public, so arguments and answers never name a seed list: import-seed reads the list and its
// license from a private object in the backup bucket and answers with counts only.
import { hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { CONFIG_CONTEXT, signEnvelope } from '@colander/shared/signing';
import { normalizeEmail } from './auth';
import { countsAgree, newestDump, restoreDump, tableCounts } from './backup';
import { json, jsonError } from './http';
import { STATUS, type DumpStatus, type PassStatus, type PublishStatus } from './jobs';
import { r2Sequence } from './list/publisher';
import { canonicalSource } from './routes/ids';
import { rfc3339, trimSpace } from './routes/respond';
import { unix } from './scoring/engine';
import { grantRole, type Account } from './store/accounts';
import { latestSequence, RETENTION_SECONDS, SNAPSHOT_KEY } from './store/list';
import { redactSeedNames } from './store/compliance';
import { saveAdapterConfig } from './store/misc';
import { importSeed, recordSeedImport, type SeedImport } from './store/sources';
import { primary, type Store } from './store/store';

/** A JSON object argument as the workflow sends it. */
export type OpsArgs = Record<string, unknown>;

/** A command's answer: the HTTP status and the JSON body the edge sends back. */
export interface OpsAnswer {
	status: number;
	body: Record<string, unknown>;
}

/** Calls a Store's ops() RPC, which carries arguments and answers as JSON text. */
async function call(stub: DurableObjectStub<Store>, command: string, args: OpsArgs = {}): Promise<OpsAnswer> {
	const r = await stub.ops(command, JSON.stringify(args));
	return { status: r.status, body: JSON.parse(r.json) as Record<string, unknown> };
}

/** The commands of the contract. */
const COMMANDS = new Set(['status', 'grant-role', 'import-seed', 'sign-config', 'drill', 'purge-cache', 'restore-dump', 'pitr-restore']);

/** The drill fails when the newest dump is this old: one 6-hourly dump went missing (hosting plan section 3). */
export const DUMP_MAX_AGE_S = 7 * 3600;

const ok = (body: Record<string, unknown>): OpsAnswer => ({ status: 200, body });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): OpsAnswer => ({
	status,
	body: { error: { code, message }, ...extra }
});
const send = (a: OpsAnswer): Response => json(a.status, a.body);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The edge half: one command, after the edge checked OPS_TOKEN. */
export async function ops(request: Request, env: Env, cache: CacheContext | undefined): Promise<Response> {
	const command = new URL(request.url).pathname.slice('/ops/'.length);
	if (!COMMANDS.has(command)) return jsonError(404, 'unknown_command', 'There is no ops command at this path.');
	if (request.method !== 'POST') return jsonError(405, 'method_not_allowed', 'Ops commands are POST requests.', { Allow: 'POST' });
	const args = await request.json().catch(() => undefined);
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return jsonError(400, 'invalid_body', 'The body must be a JSON object.');
	}
	const a = args as OpsArgs;
	switch (command) {
		case 'purge-cache': {
			if (a.confirm !== 'purge-cache') return send(unconfirmed('the word purge-cache'));
			const p = await purgeEverything(cache);
			return p.errors ? send(fail(502, 'purge_failed', 'The edge cache refused the purge.', p)) : json(200, p);
		}
		case 'pitr-restore':
			return send(await pitrRestore(env, cache, a));
		case 'restore-dump': {
			const key = text(a.key);
			if (key === '' || a.confirm !== key) return send(unconfirmed('the dump key'));
			const res = await call(primary(env), 'restore-dump', { key });
			if (res.status !== 200) return send(res);
			await restart(env);
			return send(await afterRestore(env, cache, res.body));
		}
		case 'drill':
			return send(await drill(env));
		default:
			return send(await call(primary(env), command, a));
	}
}

const unconfirmed = (what: string): OpsAnswer =>
	fail(400, 'confirmation_required', `This command is destructive: set confirm to exactly ${what}.`);

/**
 * Purges every response of this Worker's default entrypoint (the one that serves the list) from
 * Workers Cache. Local runtimes have no edge cache, so there is nothing to purge.
 */
async function purgeEverything(cache: CacheContext | undefined): Promise<{ purged: boolean; reason?: string; errors?: { code: number; message: string }[] }> {
	if (!cache) return { purged: false, reason: 'This runtime has no Workers Cache to purge.' };
	const r = await cache.purge({ purgeEverything: true });
	return r.success ? { purged: true } : { purged: false, errors: r.errors };
}

/** Where a point-in-time restore records its bookmarks, in the backup bucket. */
export const PITR_PREFIX = 'pitr/';

/**
 * Point-in-time restore of the Store (hosting plan section 3). `at` must be an RFC 3339 time in the
 * last 30 days, typed twice. The Store arms the restore and restarts in one call, so an armed
 * restore never waits for a later restart; the bookmarks outlive that instance in the backup
 * bucket, and the answer carries them, the undo bookmark included.
 */
async function pitrRestore(env: Env, cache: CacheContext | undefined, a: OpsArgs): Promise<OpsAnswer> {
	const at = text(a.at);
	if (at === '' || a.confirm !== at) return unconfirmed('the time in at');
	const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? Date.parse(at) : NaN;
	if (Number.isNaN(t)) return fail(400, 'invalid_time', 'at must be an RFC 3339 time, for example 2026-11-02T14:05:00Z.');
	const now = Date.now();
	if (t > now || t < now - RETENTION_SECONDS * 1000) {
		return fail(400, 'invalid_time', 'at must be in the past 30 days: point-in-time recovery keeps no older history.');
	}
	const record = `${PITR_PREFIX}${new Date(now).toISOString()}.json`;
	await resetting(call(primary(env), 'pitr-restore', { at: t, record }));
	const saved = await env.BACKUPS.get(record);
	if (!saved) {
		return fail(500, 'restore_unrecorded', `The Store restarted without recording ${record}: check the Worker logs for its bookmarks before anything else.`);
	}
	return afterRestore(env, cache, { at, ...(await saved.json<Record<string, unknown>>()) });
}

/** Waits for a call that ends by resetting the Store; any other failure is thrown. */
async function resetting(p: Promise<unknown>): Promise<void> {
	try {
		await p;
	} catch (err) {
		if (!(err as { durableObjectReset?: boolean }).durableObjectReset) throw err;
	}
}

/** Restarts the Store, so restored data is all the next instance holds. */
const restart = (env: Env) => resetting(call(primary(env), 'restart'));

/**
 * After a restore and its restart: have the new instance publish (above R2's sequence, so no
 * install ever sees an older list) and purge the edge cache.
 */
async function afterRestore(env: Env, cache: CacheContext | undefined, restored: Record<string, unknown>): Promise<OpsAnswer> {
	// A reset object breaks its stubs: primary() makes a new one, which starts a new instance.
	const published = await call(primary(env), 'publish');
	const purge = await purgeEverything(cache);
	console.log(JSON.stringify({ message: 'restored', ...published.body, cachePurged: purge.purged }));
	return ok({ ...restored, ...published.body, cache_purged: purge.purged, ...(purge.errors ? { cache_errors: purge.errors } : {}) });
}

/**
 * The weekly dump drill (hosting plan section 3): load the newest dump into the scratch Store
 * "drill", run quick_check and foreign_key_check there, compare its row counts with primary's,
 * require the dump to be under 7 hours old, and delete the scratch data. Answers 200 with
 * "ok": true only when everything passed.
 */
async function drill(env: Env): Promise<OpsAnswer> {
	const newest = await newestDump(env.BACKUPS);
	if (!newest) return fail(500, 'drill_failed', 'There is no dump in the backup bucket.', { ok: false });
	const ageS = Math.round((Date.now() - newest.uploaded.getTime()) / 1000);
	const check = await call(env.STORE.getByName('drill'), 'drill-check', { key: newest.key });
	if (check.status !== 200) return check;
	const loaded = check.body.rows as Record<string, number>;
	const live = (await call(primary(env), 'counts')).body as Record<string, number>;
	const problems: string[] = [];
	const tables: Record<string, { dump: number | null; primary: number | null; ok: boolean }> = {};
	for (const name of [...new Set([...Object.keys(live), ...Object.keys(loaded)])].sort()) {
		const d = loaded[name] ?? null;
		const p = live[name] ?? null;
		const agree = d !== null && p !== null && countsAgree(d, p);
		tables[name] = { dump: d, primary: p, ok: agree };
		if (!agree) problems.push(`Table ${name} has ${d ?? 'no'} rows in the dump and ${p ?? 'no'} in primary.`);
	}
	const quick = check.body.quick_check as string[];
	const violations = check.body.foreign_key_violations as number;
	if (ageS >= DUMP_MAX_AGE_S) problems.push(`The newest dump is ${(ageS / 3600).toFixed(1)} hours old.`);
	if (quick.join() !== 'ok') problems.push(`quick_check found: ${quick.join('; ')}.`);
	if (violations > 0) problems.push(`foreign_key_check found ${violations} violations.`);
	const body = { ok: problems.length === 0, key: newest.key, age_s: ageS, quick_check: quick, foreign_key_violations: violations, tables };
	console.log(JSON.stringify({ message: 'dump drill', ok: body.ok, key: newest.key, ageS, problems: problems.length }));
	return problems.length === 0 ? ok(body) : fail(500, 'drill_failed', problems.join(' '), body);
}

/** The Store half: runs one command in this Store (Store.ops). */
export async function storeOps(store: Store, ctx: DurableObjectState, env: Env, command: string, a: OpsArgs): Promise<OpsAnswer> {
	const db = store.db;
	switch (command) {
		case 'status':
			return ok(await status(store, ctx, env));
		case 'grant-role':
			return grant(store, a);
		case 'import-seed': {
			const answer = await importSeedFile(store, env, a);
			if (store.jobs.dirty) await store.jobs.arm();
			return answer;
		}
		case 'sign-config':
			return signConfig(store, a);
		case 'pitr-restore': {
			const bookmark = await ctx.storage.getBookmarkForTime(a.at as number);
			const undo = await ctx.storage.onNextSessionRestoreBookmark(bookmark);
			const saved = { bookmark, undo_bookmark: undo };
			console.log(JSON.stringify({ message: 'point-in-time restore armed', ...saved }));
			try {
				await env.BACKUPS.put(text(a.record), JSON.stringify(saved), { httpMetadata: { contentType: 'application/json' } });
			} finally {
				// Restart now, recorded or not: the armed restore must never wait for a later restart.
				ctx.abort('restarting into a point-in-time restore');
			}
			return ok(saved);
		}
		case 'restore-dump': {
			const key = text(a.key);
			const rows = await restoreDump(db, env.BACKUPS, key, store.now());
			if (!rows) return fail(404, 'no_dump', `There is no dump ${key} in the backup bucket.`);
			// The pass cursor points into the replaced rows: the next pass starts over.
			ctx.storage.kv.delete(STATUS.passProgress);
			return ok({ key, rows });
		}
		case 'restart':
			ctx.abort('restarting on restored data');
			return ok({});
		case 'publish': {
			const now = store.now();
			const head = await store.publisher.publish(now);
			ctx.storage.kv.put<PublishStatus>(STATUS.publish, { at: now, seq: head.seq });
			return ok({ head_seq: head.seq, r2_seq: r2Sequence(await env.LISTS.head(SNAPSHOT_KEY)) });
		}
		case 'counts':
			return ok(tableCounts(db));
		case 'drill-check': {
			if (ctx.id.name === 'primary') return fail(409, 'not_scratch', 'The drill loads dumps into a scratch Store, never into primary.');
			const key = text(a.key);
			const rows = await restoreDump(db, env.BACKUPS, key, store.now());
			if (!rows) return fail(404, 'no_dump', `There is no dump ${key} in the backup bucket.`);
			const quick = db.all<{ quick_check: string }>('PRAGMA quick_check').map((r) => r.quick_check);
			const violations = db.all('PRAGMA foreign_key_check').length;
			await ctx.storage.deleteAll();
			return ok({ rows, quick_check: quick, foreign_key_violations: violations });
		}
		default:
			return fail(404, 'unknown_command', 'There is no ops command at this path.');
	}
}

/**
 * What the probes and the restore drill read (docs/deploy.md): the list heads in the Store and
 * in R2, how long ago the last pass and dump finished, and how long the oldest list change not
 * yet in R2 has waited.
 */
async function status(store: Store, ctx: DurableObjectState, env: Env): Promise<Record<string, unknown>> {
	const r2 = r2Sequence(await env.LISTS.head(SNAPSHOT_KEY));
	const now = store.now();
	const db = store.db;
	const head = latestSequence(db);
	const kv = ctx.storage.kv;
	const pass = kv.get<PassStatus>(STATUS.pass);
	const dumped = kv.get<DumpStatus>(STATUS.dump);
	const age = (at: number | undefined) => (at === undefined ? null : Math.max(0, Math.round((now - at) / 1000)));
	// The oldest change waiting: a sequence the Store published that R2 does not hold yet, or a
	// verdict change after the head that no sequence holds yet.
	const waiting: (number | null)[] = [
		db.get<{ t: number | null }>(
			`SELECT min(t) AS t FROM (SELECT min(changed_at) AS t FROM sources WHERE changed_at > ?1
			UNION ALL SELECT min(changed_at) FROM items WHERE changed_at > ?1)`,
			head.createdAt
		)!.t
	];
	if (r2 < head.seq) waiting.push(db.get<{ t: number | null }>('SELECT min(created_at) AS t FROM list_sequences WHERE seq > ?', r2)!.t);
	const oldest = Math.min(...waiting.filter((t): t is number => t !== null));
	return {
		head_seq: head.seq,
		r2_seq: r2,
		pass_age_s: age(pass?.at),
		publish_lag_s: Number.isFinite(oldest) ? Math.max(0, unix(now) - oldest) : 0,
		dump_age_s: age(dumped?.at),
		dump_ms: dumped?.ms ?? null,
		rows_read_last_pass: pass?.rowsRead ?? null
	};
}

const accountJSON = (a: Account) => ({ id: a.id, email: a.email, display_name: a.displayName || null, role: a.role, created_at: rfc3339(a.createdAt) });

/** `colander grant-role <email> <role>`. */
function grant(store: Store, a: OpsArgs): OpsAnswer {
	const email = normalizeEmail(text(a.email));
	if (!email) return fail(400, 'invalid_email', `${JSON.stringify(text(a.email))} is not an email address.`);
	const role = text(a.role);
	if (role !== 'member' && role !== 'curator' && role !== 'staff') {
		return fail(400, 'invalid_role', `role must be member, curator or staff, not ${JSON.stringify(role)}.`);
	}
	const acct = grantRole(store.db, email, role, unix(store.now()));
	return ok({ account: accountJSON(acct), message: `${acct.email} (${acct.id}) is now ${acct.role}.` });
}

/** The licenses a paid product may use a seed list under, by their SPDX identifiers. */
export const SEED_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'MIT', 'LicenseRef-written-grant'];

/** import-seed reads seed lists from objects under this prefix of the private backup bucket. */
export const SEED_PREFIX = 'seeds/';

/**
 * Checks a seed list's license and the records it needs: the credit for CC BY and MIT, and where
 * the written grant is kept for LicenseRef-written-grant. Non-commercial, no-derivatives,
 * share-alike, GPL and unlicensed lists are refused. Returns the SPDX spelling or the refusal,
 * which never repeats the license: the answer is public.
 */
function seedLicense(license: string, attribution: string, permissionDoc: string): string | OpsAnswer {
	const known = SEED_LICENSES.find((l) => l.toLowerCase() === license.toLowerCase());
	if (known === undefined) {
		const how = 'Ask its maintainer for written permission and import it as LicenseRef-written-grant with permission_doc.';
		if (license === '' || /^(none|noassertion|unlicensed|unknown|proprietary)$/i.test(license)) {
			return fail(400, 'license_refused', `Refusing to import: the list has no license, and unlicensed lists may not be used. ${how}`);
		}
		if (/(^|[^a-z])(nc|nd|sa)([^a-z]|$)|noncommercial|noderiv|sharealike|gpl/i.test(license)) {
			return fail(
				400,
				'license_refused',
				`Refusing to import: the list's license does not allow use in a paid product. Non-commercial, no-derivatives, share-alike and GPL lists are refused. ${how}`
			);
		}
		return fail(400, 'invalid_license', `license must be one of ${SEED_LICENSES.join(', ')}.`);
	}
	if ((known === 'CC-BY-4.0' || known === 'MIT') && attribution === '') {
		return fail(400, 'attribution_required', 'CC-BY-4.0 and MIT need attribution: the credit or copyright notice the license asks for.');
	}
	if (known === 'LicenseRef-written-grant' && permissionDoc === '') {
		return fail(400, 'permission_doc_required', 'LicenseRef-written-grant needs permission_doc: where the written grant is kept.');
	}
	return known;
}

/**
 * `colander import-seed`: the only argument is `key`, an object under SEED_PREFIX in the backup
 * bucket holding a JSON object with the list text (`file`: one @handle or UC channel ID per line,
 * `!` starts a comment), `list`, `source_name`, `license`, `attribution` and `permission_doc`.
 * The repository and the ops run log are public, and no list or its name may be in either.
 * The whole file goes in one transaction. Only lists a paid product may use are accepted
 * (seedLicense), and the run is recorded with its license, attribution, grant and file hash for
 * audits. Seed entries are review leads for staff: they never give a verdict and are never named in
 * public (contracts 9.3), so the log loses any mention of the list's name too. The scoring pass
 * that puts them in the review queue starts at once.
 */
async function importSeedFile(store: Store, env: Env, a: OpsArgs): Promise<OpsAnswer> {
	const key = text(a.key);
	if (!key.startsWith(SEED_PREFIX) || key.length === SEED_PREFIX.length || Object.keys(a).some((k) => k !== 'key')) {
		return fail(
			400,
			'invalid_args',
			`import-seed takes only key: an object under ${SEED_PREFIX} in the backup bucket that holds the list and its license. The ops run log is public, so nothing about a list may be in the arguments.`
		);
	}
	const obj = await env.BACKUPS.get(key);
	if (!obj) return fail(404, 'no_seed', `There is no object ${key} in the backup bucket.`);
	const seed = await obj.json<unknown>().catch(() => undefined);
	if (typeof seed !== 'object' || seed === null || Array.isArray(seed)) return fail(400, 'invalid_seed', `${key} does not hold a JSON object.`);
	const s = seed as Record<string, unknown>;
	const file = text(s.file);
	const list = text(s.list);
	const sourceName = trimSpace(text(s.source_name));
	const attribution = trimSpace(text(s.attribution));
	const permissionDoc = trimSpace(text(s.permission_doc));
	if (file === '' || sourceName === '') return fail(400, 'invalid_seed', 'file and source_name are required.');
	if (list !== 'blocklist' && list !== 'warnlist') return fail(400, 'invalid_seed', 'list must be blocklist or warnlist.');
	const license = seedLicense(trimSpace(text(s.license)), attribution, permissionDoc);
	if (typeof license !== 'string') return license;
	const db = store.db;
	const now = store.now();
	const ids: string[] = [];
	let skipped = 0;
	for (const raw of file.split('\n')) {
		const line = trimSpace(raw);
		if (line === '' || line.startsWith('!')) continue;
		const id = canonicalSource('yt', line);
		if (id === undefined) skipped++;
		else ids.push(id);
	}
	const imp: SeedImport = { sourceName, list, license, attribution, permissionDoc, sha256: hex(sha256(utf8(file))), entries: ids.length };
	const batch = db.tx(() => {
		const id = recordSeedImport(db, imp, unix(now));
		for (const alias of ids) importSeed(db, id, 'yt', alias, imp, unix(now));
		// A reviewer may have named the list before Colander imported it.
		redactSeedNames(db, [sourceName]);
		return id;
	});
	store.jobs.schedule('pass', now);
	return ok({
		imported: ids.length,
		skipped,
		batch,
		message: `Imported ${ids.length} YouTube channels as review leads, skipped ${skipped} lines. They never give a verdict; the scoring pass now puts them in the review queue.`
	});
}

/**
 * The text of the object a file starts with, as Go's json.Decoder read it: whatever follows that
 * object is ignored. That lets sign-config sign a file the extension cannot parse; Go did the same,
 * and the port keeps it until it is fixed on purpose.
 */
function firstObject(file: string): string {
	const start = file.search(/\S/);
	if (file[start] !== '{') return file;
	let depth = 0;
	for (let i = start, inString = false; i < file.length; i++) {
		const c = file[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === '{' || c === '[') depth++;
		else if ((c === '}' || c === ']') && --depth === 0) return file.slice(0, i + 1);
	}
	return file;
}

/**
 * The top-level integer version the way Go's sign-config decoded it into a json.Number: keys match
 * "version" ignoring case and the last one wins, null is ignored, a string must hold a JSON number,
 * and anything else fails the decode (Go then reported the file as not a JSON object). The number
 * must be an integer literal.
 */
function configVersion(file: string): number | undefined | 'not_object' {
	const versions = new Map<unknown, { literal?: string; bad?: boolean }>();
	let root: unknown;
	try {
		const reviver = function (this: unknown, key: string, value: unknown, context?: { source?: string }) {
			if (key.toLowerCase() === 'version' && value !== null) {
				const v = versions.get(this) ?? {};
				if (typeof value === 'number') v.literal = context?.source ?? String(value);
				else if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) v.literal = value;
				else v.bad = true;
				versions.set(this, v);
			}
			return value;
		};
		root = JSON.parse(firstObject(file), reviver as (key: string, value: unknown) => unknown);
	} catch {
		return 'not_object';
	}
	if (root !== null && (typeof root !== 'object' || Array.isArray(root))) return 'not_object';
	const v = versions.get(root);
	if (v?.bad) return 'not_object';
	if (v?.literal === undefined || !/^-?(?:0|[1-9]\d*)$/.test(v.literal)) return undefined;
	const n = Number(v.literal);
	return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * `colander sign-config <file.json>`: signs the adapter configuration byte for byte with the
 * Worker's key, so the signing seed never sits on a laptop, and stores it for GET /v1/config/adapters.
 */
async function signConfig(store: Store, a: OpsArgs): Promise<OpsAnswer> {
	const file = text(a.file);
	if (file === '') return fail(400, 'invalid_args', 'file is required: the adapter configuration JSON.');
	const version = configVersion(file);
	if (version === 'not_object') return fail(400, 'invalid_config', 'The file is not a JSON object.');
	if (version === undefined) return fail(400, 'invalid_config', 'The file needs a top-level integer version.');
	const key = await store.signingKey();
	const envelope = JSON.stringify(await signEnvelope(key, CONFIG_CONTEXT, utf8(file)));
	saveAdapterConfig(store.db, version, envelope, unix(store.now()));
	return ok({
		version,
		key_id: key.idHex,
		message: `Signed adapter configuration version ${version} with key ${key.idHex}. GET /v1/config/adapters now serves it.`
	});
}
