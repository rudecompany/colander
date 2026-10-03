// The parity harness (hosting plan section 4): drives the Go server and the Worker through the
// same story from fresh state, both with the clock frozen by COLANDER_TEST_NOW, and diffs what
// they hold after each step: every stored table (verdicts, signals, decision log reasons,
// escalations, report and appeal statuses and the rest) and the signed list files byte for byte.
//
//   pnpm -C e2e parity
//
// The story: the seed-dev demo data; the operator commands (grant-role, sign-config, import-seed);
// then the clock moves on 15, 40, 80 and 200 days, so appeals expire, the burst freeze thaws,
// old list versions leave the 30-day window, and reviewer and community verdicts lapse and are
// scored again. Each step ends the way the Go server starts (publish, full pass, publish), which
// the Worker does through /__dev/settle.
//
// Go listens on 127.0.0.1:8845 and the Worker on 8846 (inspector 8946); PARITY_GO_PORT and
// PARITY_WORKER_PORT move them. State and logs live in e2e/.run/parity, and report.json there
// lists every difference. The exit code is 1 when anything differs.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { devKey, diffState, explainLists, readList, renumber, state } from './compare.ts';

// node:sqlite still announces itself as experimental on Node 24; that notice is expected here.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: never[]) => {
	if (!String(warning).includes('SQLite is an experimental feature')) emitWarning.call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const REPO = resolve(import.meta.dirname, '../..');
const RUN = resolve(REPO, 'e2e/.run/parity');
const GO_PORT = Number(process.env.PARITY_GO_PORT) || 8845;
const WORKER_PORT = Number(process.env.PARITY_WORKER_PORT) || 8846;
const GO = `http://127.0.0.1:${GO_PORT}`;
const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const SEED = readFileSync(resolve(REPO, 'server/testdata/dev-signing.key'), 'utf8').trim();
const KEY = devKey(SEED, readFileSync(resolve(REPO, 'server/testdata/dev-signing.pub'), 'utf8').trim());
const OPS_TOKEN = 'parity-ops-token';
const T0 = Date.parse('2026-05-01T12:00:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failures: string[] = [];
const report: Record<string, unknown> = {};
function check(step: string, what: string, ok: boolean, detail?: unknown): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${step}: ${what}`);
	if (!ok) {
		failures.push(`${step}: ${what}`);
		(report[step] ??= {}) as Record<string, unknown>;
		(report[step] as Record<string, unknown>)[what] = detail;
		if (detail !== undefined) console.log(JSON.stringify(detail, null, 2).split('\n').slice(0, 60).join('\n'));
	}
}

// ---- The two servers ----

/** A server process, started in its own process group so stopping it stops its children too. */
class Proc {
	child?: ChildProcess;
	readonly name: string;
	readonly log: string;
	constructor(name: string, log: string) {
		this.name = name;
		this.log = log;
	}

	start(cmd: string, args: string[], env: Record<string, string>, cwd = REPO): void {
		const out = openSync(this.log, 'a');
		this.child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], detached: true });
		console.log(`      started ${this.name} (pid ${this.child.pid})`);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((r) => child.once('exit', r));
		process.kill(-child.pid!, 'SIGTERM');
		await Promise.race([exited, sleep(10_000)]);
		if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL');
		this.child = undefined;
	}

	async ready(url: string): Promise<void> {
		const deadline = Date.now() + 90_000;
		for (;;) {
			if (this.child?.exitCode !== null) throw new Error(`${this.name} exited:\n${readFileSync(this.log, 'utf8').slice(-4000)}`);
			if (await fetch(url).then((r) => r.ok, () => false)) return;
			if (Date.now() > deadline) throw new Error(`${this.name} did not answer ${url}:\n${readFileSync(this.log, 'utf8').slice(-4000)}`);
			await sleep(200);
		}
	}
}

const goLog = resolve(RUN, 'go.log');
const go = new Proc('the Go server', goLog);
const worker = new Proc('the Worker (wrangler dev)', resolve(RUN, 'worker.log'));
const bin = resolve(RUN, 'colander');
const goEnv = (now: number) => ({
	COLANDER_DB: resolve(RUN, 'go.db'),
	COLANDER_SIGNING_KEY: resolve(REPO, 'server/testdata/dev-signing.key'),
	COLANDER_DEV: '1',
	COLANDER_TEST_NOW: iso(now),
	COLANDER_ADDR: `127.0.0.1:${GO_PORT}`,
	COLANDER_PUBLIC_URL: GO,
	COLANDER_SITE_DIR: resolve(RUN, 'no-site')
});

/** Runs an operator command of the Go binary; returns whether it succeeded. */
function goCli(now: number, ...args: string[]): boolean {
	try {
		execFileSync(bin, args, { env: { ...process.env, ...goEnv(now) }, stdio: ['ignore', 'pipe', 'pipe'] });
		return true;
	} catch {
		return false;
	}
}

/**
 * Starts the Go server, which publishes, runs a full pass and publishes what changed, and waits
 * until that is done: the pass is logged, and the list stays the same for a second.
 */
async function startGo(now: number): Promise<void> {
	const before = existsSync(goLog) ? readFileSync(goLog).length : 0;
	go.start(bin, ['serve'], goEnv(now));
	await go.ready(`${GO}/healthz`);
	for (const deadline = Date.now() + 30_000; !readFileSync(goLog).subarray(before).toString().includes('msg="scoring pass"'); await sleep(100)) {
		if (Date.now() > deadline) throw new Error('the Go server ran no scoring pass after starting');
	}
	let seq = '';
	for (;;) {
		await sleep(1000);
		const next = (await fetch(`${GO}/v1/list/snapshot`)).headers.get('x-colander-sequence') ?? '';
		if (next === seq) return;
		seq = next;
	}
}

async function startWorker(now: number): Promise<void> {
	if (existsSync(resolve(REPO, 'api/.dev.vars'))) throw new Error('api/.dev.vars would override the harness secrets in wrangler dev: move it aside for the parity run.');
	const vars = { COLANDER_DEV: '1', COLANDER_TEST_NOW: iso(now), COLANDER_SIGNING_KEY: SEED, IP_SALT: 'parity-ip-salt', OPS_TOKEN };
	worker.start(
		process.execPath,
		[
			resolve(REPO, 'api/node_modules/wrangler/bin/wrangler.js'),
			'dev',
			'--ip=127.0.0.1',
			`--port=${WORKER_PORT}`,
			`--inspector-port=${WORKER_PORT + 100}`,
			`--persist-to=${resolve(RUN, 'wrangler')}`,
			'--show-interactive-dev-session=false',
			...Object.entries(vars).map(([k, v]) => `--var=${k}:${v}`)
		],
		// Secrets declared in wrangler.jsonc are read from the process environment too.
		{ ...vars, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' },
		resolve(REPO, 'api')
	);
	await worker.ready(`${WORKER}/healthz`);
}

async function call(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const res = await fetch(origin + path, init);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: res.status, body };
}

const ops = (command: string, args: object) =>
	call(WORKER, `/ops/${command}`, { method: 'POST', headers: { Authorization: `Bearer ${OPS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });

async function settleWorker(): Promise<void> {
	const res = await call(WORKER, '/__dev/settle', { method: 'POST' });
	if (res.status !== 200) throw new Error(`/__dev/settle answered ${res.status} ${JSON.stringify(res.body)}`);
}

// ---- Comparing ----

interface Heads {
	go: bigint;
	worker: bigint;
}

async function snapshot(origin: string): Promise<{ bytes: Buffer; header: ReturnType<typeof readList>; seqHeader: string }> {
	const res = await fetch(`${origin}/v1/list/snapshot`);
	if (res.status !== 200) throw new Error(`${origin} snapshot answered ${res.status}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	return { bytes, header: readList(bytes, KEY), seqHeader: res.headers.get('x-colander-sequence') ?? '' };
}

/** Compares the stored state and the snapshot, and returns both heads. */
async function compare(step: string): Promise<Heads> {
	const goDb = new DatabaseSync(resolve(RUN, 'go.db'), { readOnly: true });
	const goState = state(goDb);
	goDb.close();
	const dump = await (await fetch(`${WORKER}/__dev/dump`)).text();
	const workerDb = new DatabaseSync(':memory:');
	workerDb.exec(dump);
	const integrity = workerDb.prepare('PRAGMA integrity_check').all();
	check(step, "the Worker's dump loads into stock SQLite and passes integrity_check", JSON.stringify(integrity) === '[{"integrity_check":"ok"}]', integrity);
	const diff = diffState(goState, state(workerDb));
	workerDb.close();
	const rows = Object.values(goState).reduce((n, t) => n + t.length, 0);
	check(step, `stored state is the same in every table (${rows} rows)`, Object.keys(diff).length === 0, diff);

	const g = await snapshot(GO);
	const w = await snapshot(WORKER);
	check(step, 'X-Colander-Sequence names the file sequence on both', g.seqHeader === String(g.header.sequence) && w.seqHeader === String(w.header.sequence));
	const same = renumber(g.bytes, w.header.sequence, 0n, KEY).equals(w.bytes);
	check(step, `signed snapshot is byte-identical with the sequence mapped (Go ${g.header.sequence} is Worker ${w.header.sequence}, ${w.header.count} entries)`, same, same ? undefined : explainLists(g.bytes, w.bytes));
	return { go: g.header.sequence, worker: w.header.sequence };
}

/** Compares the delta each server serves from its own sequence of an earlier step. */
async function compareDelta(step: string, what: string, base: Heads, head: Heads): Promise<void> {
	const g = await fetch(`${GO}/v1/list/delta?since=${base.go}`);
	const w = await fetch(`${WORKER}/v1/list/delta?since=${base.worker}`);
	const gb = Buffer.from(await g.arrayBuffer());
	const wb = Buffer.from(await w.arrayBuffer());
	if (g.status !== 200 || w.status !== 200) {
		const codes = (b: Buffer) => (b.length ? (JSON.parse(b.toString()) as { error?: { code: string } }).error?.code : '');
		check(step, `${what}: both answer ${g.status} (${codes(gb) || 'no body'})`, g.status === w.status && codes(gb) === codes(wb), { go: g.status, worker: w.status });
		return;
	}
	readList(gb, KEY);
	const header = readList(wb, KEY);
	const same = renumber(gb, head.worker, base.worker, KEY).equals(wb);
	check(step, `${what}: signed delta is byte-identical with the sequences mapped (${header.count} entries)`, same, same ? undefined : explainLists(gb, wb));
}

/** The list endpoints' edge cases against the current heads. */
async function compareListEdges(step: string, head: Heads, first: Heads): Promise<void> {
	await compareDelta(step, 'delta from the head', head, head);
	await compareDelta(step, 'delta from a sequence after the head', { go: head.go + 1n, worker: head.worker + 1n }, head);
	await compareDelta(step, "delta from the seed's first sequence", first, head);
	const g = await call(GO, '/v1/list/delta?since=abc');
	const w = await call(WORKER, '/v1/list/delta?since=abc');
	check(step, 'a malformed since is 400 invalid_since on both', g.status === 400 && w.status === 400 && g.body.error.code === w.body.error.code, { go: g, worker: w });
}

// ---- The story ----

const seedList = [
	'! A synthetic seed list: comments, blank lines, CRLF, mixed case, encoded handles, duplicates and junk',
	'@SlopFactoryOne',
	'',
	'@slopfactoryone',
	'UCzzzzzzzzzzzzzzzzzzzzz9\r',
	'  @Espa%C3%B1olSlop  ',
	'@biblestoriesanimated',
	'https://www.youtube.com/@notahandleline',
	'not a channel',
	'@dailymotivationmachine'
].join('\n');
const warnList = ['@aimadebutfine', '@catrescuetales', '@SlopFactoryOne'].join('\n');
const configs = ['{"version":7,"note":"contract fixture"}', '{\n  "version": 8,\n  "note": "naïve ✓ <selectors> & more"\n}\n'];

async function main(): Promise<void> {
	rmSync(RUN, { recursive: true, force: true });
	mkdirSync(RUN, { recursive: true });
	console.log('Building the Go server');
	execFileSync('go', ['build', '-o', bin, './cmd/colander'], { cwd: resolve(REPO, 'server'), stdio: 'inherit' });
	if (!existsSync(resolve(REPO, 'web/build/index.html'))) {
		console.log('Building the website, which wrangler dev serves as static assets');
		execFileSync('pnpm', ['-C', 'web', 'build'], { cwd: REPO, stdio: 'inherit' });
	}

	// 1. The demo data, made by each implementation's own seeder.
	let now = T0;
	let step = 'seed';
	console.log(`\n${step} at ${iso(now)}`);
	if (!goCli(now, 'seed-dev')) throw new Error('seed-dev failed on the Go side');
	await startGo(now);
	await startWorker(now);
	const seeded = await call(WORKER, '/__dev/seed', { method: 'POST' });
	if (seeded.status !== 200) throw new Error(`/__dev/seed answered ${seeded.status} ${JSON.stringify(seeded.body)}`);
	await settleWorker();
	const first = { go: 1n, worker: BigInt(Math.floor((T0 - DAY) / 1000)) };
	let head = await compare(step);
	await compareListEdges(step, head, first);

	// 2. The operator commands: the Go binary's CLI against the ops channel.
	step = 'ops';
	console.log(`\n${step} at ${iso(now)}`);
	await go.stop();
	const goOk: boolean[] = [];
	const workerOk: boolean[] = [];
	const both = async (goArgs: string[], command: string, args: object) => {
		goOk.push(goCli(now, ...goArgs));
		workerOk.push((await ops(command, args)).status === 200);
	};
	await both(['grant-role', 'Curator@Colander.TEST', 'curator'], 'grant-role', { email: 'Curator@Colander.TEST', role: 'curator' });
	await both(['grant-role', 'sam@colander.test', 'staff'], 'grant-role', { email: 'sam@colander.test', role: 'staff' });
	await both(['grant-role', 'not an email', 'staff'], 'grant-role', { email: 'not an email', role: 'staff' });
	await both(['grant-role', 'rae@colander.test', 'admin'], 'grant-role', { email: 'rae@colander.test', role: 'admin' });
	for (const [i, config] of configs.entries()) {
		const file = resolve(RUN, `config-${i}.json`);
		writeFileSync(file, config);
		await both(['sign-config', file], 'sign-config', { file: config });
	}
	await both(['sign-config', resolve(RUN, 'config-0.json'), 'extra'], 'sign-config', { file: '[1, 2]' });
	const lists = [
		[seedList, 'blocklist'],
		[warnList, 'warnlist']
	] as const;
	for (const [i, [text, list]] of lists.entries()) {
		const file = resolve(RUN, `seed-${i}.txt`);
		writeFileSync(file, text);
		const flags = ['--file', file, '--list', list, '--source-name', 'Parity list', '--license', 'CC0 (fictional)'];
		await both(['import-seed', ...flags], 'import-seed', { file: text, list, source_name: 'Parity list', license: 'CC0 (fictional)', accept_license: false });
		await both(['import-seed', ...flags, '--accept-license'], 'import-seed', { file: text, list, source_name: 'Parity list', license: 'CC0 (fictional)', accept_license: true });
	}
	check(step, `the same commands succeed and fail (${goOk.map(Number).join('')})`, JSON.stringify(goOk) === JSON.stringify(workerOk), { go: goOk, worker: workerOk });
	await startGo(now);
	await settleWorker();
	let next = await compare(step);
	await compareDelta(step, 'delta from the seed step', head, next);
	head = next;
	await compareListEdges(step, head, first);

	// 3. Time passes: expiries, thaws, the 30-day window and lapses.
	for (const days of [15, 40, 80, 200]) {
		now = T0 + days * DAY;
		step = `+${days} days`;
		console.log(`\n${step} at ${iso(now)}`);
		await go.stop();
		await worker.stop();
		await startGo(now);
		await startWorker(now);
		await settleWorker();
		next = await compare(step);
		await compareDelta(step, 'delta from the step before', head, next);
		head = next;
		await compareListEdges(step, head, first);
	}
}

try {
	await main();
} catch (err) {
	failures.push(String(err));
	console.error(err);
} finally {
	await go.stop();
	await worker.stop();
	writeFileSync(resolve(RUN, 'report.json'), JSON.stringify({ failures, details: report }, null, 2));
}
if (failures.length) {
	console.log(`\nParity failed: ${failures.length} difference(s). Details in e2e/.run/parity/report.json and the logs beside it.`);
	process.exit(1);
}
console.log('\nParity holds: the Go server and the Worker agree on every step.');
