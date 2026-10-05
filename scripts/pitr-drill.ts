// Point-in-time restore drill, run monthly on staging by drills.yml (hosting plan section 3).
// It writes a marker, restores the Store to just before it, and proves that the marker is gone,
// that the list sequence went up instead of back, and that a client holding a sequence the
// restore erased recovers through 410 and a fresh signed snapshot.
//
// Env: COLANDER_BASE_URL, COLANDER_PUBLIC_KEYS, and on staging CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET. In a GitHub workflow with id-token: write it calls the ops channel with
// OIDC tokens it asks GitHub for; elsewhere with OPS_TOKEN. The ops contract is in docs/deploy.md.
import { randomBytes } from 'node:crypto';
import { expect, fetchSnapshot, header, http, json, ops, sleep, trustedKeys } from './smoke.ts';

const need = (name: string): string => {
	const v = process.env[name]?.trim();
	if (!v) throw new Error(`${name} is not set`);
	return v;
};
const keys = trustedKeys(need('COLANDER_PUBLIC_KEYS'));

interface Status {
	head_seq: number;
	r2_seq: number;
}

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const v = await probe().catch(() => undefined);
		if (v !== undefined) return v;
		expect(Date.now() < deadline, `timed out after ${seconds} s waiting for ${what}`);
		await sleep(2000);
	}
}

// The public source page carries the channel's decision log; the edge keeps it up to 60 s.
const source = '/v1/sources/yt/@colander-drill';
async function history(): Promise<{ reason: string }[]> {
	const res = await http(source);
	const body = await json(res);
	if (res.status === 404) return [];
	expect(res.status === 200, `GET ${source} answered ${res.status} ${JSON.stringify(body)}`);
	return body.history ?? [];
}

const marker = `PITR drill marker ${process.env.GITHUB_RUN_ID ?? randomBytes(6).toString('hex')}`;
const before = await ops<Status>('status');
console.log(`Before: Store head ${before.head_seq}, R2 head ${before.r2_seq}`);

// The restore target is a moment before the marker exists.
const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
await sleep(5000);

await ops('check-decision', { source: '@colander-drill', reason: marker });
await until('the marker in the decision log', 90, async () => ((await history()).some((e) => e.reason === marker) ? true : undefined));

// The marker changed the list, so a new sequence reaches R2. A client may now hold it.
const marked = await until('the marker publication', 60, async () => {
	const s = await ops<Status>('status');
	return s.r2_seq > before.head_seq ? s : undefined;
});
const erased = BigInt(marked.r2_seq);
console.log(`Marker published as sequence ${erased}; restoring to ${at}`);

const restore = await ops('pitr-restore', { at, confirm: at });
console.log(`Restore answered ${JSON.stringify(restore)}`);

// The Store restarts on the restored state and must publish above the sequence R2 already has.
const after = await until('the Store to publish above the erased sequence', 180, async () => {
	const s = await ops<Status>('status');
	return BigInt(s.head_seq) > erased ? s : undefined;
});
console.log(`After: Store head ${after.head_seq}, R2 head ${after.r2_seq}`);

expect(!(await history()).some((e) => e.reason === marker), 'the marker survived the restore');

const gone = await http(`/v1/list/delta?since=${erased}`);
await gone.arrayBuffer();
expect(gone.status === 410, `a client holding the erased sequence ${erased} got ${gone.status}, not 410`);

const { res, list } = await fetchSnapshot(keys);
expect(list.sequence > erased, `the snapshot has sequence ${list.sequence}, not above the erased ${erased} (cf-cache-status ${header(res, 'cf-cache-status')})`);

console.log(`PITR drill passed: marker gone, sequence ${erased} answers 410, snapshot ${list.sequence} verifies with key ${list.keyId}.`);
