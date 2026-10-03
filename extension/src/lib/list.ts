// The binary shared list (docs/contracts.md section 3): decode, verify and apply deltas.
// Entries stay packed as 16-byte rows in one Uint8Array, sorted by hash, so a 50,000-entry
// list costs 800 KB in memory and lookups are a binary search with no per-entry objects.
import {
	PLATFORM_CODE,
	VERDICT_BY_CODE,
	SLOP_TYPES,
	TESTS,
	TEST_BIT,
	signalsFromMask,
	type Signal,
	type SlopType,
	type Platform,
	type Test,
	type Verdict
} from '@colander/shared/verdicts';
import { keyHash } from './ids';
import { verifyEd25519, type TrustedKey } from './signing';

export const HEADER = 32;
export const ENTRY = 16;
export const TRAILER = 72;

export class ListError extends Error {}

export interface ListFile {
	kind: 'snapshot' | 'delta';
	sequence: number;
	base: number;
	created: number;
	count: number;
	/** count x 16 bytes, sorted ascending by hash. */
	entries: Uint8Array;
	keyId: Uint8Array;
	signature: Uint8Array;
	/** Every byte the signature covers. */
	signed: Uint8Array;
}

export interface ListHit {
	verdict: Verdict;
	signals: Signal[];
	slopType: SlopType | null;
	tests: Test[];
	item: boolean;
	large: boolean;
	imported: boolean;
	staffReviewed: boolean;
	/** Days since 2020-01-01 UTC when the verdict last changed. */
	updated: number;
}

function u64(view: DataView, at: number): number {
	const v = view.getBigUint64(at, true);
	if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ListError('sequence out of range');
	return Number(v);
}

/** Byte-wise comparison of the 8-byte hashes at two offsets. */
function cmpHash(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
	for (let k = 0; k < 8; k++) {
		const d = a[ai + k]! - b[bi + k]!;
		if (d) return d;
	}
	return 0;
}

/** Structural checks only: magic, version, kind, length, sort order and duplicates. */
export function parseList(bytes: Uint8Array): ListFile {
	if (bytes.length < HEADER + TRAILER) throw new ListError('file too short');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'CLDL') throw new ListError('bad magic');
	if (bytes[4] !== 1) throw new ListError('unsupported version');
	const kindByte = bytes[5];
	if (kindByte !== 0 && kindByte !== 1) throw new ListError('bad kind');
	const count = view.getUint32(28, true);
	if (bytes.length !== HEADER + ENTRY * count + TRAILER) throw new ListError('bad length');
	const sequence = u64(view, 8);
	const base = u64(view, 16);
	const kind = kindByte === 0 ? 'snapshot' : 'delta';
	if (kind === 'snapshot' && base !== 0) throw new ListError('snapshot with a base');
	if (kind === 'delta' && base >= sequence) throw new ListError('delta base not below its sequence');
	const end = HEADER + ENTRY * count;
	const entries = bytes.subarray(HEADER, end);
	for (let i = 1; i < count; i++) {
		if (cmpHash(entries, (i - 1) * ENTRY, entries, i * ENTRY) >= 0) throw new ListError('entries not sorted');
	}
	for (let i = 0; i < count; i++) {
		const v = entries[i * ENTRY + 8]!;
		if (v > 5 || (v === 0 && kind === 'snapshot')) throw new ListError('bad verdict');
	}
	return {
		kind,
		sequence,
		base,
		created: view.getUint32(24, true),
		count,
		entries,
		keyId: bytes.subarray(end, end + 8),
		signature: bytes.subarray(end + 8, end + TRAILER),
		signed: bytes.subarray(0, end)
	};
}

/** Parses and verifies the signature against the trusted keys. Throws ListError on any failure. */
export async function verifyList(bytes: Uint8Array, keys: TrustedKey[]): Promise<ListFile> {
	const file = parseList(bytes);
	if (!(await verifyEd25519(keys, file.keyId, file.signed, file.signature))) throw new ListError('bad signature');
	return file;
}

/**
 * Applies a verified delta to the current sorted entries. The caller must check that
 * `delta.base` equals its own sequence first. Verdict 0 removes an entry.
 */
export function applyDelta(current: Uint8Array, delta: ListFile): Uint8Array {
	if (delta.kind !== 'delta') throw new ListError('not a delta');
	const out = new Uint8Array(current.length + delta.entries.length);
	let i = 0, j = 0, o = 0;
	const n = current.length, m = delta.entries.length;
	while (i < n || j < m) {
		const c = i >= n ? 1 : j >= m ? -1 : cmpHash(current, i, delta.entries, j);
		if (c < 0) {
			out.set(current.subarray(i, i + ENTRY), o);
			o += ENTRY;
			i += ENTRY;
		} else {
			if (delta.entries[j + 8] !== 0) {
				out.set(delta.entries.subarray(j, j + ENTRY), o);
				o += ENTRY;
			}
			if (c === 0) i += ENTRY;
			j += ENTRY;
		}
	}
	return out.slice(0, o);
}

export function decodeEntry(entries: Uint8Array, at: number): ListHit | null {
	const verdict = VERDICT_BY_CODE[entries[at + 8]!];
	if (!verdict) return null;
	const flags = entries[at + 9]!;
	const signals = entries[at + 10]! | (entries[at + 11]! << 8);
	const detail = entries[at + 12]!;
	const typeCode = detail & 3;
	return {
		verdict,
		signals: signalsFromMask(signals),
		slopType: typeCode ? SLOP_TYPES[typeCode - 1]! : null,
		tests: TESTS.filter((t) => (detail >> TEST_BIT[t]) & 1),
		item: ((flags >> 3) & 1) === 1,
		large: ((flags >> 4) & 1) === 1,
		imported: ((flags >> 5) & 1) === 1,
		staffReviewed: ((flags >> 6) & 1) === 1,
		updated: entries[at + 14]! | (entries[at + 15]! << 8)
	};
}

/** Days since 2020-01-01 UTC as a Date. */
export function dayToDate(day: number): Date {
	return new Date(Date.UTC(2020, 0, 1) + day * 86_400_000);
}

/**
 * Synchronous lookups over sorted entries. Hashes are split into two big-endian u32 halves
 * so the binary search compares numbers, which matches the byte-wise sort order.
 */
export class ListIndex {
	readonly count: number;
	private hi: Uint32Array;
	private lo: Uint32Array;
	private cache = new Map<string, ListHit | null>();

	constructor(readonly entries: Uint8Array) {
		this.count = entries.length / ENTRY;
		this.hi = new Uint32Array(this.count);
		this.lo = new Uint32Array(this.count);
		const view = new DataView(entries.buffer, entries.byteOffset, entries.byteLength);
		for (let i = 0; i < this.count; i++) {
			this.hi[i] = view.getUint32(i * ENTRY);
			this.lo[i] = view.getUint32(i * ENTRY + 4);
		}
	}

	lookup(key: string): ListHit | null {
		const cached = this.cache.get(key);
		if (cached !== undefined) return cached;
		const h = keyHash(key);
		const hv = new DataView(h.buffer, h.byteOffset, 8);
		const hi = hv.getUint32(0), lo = hv.getUint32(4);
		let a = 0, b = this.count - 1, hit: ListHit | null = null;
		while (a <= b) {
			const mid = (a + b) >>> 1;
			const mh = this.hi[mid]!, ml = this.lo[mid]!;
			if (mh === hi && ml === lo) {
				// The platform and target type in the flags must agree with the key, which turns a
				// 64-bit hash collision across platforms or target types into a miss.
				const flags = this.entries[mid * ENTRY + 9]!;
				const platform = PLATFORM_CODE[key.slice(0, 2) as Platform];
				const item = key[3] === 'i' ? 1 : 0;
				if ((flags & 7) === platform && ((flags >> 3) & 1) === item) hit = decodeEntry(this.entries, mid * ENTRY);
				break;
			}
			if (mh < hi || (mh === hi && ml < lo)) a = mid + 1;
			else b = mid - 1;
		}
		if (this.cache.size > 20_000) this.cache.clear();
		this.cache.set(key, hit);
		return hit;
	}
}
