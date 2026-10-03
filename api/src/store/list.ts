// The delta read path of the list publisher (Go's listfmt.Publisher.Delta with store.SequenceCreated
// and store.ChangesSince): the coalesced change set from `since` to the latest sequence, signed.
// The tables are written by list publication, which the port adds.
import { hex } from '@colander/shared/bytes';
import { encodeList } from '@colander/shared/list';
import type { SigningKey } from '@colander/shared/signing';
import { jsonError, setCache } from '../http';
import type { Db } from './db';

/** The R2 key of the signed snapshot, written with `customMetadata.seq`; the edge serves it. */
export const SNAPSHOT_KEY = 'list/snapshot.bin';

/** Deltas are served from sequences published within this window (contract 3.2). */
export const RETENTION_SECONDS = 30 * 24 * 3600;

export async function listDelta(db: Db, key: () => Promise<SigningKey>, since: number, nowSeconds: number): Promise<Response> {
	// All reads happen before the first await, so they see one consistent state.
	const head = db.get<{ seq: number; created_at: number }>('SELECT seq, created_at FROM list_sequences ORDER BY seq DESC LIMIT 1');
	const headers = new Headers({ 'X-Colander-Sequence': String(head?.seq ?? 0) });
	const gone = () =>
		jsonError(410, 'sequence_unknown', 'That list version is unknown or too old. Fetch the full snapshot.', setCache(headers, 'gone'));
	if (!head) return gone();
	if (since === head.seq) return new Response(null, { status: 204, headers: setCache(headers, 'list') });
	if (since > head.seq || since <= 0) return gone();
	const base = db.get<{ created_at: number }>('SELECT created_at FROM list_sequences WHERE seq = ?', since);
	if (!base || base.created_at < nowSeconds - RETENTION_SECONDS) return gone();
	// The final state of every hash changed after since: later sequences overwrite earlier ones.
	const latest = new Map<string, Uint8Array>();
	for (const r of db.all<{ hash: ArrayBuffer; entry: ArrayBuffer }>(
		'SELECT hash, entry FROM list_changes WHERE seq > ? AND seq <= ? ORDER BY seq',
		since,
		head.seq
	)) {
		latest.set(hex(new Uint8Array(r.hash)), new Uint8Array(r.entry));
	}
	// ponytail: every miss re-signs the delta; Go kept the last 256 in memory. Add that cache if
	// Store CPU shows signing, since the edge cache already collapses identical requests.
	const body = await encodeList(await key(), { kind: 'delta', sequence: head.seq, base: since, created: head.created_at }, [...latest.values()]);
	headers.set('Content-Type', 'application/octet-stream');
	return new Response(body, { status: 200, headers: setCache(headers, 'list') });
}
