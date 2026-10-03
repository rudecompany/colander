// Shared list sync: snapshot or delta, verified, applied only on top of the right base,
// kept in IndexedDB and mirrored as a compact index for content scripts.
import { b64encode } from '@colander/shared/bytes';
import * as db from '../lib/db';
import { applyDelta, ENTRY, verifyList, type ListFile } from '@colander/shared/list';
import type { TrustedKey } from '@colander/shared/signing';
import { DEFAULT_STATUS, K, type Status, type StoredIndex } from '../lib/settings';
import { request } from './net';

export interface ListState {
	sequence: number;
	created: number;
	entries: Uint8Array;
	syncedAt: number;
}

async function fetchBytes(path: string): Promise<{ status: number; bytes: Uint8Array }> {
	// List downloads carry no identifier at all (contract 8).
	const res = await request(path);
	return { status: res.status, bytes: res.ok && res.status !== 204 ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array() };
}

export async function getStatus(): Promise<Status> {
	const got = await chrome.storage.local.get(K.status);
	return { ...DEFAULT_STATUS, ...(got[K.status] as Partial<Status>) };
}

export async function setStatus(patch: Partial<Status>): Promise<Status> {
	const next = { ...(await getStatus()), ...patch };
	await chrome.storage.local.set({ [K.status]: next });
	return next;
}

async function save(state: ListState) {
	await db.put('kv', state, 'list');
	const index: StoredIndex = { sequence: state.sequence, count: state.entries.length / ENTRY, entries: b64encode(state.entries), syncedAt: state.syncedAt };
	await chrome.storage.local.set({ [K.listIndex]: index });
}

/**
 * Brings the local list up to date. Never replaces the last good copy with anything that fails
 * verification, never applies a delta whose base is not the local sequence, and never moves
 * back to an older snapshot. Returns true when the list changed.
 */
export async function syncList(keys: TrustedKey[]): Promise<boolean> {
	const now = Date.now();
	await setStatus({ lastAttemptAt: now });
	const cur = await db.get<ListState>('kv', 'list');
	try {
		let next: ListState | null = null;
		if (cur) {
			const d = await fetchBytes(`/v1/list/delta?since=${cur.sequence}`);
			if (d.status === 204) {
				await setStatus({ lastSyncAt: now, lastError: null });
				await db.put('kv', { ...cur, syncedAt: now }, 'list');
				return false;
			}
			if (d.status === 200) {
				const delta = await verifyList(d.bytes, keys);
				if (delta.kind === 'delta' && delta.base === cur.sequence) {
					next = { sequence: delta.sequence, created: delta.created, entries: applyDelta(cur.entries, delta), syncedAt: now };
				}
				// A delta built on another base is ignored; the snapshot below settles it.
			} else if (d.status !== 410) {
				throw new Error(`delta: HTTP ${d.status}`);
			}
		}
		if (!next) {
			const s = await fetchBytes('/v1/list/snapshot');
			if (s.status !== 200) throw new Error(`snapshot: HTTP ${s.status}`);
			const snap: ListFile = await verifyList(s.bytes, keys);
			if (snap.kind !== 'snapshot') throw new Error('snapshot: not a snapshot');
			if (cur && snap.sequence < cur.sequence) throw new Error('snapshot: older than the local list');
			next = { sequence: snap.sequence, created: snap.created, entries: snap.entries.slice(), syncedAt: now };
		}
		await save(next);
		await setStatus({ lastSyncAt: now, lastError: null, listSequence: next.sequence, listCount: next.entries.length / ENTRY, listCreated: next.created });
		return !cur || cur.sequence !== next.sequence;
	} catch (e) {
		await setStatus({ lastError: e instanceof Error ? e.message : String(e) });
		return false;
	}
}

export async function clearList() {
	await db.del('kv', 'list');
	await chrome.storage.local.remove(K.listIndex);
}
