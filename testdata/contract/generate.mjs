// Generates the cross-language contract fixtures described in docs/contracts.md.
// Both the Go server and the extension test against these exact bytes, so encoders must be byte-identical.
// Usage: node testdata/contract/generate.mjs
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const seed = Buffer.from(readFileSync(join(root, 'server/testdata/dev-signing.key'), 'utf8').trim(), 'base64');
const pub = Buffer.from(readFileSync(join(root, 'server/testdata/dev-signing.pub'), 'utf8').trim(), 'base64');
// PKCS#8 wrapper for a raw Ed25519 seed.
const key = createPrivateKey({
	key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
	format: 'der',
	type: 'pkcs8'
});
const keyId = createHash('sha256').update(pub).digest().subarray(0, 8);

const PLATFORM = { yt: 0, tt: 1, ig: 2, fb: 3 };
const VERDICT = { removed: 0, slop: 1, likely_slop: 2, ai_made: 3, disputed: 4, clear: 5 };
const SLOP_TYPE = { none: 0, filler: 1, bait: 2, deceptive: 3 };
const TEST_BIT = { low_effort: 2, mass_produced: 3, hollow: 4 };
const SIGNALS = [
	'platform_label', 'content_credentials', 'creator_statement', 'watermark', 'high_volume', 'mostly_ai',
	'templated', 'near_duplicates', 'link_funnel', 'cross_posting', 'rubric_low_effort', 'rubric_hollow',
	'community_consensus', 'staff_review', 'open_appeal', 'not_slop_consensus'
];
const EPOCH = Date.UTC(2020, 0, 1);

const hashKey = (k) => createHash('sha256').update(k, 'utf8').digest().subarray(0, 8);
const day = (iso) => Math.floor((Date.parse(iso) - EPOCH) / 86400000);

function encodeEntry(e) {
	const b = Buffer.alloc(16);
	hashKey(e.key).copy(b, 0);
	b[8] = VERDICT[e.verdict];
	const [platform, type] = e.key.split(':');
	b[9] =
		PLATFORM[platform] |
		((type === 'i' ? 1 : 0) << 3) |
		((e.large ? 1 : 0) << 4) |
		((e.imported ? 1 : 0) << 5) |
		((e.staff_reviewed ? 1 : 0) << 6);
	b.writeUInt16LE(e.signals.reduce((m, s) => m | (1 << SIGNALS.indexOf(s)), 0), 10);
	b[12] = SLOP_TYPE[e.slop_type ?? 'none'] | (e.tests ?? []).reduce((m, t) => m | (1 << TEST_BIT[t]), 0);
	b[13] = 0;
	b.writeUInt16LE(day(e.updated), 14);
	return b;
}

function encodeList(kind, sequence, base, created, entries) {
	const rows = entries.map((e) => ({ e, b: encodeEntry(e) })).sort((x, y) => Buffer.compare(x.b.subarray(0, 8), y.b.subarray(0, 8)));
	const head = Buffer.alloc(32);
	head.write('CLDL', 0, 'ascii');
	head[4] = 1;
	head[5] = kind;
	head.writeUInt16LE(0, 6);
	head.writeBigUInt64LE(BigInt(sequence), 8);
	head.writeBigUInt64LE(BigInt(base), 16);
	head.writeUInt32LE(created, 24);
	head.writeUInt32LE(rows.length, 28);
	const body = Buffer.concat([head, ...rows.map((r) => r.b)]);
	const sig = sign(null, body, key);
	return {
		bytes: Buffer.concat([body, keyId, sig]),
		decoded: rows.map(({ e, b }) => ({ ...e, hash: b.subarray(0, 8).toString('hex') }))
	};
}

const snapshotEntries = [
	{ key: 'yt:s:UCaaaaaaaaaaaaaaaaaaaaaa', verdict: 'slop', signals: ['platform_label', 'mostly_ai', 'community_consensus', 'staff_review'], slop_type: 'filler', tests: ['low_effort', 'mass_produced'], staff_reviewed: true, updated: '2026-09-30T00:00:00Z' },
	{ key: 'yt:s:@aihistorydaily', verdict: 'slop', signals: ['platform_label', 'mostly_ai', 'community_consensus', 'staff_review'], slop_type: 'filler', tests: ['low_effort', 'mass_produced'], staff_reviewed: true, updated: '2026-09-30T00:00:00Z' },
	{ key: 'yt:s:@catrescuetales', verdict: 'likely_slop', signals: ['mostly_ai', 'rubric_hollow'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'], imported: true, updated: '2026-08-01T00:00:00Z' },
	{ key: 'yt:i:dQw4w9WgXcQ', verdict: 'ai_made', signals: ['platform_label'], updated: '2026-09-15T00:00:00Z' },
	{ key: 'tt:s:@sloppyfacts', verdict: 'disputed', signals: ['platform_label', 'open_appeal'], large: true, updated: '2026-10-01T00:00:00Z' },
	{ key: 'ig:s:handmadepottery', verdict: 'clear', signals: ['not_slop_consensus'], updated: '2026-07-04T00:00:00Z' },
	{ key: 'fb:i:pfbid02abcDEF', verdict: 'slop', signals: ['creator_statement', 'link_funnel', 'community_consensus'], slop_type: 'bait', tests: ['hollow', 'low_effort'], updated: '2026-09-29T00:00:00Z' }
];
const snapshot = encodeList(0, 42, 0, 1790000000, snapshotEntries);

const deltaEntries = [
	{ key: 'yt:s:@catrescuetales', verdict: 'slop', signals: ['mostly_ai', 'community_consensus', 'staff_review'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'], staff_reviewed: true, updated: '2026-10-02T00:00:00Z' },
	{ key: 'yt:i:dQw4w9WgXcQ', verdict: 'removed', signals: [], updated: '2026-10-02T00:00:00Z' },
	{ key: 'tt:i:7412345678901234567', verdict: 'likely_slop', signals: ['platform_label', 'rubric_low_effort'], tests: ['low_effort', 'hollow'], updated: '2026-10-02T00:00:00Z' }
];
const delta = encodeList(1, 43, 42, 1790003600, deltaEntries);

writeFileSync(join(here, 'list-snapshot.bin'), snapshot.bytes);
writeFileSync(join(here, 'list-delta.bin'), delta.bytes);
writeFileSync(
	join(here, 'list-expected.json'),
	JSON.stringify(
		{
			key_id: keyId.toString('hex'),
			public_key: pub.toString('base64'),
			snapshot: { sequence: 42, base: 0, created: 1790000000, entries: snapshot.decoded },
			delta: { sequence: 43, base: 42, created: 1790003600, entries: delta.decoded },
			after_delta_count: 7
		},
		null,
		2
	) + '\n'
);

function signedEnvelope(context, payloadBytes) {
	const msg = Buffer.concat([Buffer.from(context, 'ascii'), Buffer.from([0]), payloadBytes]);
	return sign(null, msg, key);
}

const configPayload = Buffer.from(JSON.stringify({ version: 7, note: 'contract fixture' }), 'utf8');
writeFileSync(
	join(here, 'config-envelope.json'),
	JSON.stringify(
		{
			kid: keyId.toString('hex'),
			payload: configPayload.toString('base64'),
			sig: signedEnvelope('colander:config:v1', configPayload).toString('base64')
		},
		null,
		2
	) + '\n'
);

const planPayload = Buffer.from(
	JSON.stringify({ v: 1, sub: 'acc_fixture', plan: 'plus', trial: false, iat: 1790000000, exp: 1792600000 }),
	'utf8'
);
const b64u = (b) => b.toString('base64url');
writeFileSync(
	join(here, 'plan-token.txt'),
	`${b64u(planPayload)}.${b64u(signedEnvelope('colander:plan:v1', planPayload))}\n`
);

console.log('snapshot', snapshot.bytes.length, 'bytes; delta', delta.bytes.length, 'bytes; key id', keyId.toString('hex'));
