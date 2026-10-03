// The list decoder, envelope and plan token verifiers against the signed cross-language fixtures.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyDelta, dayToDate, decodeEntry, ENTRY, ListIndex, parseList, verifyList } from '../../src/lib/list';
import { CONFIG_CONTEXT, importKeys, planActive, verifyEnvelope, verifyPlanToken } from '../../src/lib/signing';
import { DEV_PUBLIC_KEY } from '../../src/lib/env';
import { hex } from '../../src/lib/bytes';
import { sha256 } from '../../src/lib/sha256';
import { canonicalSource, keyHash } from '../../src/lib/ids';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => new Uint8Array(readFileSync(new URL(p, root)));
const expected = JSON.parse(readFileSync(new URL('testdata/contract/list-expected.json', root), 'utf8'));
const snapshotBytes = read('testdata/contract/list-snapshot.bin');
const deltaBytes = read('testdata/contract/list-delta.bin');
const keys = await importKeys([DEV_PUBLIC_KEY]);

const VERDICT_NAME = ['removed', 'slop', 'likely_slop', 'ai_made', 'disputed', 'clear'];

function rows(entries: Uint8Array) {
	const out = [];
	for (let at = 0; at < entries.length; at += ENTRY) {
		const e = decodeEntry(entries, at);
		out.push({ hash: hex(entries.subarray(at, at + 8)), verdict: VERDICT_NAME[entries[at + 8]!], e });
	}
	return out;
}

describe('keys', () => {
	it('bundles the dev key from server/testdata', () => {
		expect(readFileSync(new URL('server/testdata/dev-signing.pub', root), 'utf8').trim()).toBe(DEV_PUBLIC_KEY);
		expect(keys[0]!.id).toBe(expected.key_id);
	});
});

describe('sha256', () => {
	it('matches node crypto on many inputs', () => {
		for (let n = 0; n < 300; n++) {
			const s = 'yt:s:@' + 'é'.repeat(n % 7) + 'x'.repeat(n);
			expect(hex(sha256(new TextEncoder().encode(s)))).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
		}
	});
	it('hashes target keys like the fixtures', () => {
		for (const e of expected.snapshot.entries) expect(hex(keyHash(e.key))).toBe(e.hash);
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
		expected.snapshot.entries.forEach((x: any, i: number) => {
			const g = got[i]!;
			expect(g.hash).toBe(x.hash);
			expect(g.e!.verdict).toBe(x.verdict);
			expect(g.e!.signals).toEqual([...x.signals].sort((a: string, b: string) => SIGNAL_ORDER(a) - SIGNAL_ORDER(b)));
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
		const a = swapped.slice(32, 48), b = swapped.slice(48, 64);
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

describe('signed envelope', () => {
	it('verifies the config fixture', async () => {
		const env = JSON.parse(readFileSync(new URL('testdata/contract/config-envelope.json', root), 'utf8'));
		expect(await verifyEnvelope(env, CONFIG_CONTEXT, keys)).toEqual({ version: 7, note: 'contract fixture' });
	});

	it('rejects the wrong context, a changed payload and an unknown kid', async () => {
		const env = JSON.parse(readFileSync(new URL('testdata/contract/config-envelope.json', root), 'utf8'));
		await expect(verifyEnvelope(env, 'colander:plan:v1', keys)).rejects.toThrow();
		await expect(verifyEnvelope({ ...env, payload: btoa('{"version":99}') }, CONFIG_CONTEXT, keys)).rejects.toThrow();
		await expect(verifyEnvelope({ ...env, kid: '0000000000000000' }, CONFIG_CONTEXT, keys)).rejects.toThrow();
		await expect(verifyEnvelope({ payload: 1 }, CONFIG_CONTEXT, keys)).rejects.toThrow('malformed');
	});
});

describe('plan token', () => {
	const token = readFileSync(new URL('testdata/contract/plan-token.txt', root), 'utf8').trim();

	it('verifies the fixture and gates on exp', async () => {
		const p = await verifyPlanToken(token, keys);
		expect(p).toMatchObject({ v: 1, sub: 'acc_fixture', plan: 'plus', trial: false, exp: 1792600000 });
		expect(planActive(p, 1792600000 * 1000 - 1)).toBe(true);
		expect(planActive(p, 1792600000 * 1000)).toBe(false);
	});

	it('rejects a forged payload', async () => {
		const [, sig] = token.split('.');
		const forged = btoa(JSON.stringify({ v: 1, sub: 'x', plan: 'plus', trial: false, iat: 1, exp: 9999999999 }))
			.replace(/=+$/, '')
			.replace(/\+/g, '-')
			.replace(/\//g, '_');
		expect(await verifyPlanToken(`${forged}.${sig}`, keys)).toBeNull();
		expect(await verifyPlanToken('garbage', keys)).toBeNull();
	});
});

import { SIGNALS } from '@colander/shared/verdicts';
function SIGNAL_ORDER(s: string) {
	return (SIGNALS as readonly string[]).indexOf(s);
}

describe('canonical source IDs (testdata/contract/canonical-ids.json, shared with the Go server)', () => {
	const vectors = JSON.parse(readFileSync(new URL('testdata/contract/canonical-ids.json', root), 'utf8')) as {
		sources: { platform: 'yt' | 'tt' | 'ig' | 'fb'; raw: string; source: string | null }[];
	};
	it.each(vectors.sources.map((v) => [v.platform, v.raw, v.source] as const))('%s %j becomes %j', (platform, raw, source) => {
		expect(canonicalSource(platform, raw)).toBe(source);
	});
});
