// The list format, envelopes, plan tokens and canonical IDs against the signed cross-language
// fixtures in testdata/contract: the client halves must verify them and the server halves must
// reproduce them byte for byte. Runs in Node and again inside workerd.
import { describe, expect, inject, it } from 'vitest';
import type { PlanTokenPayload } from '../src/api';
import { b64decode, b64url, hex, utf8 } from '../src/bytes';
import { canonicalSource, keyHash } from '../src/ids';
import {
	applyDelta,
	dayNumber,
	dayToDate,
	decodeEntry,
	encodeEntry,
	encodeList,
	ENTRY,
	FLAG_IMPORTED,
	FLAG_ITEM,
	FLAG_LARGE,
	FLAG_STAFF_REVIEWED,
	ListIndex,
	parseList,
	verifyList,
	type Entry
} from '../src/list';
import { sha256 } from '../src/sha256';
import {
	CONFIG_CONTEXT,
	importKeys,
	issuePlanToken,
	planActive,
	PLAN_CONTEXT,
	signEnvelope,
	SigningKey,
	verifyEnvelope,
	verifyPlanToken
} from '../src/signing';
import {
	maskFromSignals,
	PLATFORM_CODE,
	SIGNALS,
	SLOP_TYPE_CODE,
	TEST_BIT,
	VERDICT_CODE,
	type Platform,
	type Signal,
	type SlopType,
	type Test,
	type Verdict
} from '../src/verdicts';

interface FixtureEntry {
	key: string;
	verdict: Verdict | 'removed';
	signals: Signal[];
	slop_type?: SlopType;
	tests?: Test[];
	large?: boolean;
	imported?: boolean;
	staff_reviewed?: boolean;
	updated: string;
	hash: string;
}
interface FixtureList {
	sequence: number;
	base: number;
	created: number;
	entries: FixtureEntry[];
}

const files = inject('contract');
const expected = JSON.parse(files.expected) as {
	key_id: string;
	public_key: string;
	snapshot: FixtureList;
	delta: FixtureList;
	after_delta_count: number;
};
const snapshotBytes = b64decode(files.snapshot);
const deltaBytes = b64decode(files.delta);
const keys = await importKeys([files.devPublicKey]);
const devKey = await SigningKey.fromSeed(b64decode(files.devSeed));

const VERDICT_NAME = ['removed', 'slop', 'likely_slop', 'ai_made', 'disputed', 'clear'];
const signalOrder = (s: string) => (SIGNALS as readonly string[]).indexOf(s);

function rows(entries: Uint8Array) {
	const out = [];
	for (let at = 0; at < entries.length; at += ENTRY) {
		out.push({ hash: hex(entries.subarray(at, at + 8)), verdict: VERDICT_NAME[entries[at + 8]!], e: decodeEntry(entries, at) });
	}
	return out;
}

/** A fixture entry as the server builds it (Go's toEntry in listfmt/format_test.go). */
function toEntry(f: FixtureEntry): Entry {
	const [platform, type] = f.key.split(':') as [Platform, string];
	return {
		hash: keyHash(f.key),
		verdict: f.verdict === 'removed' ? 0 : VERDICT_CODE[f.verdict],
		flags:
			PLATFORM_CODE[platform] |
			(type === 'i' ? FLAG_ITEM : 0) |
			(f.large ? FLAG_LARGE : 0) |
			(f.imported ? FLAG_IMPORTED : 0) |
			(f.staff_reviewed ? FLAG_STAFF_REVIEWED : 0),
		signals: maskFromSignals(f.signals),
		detail: (f.slop_type ? SLOP_TYPE_CODE[f.slop_type] : 0) | (f.tests ?? []).reduce((m, t) => m | (1 << TEST_BIT[t]), 0),
		updated: dayNumber(Date.parse(f.updated) / 1000)
	};
}

describe('keys', () => {
	it('derives the dev public key and key id from the dev seed', () => {
		expect(devKey.publicBase64).toBe(files.devPublicKey);
		expect(devKey.publicBase64).toBe(expected.public_key);
		expect(devKey.idHex).toBe(expected.key_id);
		expect(keys[0]!.id).toBe(expected.key_id);
	});

	it('rejects a seed of the wrong length', async () => {
		await expect(SigningKey.fromSeed(new Uint8Array(31))).rejects.toThrow('32 bytes');
	});
});

describe('sha256', () => {
	it('matches WebCrypto on many inputs', async () => {
		for (let n = 0; n < 300; n++) {
			const s = new TextEncoder().encode('yt:s:@' + 'é'.repeat(n % 7) + 'x'.repeat(n));
			expect(hex(sha256(s))).toBe(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', s))));
		}
	});

	it('hashes target keys like the fixtures', () => {
		for (const e of [...expected.snapshot.entries, ...expected.delta.entries]) expect(hex(keyHash(e.key))).toBe(e.hash);
	});
});

describe('list snapshot', () => {
	it('verifies and decodes every entry', async () => {
		const file = await verifyList(snapshotBytes, keys);
		expect(file.kind).toBe('snapshot');
		expect(file.sequence).toBe(42);
		expect(file.created).toBe(expected.snapshot.created);
		expect(file.count).toBe(expected.snapshot.entries.length);
		const got = rows(file.entries);
		expected.snapshot.entries.forEach((x, i) => {
			const g = got[i]!;
			expect(g.hash).toBe(x.hash);
			expect(g.e!.verdict).toBe(x.verdict);
			expect(g.e!.signals).toEqual([...x.signals].sort((a, b) => signalOrder(a) - signalOrder(b)));
			expect(g.e!.slopType).toBe(x.slop_type ?? null);
			expect([...g.e!.tests].sort()).toEqual([...(x.tests ?? [])].sort());
			expect(g.e!.large).toBe(!!x.large);
			expect(g.e!.imported).toBe(!!x.imported);
			expect(g.e!.staffReviewed).toBe(!!x.staff_reviewed);
			expect(g.e!.item).toBe(x.key.split(':')[1] === 'i');
			expect(dayToDate(g.e!.updated).toISOString().replace('.000', '')).toBe(x.updated);
		});
	});

	it('rejects a tampered byte', async () => {
		const bad = snapshotBytes.slice();
		bad[42] = bad[42]! ^ 1; // first entry's signals
		await expect(verifyList(bad, keys)).rejects.toThrow('bad signature');
		const badSig = snapshotBytes.slice();
		badSig[badSig.length - 1] = badSig[badSig.length - 1]! ^ 1;
		await expect(verifyList(badSig, keys)).rejects.toThrow('bad signature');
	});

	it('rejects a wrong length, magic or version', () => {
		expect(() => parseList(snapshotBytes.slice(0, -1))).toThrow('bad length');
		const magic = snapshotBytes.slice();
		magic[0] = 0x58;
		expect(() => parseList(magic)).toThrow('bad magic');
		const version = snapshotBytes.slice();
		version[4] = 2;
		expect(() => parseList(version)).toThrow('unsupported version');
	});

	it('rejects entries out of order even before checking the signature', () => {
		const swapped = snapshotBytes.slice();
		const a = swapped.slice(32, 48);
		const b = swapped.slice(48, 64);
		swapped.set(b, 32);
		swapped.set(a, 48);
		expect(() => parseList(swapped)).toThrow('entries not sorted');
	});

	it('rejects a list signed by an unknown key', async () => {
		const other = await importKeys([btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))]);
		await expect(verifyList(snapshotBytes, other)).rejects.toThrow('bad signature');
	});
});

describe('list delta', () => {
	it('applies on top of its base and matches the expected final state', async () => {
		const snap = await verifyList(snapshotBytes, keys);
		const delta = await verifyList(deltaBytes, keys);
		expect(delta.kind).toBe('delta');
		expect(delta.base).toBe(snap.sequence);
		expect(delta.sequence).toBe(43);
		const next = applyDelta(snap.entries, delta);
		expect(next.length / ENTRY).toBe(expected.after_delta_count);
		const index = new ListIndex(next);
		expect(index.lookup('yt:i:dQw4w9WgXcQ')).toBeNull();
		expect(index.lookup('yt:s:@catrescuetales')!.verdict).toBe('slop');
		expect(index.lookup('tt:i:7412345678901234567')!.verdict).toBe('likely_slop');
		expect(index.lookup('yt:s:@aihistorydaily')!.verdict).toBe('slop');
		// The result is still sorted, so it parses as a list body.
		for (let i = ENTRY; i < next.length; i += ENTRY) expect(hex(next.subarray(i - ENTRY, i - 8)) < hex(next.subarray(i, i + 8))).toBe(true);
	});

	it('only applies to a delta', async () => {
		const snap = await verifyList(snapshotBytes, keys);
		expect(() => applyDelta(snap.entries, snap)).toThrow('not a delta');
	});
});

describe('list index', () => {
	it('finds every snapshot entry and misses others', async () => {
		const snap = await verifyList(snapshotBytes, keys);
		const index = new ListIndex(snap.entries);
		for (const e of expected.snapshot.entries) expect(index.lookup(e.key)!.verdict).toBe(e.verdict);
		expect(index.lookup('yt:s:@somebodyelse')).toBeNull();
		// Same hash would need the same key, but the flags check guards platform and type too.
		expect(index.lookup('yt:i:@aihistorydaily')).toBeNull();
	});
});

describe('list encoder', () => {
	const encode = (kind: 'snapshot' | 'delta', l: FixtureList) =>
		// Reversed, so the encoder has to sort.
		encodeList(devKey, { kind, sequence: l.sequence, base: l.base, created: l.created }, l.entries.map((e) => encodeEntry(toEntry(e))).reverse());

	it('reproduces list-snapshot.bin and list-delta.bin byte for byte', async () => {
		expect(hex(await encode('snapshot', expected.snapshot))).toBe(hex(snapshotBytes));
		expect(hex(await encode('delta', expected.delta))).toBe(hex(deltaBytes));
	});

	it('numbers days like the fixture dates and clamps to the u16 field', () => {
		for (const e of expected.snapshot.entries) expect(dayToDate(dayNumber(Date.parse(e.updated) / 1000)).toISOString().replace('.000', '')).toBe(e.updated);
		expect(dayNumber(0)).toBe(0);
		expect(dayNumber(1_577_836_800 + 86_399)).toBe(0);
		expect(dayNumber(1_577_836_800 + 86_400)).toBe(1);
		expect(dayNumber(1e12)).toBe(0xffff);
	});

	it('rejects duplicate hashes and malformed rows', async () => {
		const row = encodeEntry(toEntry(expected.snapshot.entries[0]!));
		const header = { kind: 'snapshot', sequence: 1, base: 0, created: 0 } as const;
		await expect(encodeList(devKey, header, [row, row.slice()])).rejects.toThrow('duplicate hash');
		await expect(encodeList(devKey, header, [row.subarray(0, 15)])).rejects.toThrow('16 bytes');
		expect(() => encodeEntry({ ...toEntry(expected.snapshot.entries[0]!), hash: new Uint8Array(7) })).toThrow('8 bytes');
	});

	it('writes an empty list that verifies', async () => {
		const empty = await encodeList(devKey, { kind: 'snapshot', sequence: 7, base: 0, created: 1790000000 }, []);
		const file = await verifyList(empty, keys);
		expect([file.sequence, file.count]).toEqual([7, 0]);
	});
});

describe('signed envelope', () => {
	const env = JSON.parse(files.configEnvelope);

	it('verifies the config fixture', async () => {
		expect(await verifyEnvelope(env, CONFIG_CONTEXT, keys)).toEqual({ version: 7, note: 'contract fixture' });
	});

	it('signs the same envelope as the fixture', async () => {
		expect(await signEnvelope(devKey, CONFIG_CONTEXT, b64decode(env.payload))).toEqual(env);
	});

	it('rejects the wrong context, a changed payload and an unknown kid', async () => {
		await expect(verifyEnvelope(env, PLAN_CONTEXT, keys)).rejects.toThrow();
		await expect(verifyEnvelope({ ...env, payload: btoa('{"version":99}') }, CONFIG_CONTEXT, keys)).rejects.toThrow();
		await expect(verifyEnvelope({ ...env, kid: '0000000000000000' }, CONFIG_CONTEXT, keys)).rejects.toThrow();
		await expect(verifyEnvelope({ payload: 1 }, CONFIG_CONTEXT, keys)).rejects.toThrow('malformed');
	});
});

describe('plan token', () => {
	const token = files.planToken;
	const claims: PlanTokenPayload = { v: 1, sub: 'acc_fixture', plan: 'plus', trial: false, iat: 1790000000, exp: 1792600000 };

	it('verifies the fixture and gates on exp', async () => {
		const p = await verifyPlanToken(token, keys);
		expect(p).toEqual(claims);
		expect(planActive(p, 1792600000 * 1000 - 1)).toBe(true);
		expect(planActive(p, 1792600000 * 1000)).toBe(false);
	});

	it('issues the same token as the fixture, whatever the key order of the claims', async () => {
		const shuffled = { exp: claims.exp, iat: claims.iat, trial: claims.trial, plan: claims.plan, sub: claims.sub, v: claims.v };
		expect(await issuePlanToken(devKey, shuffled)).toBe(token);
	});

	it('escapes like Go so both servers sign the same bytes', async () => {
		const t = await issuePlanToken(devKey, { ...claims, sub: 'a<b>&\u2028' });
		const payload = new TextDecoder().decode(b64decode(t.split('.')[0]!));
		expect(payload).toBe('{"v":1,"sub":"a\\u003cb\\u003e\\u0026\\u2028","plan":"plus","trial":false,"iat":1790000000,"exp":1792600000}');
		expect((await verifyPlanToken(t, keys))!.sub).toBe('a<b>&\u2028');
	});

	it('rejects a forged payload', async () => {
		const [, sig] = token.split('.');
		const forged = b64url(utf8(JSON.stringify({ v: 1, sub: 'x', plan: 'plus', trial: false, iat: 1, exp: 9999999999 })));
		expect(await verifyPlanToken(`${forged}.${sig}`, keys)).toBeNull();
		expect(await verifyPlanToken('garbage', keys)).toBeNull();
	});
});

describe('canonical source IDs (testdata/contract/canonical-ids.json, shared with the Go server)', () => {
	const vectors = JSON.parse(files.canonicalIds) as { sources: { platform: Platform; raw: string; source: string | null }[] };
	it.each(vectors.sources.map((v) => [v.platform, v.raw, v.source] as const))('%s %j becomes %j', (platform, raw, source) => {
		expect(canonicalSource(platform, raw)).toBe(source);
	});
});
