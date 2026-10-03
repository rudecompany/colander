// The ops channel (hosting plan section 2, flow 13; the contract is "The ops channel" in
// docs/deploy.md). GitHub workflows POST /ops/<command> with OPS_TOKEN; the edge has already
// checked the token. Commands that change data run in the Store through its ops() RPC; the edge
// orchestrates the restores (restart the Store, publish above R2, purge the edge cache) and the
// restore drill, which loads the newest dump into the scratch Store "drill".
//
// They replace the Go binary's operator commands: grant-role, import-seed and sign-config behave
// as `colander <command>` did, with JSON arguments instead of flags.
import { utf8 } from '@colander/shared/bytes';
import { canonicalSource, lowerSimple } from '@colander/shared/ids';
import { CONFIG_CONTEXT, signEnvelope } from '@colander/shared/signing';
import { countsAgree, newestDump, restoreDump, tableCounts } from './backup';
import { json, jsonError } from './http';
import { STATUS, type DumpStatus, type PassStatus, type PublishStatus } from './jobs';
import { r2Sequence } from './list/publisher';
import { unix } from './scoring/engine';
import { grantRole, type Account } from './store/accounts';
import { latestSequence, RETENTION_SECONDS, SNAPSHOT_KEY } from './store/list';
import { saveAdapterConfig } from './store/misc';
import { importSeed } from './store/sources';
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
const rfc3339 = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
			return send(res.status === 200 ? await afterRestore(env, cache, res.body) : res);
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

/**
 * Point-in-time restore of the Store (hosting plan section 3). `at` must be an RFC 3339 time in the
 * last 30 days, typed twice. The answer carries the undo bookmark.
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
	const res = await call(primary(env), 'pitr-restore', { at: t });
	return res.status === 200 ? afterRestore(env, cache, { at, ...res.body }) : res;
}

/**
 * After a restore: restart the Store so the restored data is all it holds, have the new instance
 * publish (above R2's sequence, so no install ever sees an older list) and purge the edge cache.
 */
async function afterRestore(env: Env, cache: CacheContext | undefined, restored: Record<string, unknown>): Promise<OpsAnswer> {
	try {
		await call(primary(env), 'restart');
	} catch (err) {
		if (!(err as { durableObjectReset?: boolean }).durableObjectReset) throw err;
	}
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
			const answer = importSeedFile(store, a);
			if (store.jobs.dirty) await store.jobs.arm();
			return answer;
		}
		case 'sign-config':
			return signConfig(store, a);
		case 'pitr-restore': {
			const bookmark = await ctx.storage.getBookmarkForTime(a.at as number);
			const undo = await ctx.storage.onNextSessionRestoreBookmark(bookmark);
			console.log(JSON.stringify({ message: 'point-in-time restore armed', bookmark, undo }));
			return ok({ bookmark, undo_bookmark: undo });
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

// RFC 5322 atext as Go's net/mail reads it: printable ASCII except the specials, plus any non-ASCII.
const ATOM = String.raw`[!#$%&'*+\-/0-9=?A-Z^_\x60a-z{|}~\u{80}-\u{10FFFF}]+`;
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const EMAIL = new RegExp(`^${DOT_ATOM}@(?:${DOT_ATOM}|\\[${OCTET}(?:\\.${OCTET}){3}\\])$`, 'u');

/**
 * Go's auth.NormalizeEmail: lowercased and trimmed, at most 254 bytes, and what mail.ParseAddress
 * reads back unchanged with no name (a dot-atom local part, a dot-atom domain or IPv4 literal).
 */
function normalizeEmail(s: string): string | undefined {
	s = lowerSimple(s.trim());
	return utf8(s).length <= 254 && EMAIL.test(s) ? s : undefined;
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

/**
 * `colander import-seed`: one @handle or UC channel ID per line, `!` starts a comment, in one
 * transaction for the whole file. Nothing is downloaded or bundled: the operator supplies the list
 * and accepts its license, and the attribution is stored on each entry. Go scored inline after
 * the import; here the chunked scoring pass starts at once and the list publishes after it.
 */
function importSeedFile(store: Store, a: OpsArgs): OpsAnswer {
	const file = text(a.file);
	const list = text(a.list);
	const sourceName = text(a.source_name);
	const license = text(a.license);
	if (file === '' || sourceName === '' || license === '') return fail(400, 'invalid_args', 'file, source_name and license are required.');
	if (list !== 'blocklist' && list !== 'warnlist') return fail(400, 'invalid_args', 'list must be blocklist or warnlist.');
	if (a.accept_license !== true) {
		return fail(400, 'license_not_accepted', `Refusing to import: ${sourceName} is licensed ${license}. Read its terms and set accept_license to true to confirm.`);
	}
	const db = store.db;
	const now = store.now();
	let imported = 0;
	let skipped = 0;
	db.tx(() => {
		for (const raw of file.split('\n')) {
			const line = raw.trim();
			if (line === '' || line.startsWith('!')) continue;
			const id = canonicalSource('yt', line);
			if (id === null) {
				skipped++;
				continue;
			}
			importSeed(db, 'yt', id, list, sourceName, license, unix(now));
			imported++;
		}
	});
	store.jobs.schedule('pass', now);
	return ok({
		imported,
		skipped,
		message: `Imported ${imported} YouTube channels from ${sourceName} (${license}) as ${list} entries, skipped ${skipped} lines. The scoring pass starts now and publishes them.`
	});
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
		root = JSON.parse(file, reviver as (key: string, value: unknown) => unknown);
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
