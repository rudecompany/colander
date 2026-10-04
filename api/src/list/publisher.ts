// List publication (Go's listfmt.Publisher with store.PublishList; hosting plan sections 2 and 3):
// the rated targets become a new signed sequence in one transaction, the snapshot goes to R2 for
// the edge, and deltas are built from the stored changes on request.
import { keyHash, targetKey } from '@colander/shared/ids';
import { dayNumber, encodeEntry, encodeList, FLAG_ITEM } from '@colander/shared/list';
import type { SigningKey } from '@colander/shared/signing';
import { PLATFORM_CODE, VERDICT_CODE, type Platform, type Verdict } from '@colander/shared/verdicts';
import { hex } from '@colander/shared/bytes';
import { jsonError, setCache } from '../http';
import type { Db } from '../store/db';
import {
	changesSince,
	latestSequence,
	listTargets,
	publishedEntries,
	publishList,
	RETENTION_SECONDS,
	sequenceCreated,
	SNAPSHOT_KEY,
	type ListEntry,
	type ListTarget,
	type Sequence
} from '../store/list';

/** The sequence in an R2 snapshot's metadata, or 0 when there is no valid one. */
export function r2Sequence(obj: R2Object | null): number {
	const seq = obj?.customMetadata?.seq;
	return seq && /^\d{1,15}$/.test(seq) ? Number(seq) : 0;
}

/** The entries the list should hold for these targets, keyed by hex hash (Go's Publish loop). */
export function wantedEntries(targets: ListTarget[]): Map<string, ListEntry> {
	const want = new Map<string, ListEntry>();
	for (const t of targets) {
		// An item entry exists only when its own verdict differs from its source's, or its source is mixed.
		if (t.targetType === 'item' && t.state.verdict === t.sourceVerdict && !t.sourceMixed) continue;
		const key = targetKey(t.platform as Platform, t.targetType as 'source' | 'item', t.id);
		const hash = keyHash(key);
		const entry = encodeEntry({
			hash,
			verdict: VERDICT_CODE[t.state.verdict as Verdict] ?? 0,
			flags: PLATFORM_CODE[t.platform as Platform] | t.state.flags | (t.targetType === 'item' ? FLAG_ITEM : 0),
			signals: t.state.signals,
			detail: t.state.detail,
			updated: dayNumber(t.state.changedAt)
		});
		want.set(hex(hash), { hash, entry, key });
	}
	return want;
}

/** The delta entry for a dropped one: verdict 0, its platform and item bits, dated now. */
export function removedEntry(now: number): (old: Uint8Array) => Uint8Array {
	return (old) => encodeEntry({ hash: old.slice(0, 8), verdict: 0, flags: old[9]! & (FLAG_ITEM | 7), signals: 0, detail: 0, updated: dayNumber(now) });
}

/** Go's Publisher kept at most this many encoded deltas per head, then started over. */
export const DELTA_CACHE = 256;

export class Publisher {
	/** The snapshot last encoded here, kept to serve R2 misses without signing again. */
	private snapshot?: { seq: number; bytes: Uint8Array };
	/** Encoded deltas to the head `seq`, by base (Go's Publisher.deltas). */
	private deltas: { seq: number; bySince: Map<number, Uint8Array> } = { seq: 0, bySince: new Map() };
	/** The publication in progress: runs never overlap, so R2 never ends on an older sequence. */
	private running: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly db: Db,
		private readonly bucket: R2Bucket,
		private readonly key: () => Promise<SigningKey>
	) {}

	/**
	 * Writes a new sequence when the rated targets differ from the published list, or when the R2
	 * snapshot is ahead of the local head (a restore), then makes R2 hold the head snapshot.
	 * The head is checked against R2 on every run, so a lagging or lost R2 object heals here too.
	 * Returns the head sequence. nowMs is unix milliseconds.
	 *
	 * A Store with no list while R2 holds one has lost its data (a destroyed namespace): it
	 * publishes nothing, rather than an empty list above R2 that installs would accept, and
	 * returns sequence 0 (the watchdog alerts). A restore-dump brings the list back; deleting the
	 * R2 snapshot starts from an empty list on purpose.
	 */
	publish(nowMs: number): Promise<Sequence> {
		const run = this.running.then(() => this.publishOnce(nowMs));
		this.running = run.catch(() => undefined);
		return run;
	}

	private async publishOnce(nowMs: number): Promise<Sequence> {
		const now = Math.floor(nowMs / 1000);
		const r2Seq = r2Sequence(await this.bucket.head(SNAPSHOT_KEY));
		// One transaction reads the targets, diffs them and records the sequence; the snapshot rows
		// are read before the first await, so they belong to exactly that sequence.
		const { seq, changed, size, entries } = this.db.tx(() => {
			const head = latestSequence(this.db);
			if (head.seq === 0 && r2Seq > 0) return { seq: head, changed: false, size: 0, entries: null };
			const want = wantedEntries(listTargets(this.db));
			const res = publishList(this.db, want, removedEntry(now), now, now - RETENTION_SECONDS, r2Seq);
			return { ...res, size: want.size, entries: res.seq.seq === r2Seq ? null : publishedEntries(this.db).entries };
		});
		if (seq.seq === 0) console.error(JSON.stringify({ message: 'list not published: the Store has no list while R2 holds one', r2Sequence: r2Seq }));
		if (changed) console.log(JSON.stringify({ message: 'list published', sequence: seq.seq, entries: size }));
		if (entries) {
			const bytes = await this.encode(seq, entries);
			await this.bucket.put(SNAPSHOT_KEY, bytes, {
				httpMetadata: { contentType: 'application/octet-stream' },
				customMetadata: { seq: String(seq.seq), created: String(seq.createdAt) }
			});
		}
		return seq;
	}

	/** The head snapshot, for R2 misses; undefined before the first publication. */
	async currentSnapshot(): Promise<{ seq: number; bytes: Uint8Array } | undefined> {
		const head = latestSequence(this.db);
		if (head.seq === 0) return undefined;
		if (this.snapshot?.seq === head.seq) return this.snapshot;
		const { seq, entries } = publishedEntries(this.db);
		return { seq: seq.seq, bytes: await this.encode(seq, entries) };
	}

	private async encode(seq: Sequence, entries: Uint8Array[]): Promise<Uint8Array> {
		const bytes = await encodeList(await this.key(), { kind: 'snapshot', sequence: seq.seq, base: 0, created: seq.createdAt }, entries);
		if (seq.seq >= (this.snapshot?.seq ?? 0)) this.snapshot = { seq: seq.seq, bytes };
		return bytes;
	}

	/**
	 * Go's Publisher.Delta as an HTTP response: 200 with the signed coalesced delta from since to
	 * the head, 204 when since is the head, 410 when since is unknown or older than 30 days.
	 */
	async delta(since: number, now: number): Promise<Response> {
		// All reads happen before the first await, so they see one consistent state.
		const head = latestSequence(this.db);
		const headers = new Headers({ 'X-Colander-Sequence': String(head.seq) });
		const gone = () =>
			jsonError(410, 'sequence_unknown', 'That list version is unknown or too old. Fetch the full snapshot.', setCache(headers, 'gone'));
		if (head.seq === 0) return gone();
		if (since === head.seq) return new Response(null, { status: 204, headers: setCache(headers, 'list') });
		if (since > head.seq || since <= 0) return gone();
		const created = sequenceCreated(this.db, since);
		if (created === undefined || created < now - RETENTION_SECONDS) return gone();
		if (this.deltas.seq !== head.seq) this.deltas = { seq: head.seq, bySince: new Map() };
		const cache = this.deltas;
		let body = cache.bySince.get(since);
		if (!body) {
			const entries = changesSince(this.db, since, head.seq);
			body = await encodeList(await this.key(), { kind: 'delta', sequence: head.seq, base: since, created: head.createdAt }, entries);
			// ponytail: the cache starts over past 256 bases, as Go's did; an LRU if clients spread wider.
			if (cache.bySince.size >= DELTA_CACHE) cache.bySince.clear();
			cache.bySince.set(since, body);
		}
		headers.set('Content-Type', 'application/octet-stream');
		return new Response(body, { status: 200, headers: setCache(headers, 'list') });
	}
}
