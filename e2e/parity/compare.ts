// What the parity harness compares between the Go server and the Worker: the stored state of every
// table that both keep, with random IDs and hashes replaced by natural keys, and the signed list
// files byte for byte once the sequence numbers are mapped (the Worker floors sequences to unix
// seconds where Go counted from 1, hosting plan section 3).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Each query names its table x, so these lookups never resolve a column against their own table.
const SOURCE = (col: string) => `(SELECT s.platform || ':' || s.canonical_id FROM sources s WHERE s.id = x.${col})`;
const ITEM = (col: string) => `(SELECT i.platform || ':' || i.item_id FROM items i WHERE i.id = x.${col})`;
const ACCOUNT = (col: string) => `(SELECT a.email FROM accounts a WHERE a.id = x.${col})`;

/**
 * One query per table of the Go schema. Columns that hold random values (install hashes, token
 * hashes, account, report and appeal IDs) are left out or replaced by what they point at; row IDs
 * that only count insertions are left out. Not compared: list_sequences and list_changes, whose
 * sequence numbers differ by design (the lists themselves are compared byte for byte), and
 * list_requests, which Go counts in process and the Worker reads from edge analytics.
 */
export const TABLES: Record<string, string> = {
	installs: 'SELECT created_at, first_tag_at FROM installs x',
	sources: `SELECT platform, canonical_id, name, import_list, import_source, import_license, imported_at, reviewed_at, large_staff,
		subscribers, uploads_per_day, youtube_checked_at, frozen_until, verdict, signals, detail, flags, changed_at, rescore_at,
		lapse_hold, computed, created_at, size_reviewed_at, mixed,
		(SELECT group_concat(alias, ' ') FROM (SELECT a.alias FROM source_aliases a WHERE a.source_id = x.id ORDER BY a.alias)) AS aliases
		FROM sources x`,
	items: `SELECT platform, item_id, ${SOURCE('source_id')} AS source, verdict, signals, detail, flags, changed_at, rescore_at, lapse_hold,
		computed, created_at FROM items x`,
	tags: `SELECT platform, target_type, target_id, ${SOURCE('source_id')} AS source, ${ITEM('item_id')} AS item, client_id, verdict,
		slop_type, tests, platform_label, created_at, received_at, ext_version,
		(SELECT n.created_at FROM installs n WHERE n.hash = x.install_hash) AS install_created_at FROM tags x`,
	accounts: 'SELECT email, display_name, role, created_at FROM accounts x',
	sessions: `SELECT ${ACCOUNT('account_id')} AS account, created_at, expires_at FROM sessions x`,
	magic_links: 'SELECT email, next, created_at, expires_at, used_at FROM magic_links x',
	reviewer_tokens: `SELECT ${ACCOUNT('account_id')} AS account, created_at FROM reviewer_tokens x`,
	reports: `SELECT client_id, platform, ${SOURCE('source_id')} AS source, reported_id, source_name, examples, reason, slop_type, tests,
		ext_version, status, verdict, close_reason, created_at, updated_at FROM reports x`,
	appeals: `SELECT platform, ${SOURCE('source_id')} AS source, email, statement,
		CASE WHEN code GLOB 'colander-DEMO*' THEN code ELSE 'colander-(random)' END AS code, status, outcome, reasoning,
		${ACCOUNT('resolved_by')} AS resolved_by, created_at, verified_at, resolved_at FROM appeals x`,
	decisions: `SELECT ${SOURCE('source_id')} AS source, ${ITEM('item_id')} AS item, verdict, reason, signals, detail, actor,
		${ACCOUNT('account_id')} AS account, actor_name, created_at, expires_at FROM decisions x`,
	decision_log: `SELECT at, platform, target_type, target_id, ${SOURCE('source_id')} AS source, source_key, source_name, from_verdict,
		to_verdict, reason, signals, actor, actor_name FROM decision_log x`,
	escalations: `SELECT ${SOURCE('source_id')} AS source, ${ITEM('item_id')} AS item, kind, summary, created_at, resolved_at FROM escalations x`,
	list_entries: 'SELECT hex(hash) AS hash, hex(entry) AS entry, target_key FROM list_entries x',
	adapter_configs: 'SELECT version, envelope, created_at FROM adapter_configs x',
	trials: 'SELECT issued_at, expires_at FROM trials x',
	sync_blobs: 'SELECT version, data, updated_at FROM sync_blobs x',
	youtube_cache: 'SELECT key, hex(body) AS body, fetched_at FROM youtube_cache x',
	billing_events: 'SELECT id, type, received_at FROM billing_events x',
	subscriptions: `SELECT id, ${ACCOUNT('account_id')} AS account, customer_id, status, interval, period_start, period_end,
		cancel_at_period_end, latest_payment, latest_paid_at, refunded_at, created_at, updated_at FROM subscriptions x`,
	donations: 'SELECT id, amount_cents, currency, recurring, credit_name, payment, subscription_id, refunded_at, created_at FROM donations x'
};

/** The rows of every compared table as sorted JSON lines. */
export function state(db: DatabaseSync): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [table, query] of Object.entries(TABLES)) {
		out[table] = db
			.prepare(query)
			.all()
			.map((r) => JSON.stringify(r))
			.sort();
	}
	return out;
}

/** Rows in one side's table and not the other's (as multisets), per table. */
export function diffState(go: Record<string, string[]>, worker: Record<string, string[]>): Record<string, { go: string[]; worker: string[] }> {
	const out: Record<string, { go: string[]; worker: string[] }> = {};
	for (const table of Object.keys(TABLES)) {
		const left = new Map<string, number>();
		for (const r of go[table]!) left.set(r, (left.get(r) ?? 0) + 1);
		const onlyWorker: string[] = [];
		for (const r of worker[table]!) {
			const n = left.get(r) ?? 0;
			if (n > 0) left.set(r, n - 1);
			else onlyWorker.push(r);
		}
		const onlyGo = [...left].flatMap(([r, n]) => Array<string>(n).fill(r));
		if (onlyGo.length || onlyWorker.length) out[table] = { go: onlyGo, worker: onlyWorker };
	}
	return out;
}

/** The development key pair (contracts section 12), for verifying and re-signing list files. */
export function devKey(seedBase64: string, publicBase64: string) {
	const x = Buffer.from(publicBase64, 'base64').toString('base64url');
	const d = Buffer.from(seedBase64, 'base64').toString('base64url');
	return {
		private: createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d, x }, format: 'jwk' }),
		public: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }),
		id: createHash('sha256').update(Buffer.from(publicBase64, 'base64')).digest().subarray(0, 8).toString('hex')
	};
}
type Key = ReturnType<typeof devKey>;

export interface ListHeader {
	kind: number;
	sequence: bigint;
	base: bigint;
	created: number;
	count: number;
}

/** Checks the layout and signature of a list file (contracts section 3) and returns its header. */
export function readList(buf: Buffer, key: Key): ListHeader {
	if (buf.length < 104 || buf.subarray(0, 4).toString('latin1') !== 'CLDL') throw new Error('not a list file');
	const count = buf.readUInt32LE(28);
	if (buf.length !== 32 + 16 * count + 72) throw new Error(`list length ${buf.length} does not hold ${count} entries`);
	const trailer = buf.length - 72;
	if (buf.subarray(trailer, trailer + 8).toString('hex') !== key.id) throw new Error('list is not signed by the development key');
	if (!verify(null, buf.subarray(0, trailer), key.public, buf.subarray(trailer + 8))) throw new Error('list signature does not verify');
	return { kind: buf[5]!, sequence: buf.readBigUInt64LE(8), base: buf.readBigUInt64LE(16), created: buf.readUInt32LE(24), count };
}

/** A list file with another sequence and base, signed again (Ed25519 signatures are deterministic). */
export function renumber(buf: Buffer, sequence: bigint, base: bigint, key: Key): Buffer {
	const out = Buffer.from(buf);
	out.writeBigUInt64LE(sequence, 8);
	out.writeBigUInt64LE(base, 16);
	const trailer = out.length - 72;
	sign(null, out.subarray(0, trailer), key.private).copy(out, trailer + 8);
	return out;
}

/** Why two list files differ, in words: header fields and entries by hash. */
export function explainLists(go: Buffer, worker: Buffer): string[] {
	const out: string[] = [];
	for (const [name, at, size] of [['kind', 5, 1], ['created', 24, 4], ['count', 28, 4]] as const) {
		const a = go.readUIntLE(at, size);
		const b = worker.readUIntLE(at, size);
		if (a !== b) out.push(`header ${name}: Go ${a}, Worker ${b}`);
	}
	const entries = (buf: Buffer) => {
		const m = new Map<string, string>();
		for (let at = 32; at < buf.length - 72; at += 16) m.set(buf.subarray(at, at + 8).toString('hex'), buf.subarray(at + 8, at + 16).toString('hex'));
		return m;
	};
	const a = entries(go);
	const b = entries(worker);
	for (const [h, e] of a) if (b.get(h) !== e) out.push(`entry ${h}: Go ${e}, Worker ${b.get(h) ?? 'none'}`);
	for (const [h, e] of b) if (!a.has(h)) out.push(`entry ${h}: Go none, Worker ${e}`);
	return out;
}
