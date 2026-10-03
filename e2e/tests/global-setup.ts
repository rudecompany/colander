// Builds the website and the extension, starts the Worker under `wrangler dev` from fresh local
// state, seeds it and drives its first crons, for the whole run (hosting plan section 4). The
// returned function stops it. With COLANDER_E2E_BASE_URL nothing is built or started: the specs run
// against that origin, and those that need the local stack skip themselves.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { BASE_URL, EXT_ID, LOG, REPO, RUN, STAFF, apiSignIn } from './stack.ts';

const free = (port: number) =>
	new Promise<boolean>((done) => {
		const s = createServer()
			.once('error', () => done(false))
			.listen(port, '127.0.0.1', () => s.close(() => done(true)));
	});

const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
	execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });

export default async function globalSetup() {
	if (BASE_URL) {
		process.env.COLANDER_E2E_ORIGIN = BASE_URL;
		return;
	}
	// 8787 is the dev default; stay clear of a dev server someone has running. The inspector takes
	// the port 100 above.
	let port = Number(process.env.COLANDER_E2E_PORT) || 8791;
	while (!(await free(port)) || !(await free(port + 100))) port++;
	const origin = `http://127.0.0.1:${port}`;

	rmSync(RUN, { recursive: true, force: true });
	mkdirSync(RUN, { recursive: true });
	run('pnpm', ['-C', 'web', 'build'], REPO, { PUBLIC_EXTENSION_ID: EXT_ID });
	// A copy, so a web test run that rebuilds web/build cannot change the site under this Worker.
	const site = resolve(RUN, 'site');
	cpSync(resolve(REPO, 'web/build'), site, { recursive: true });
	run('pnpm', ['-C', 'extension', 'build:e2e'], REPO, {
		WXT_COLANDER_API: origin,
		WXT_COLANDER_SITE: origin,
		COLANDER_EXT_OUT_DIR: resolve(RUN, 'extension')
	});

	// The dev signing key and dev mode, and no Stripe, YouTube or Resend keys: billing answers 503,
	// appeals fall back to manual checks and mail is printed. An --env-file keeps a developer's
	// api/.dev.vars out of the run; the same values in the environment win over a developer's shell.
	const vars: Record<string, string> = {
		COLANDER_DEV: '1',
		PUBLIC_URL: origin,
		COLANDER_SIGNING_KEY: readFileSync(resolve(REPO, 'server/testdata/dev-signing.key'), 'utf8').trim(),
		IP_SALT: 'e2e-ip-salt',
		OPS_TOKEN: 'e2e-ops-token'
	};
	const envFile = resolve(RUN, 'dev.vars');
	writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(''));
	const out = openSync(LOG, 'w');
	const wrangler = spawn(
		process.execPath,
		[
			resolve(REPO, 'api/node_modules/wrangler/bin/wrangler.js'),
			'dev',
			'--ip=127.0.0.1',
			`--port=${port}`,
			`--inspector-port=${port + 100}`,
			`--persist-to=${resolve(RUN, 'state')}`,
			`--env-file=${envFile}`,
			`--assets=${site}`,
			'--test-scheduled',
			'--show-interactive-dev-session=false'
		],
		{
			cwd: resolve(REPO, 'api'),
			env: { ...process.env, ...vars, WRANGLER_SEND_METRICS: 'false' },
			stdio: ['ignore', out, out],
			// Its own process group, so stopping it stops workerd too.
			detached: true
		}
	);
	const exited = new Promise<void>((done) => wrangler.once('exit', () => done()));
	const running = () => wrangler.exitCode === null && wrangler.signalCode === null;
	const kill = (signal: NodeJS.Signals) => {
		if (running()) process.kill(-wrangler.pid!, signal);
	};
	process.once('exit', () => kill('SIGKILL'));

	const deadline = Date.now() + 60_000;
	for (;;) {
		if (!running()) throw new Error(`wrangler dev exited:\n${readFileSync(LOG, 'utf8')}`);
		const ok = await fetch(`${origin}/healthz`).then((r) => r.ok, () => false);
		if (ok) break;
		if (Date.now() > deadline) {
			kill('SIGKILL');
			throw new Error(`wrangler dev did not answer /healthz:\n${readFileSync(LOG, 'utf8')}`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	// The demo data, then what the Go server did when it started (publish, full pass, publish),
	// then the watchdog cron, which schedules the recurring jobs (scoring pass, pruning, dumps).
	const step = async (what: string, path: string, method = 'POST') => {
		const res = await fetch(origin + path, { method });
		if (!res.ok) {
			kill('SIGKILL');
			throw new Error(`${what} answered ${res.status}: ${await res.text()}`);
		}
	};
	await step('the seed', '/__dev/seed');
	await step('settling', '/__dev/settle');
	await step('the watchdog cron', `/cdn-cgi/local/scheduled?cron=${encodeURIComponent('*/5 * * * *')}`, 'GET');

	process.env.COLANDER_E2E_ORIGIN = origin;
	process.env.COLANDER_E2E_STAFF_COOKIE = await apiSignIn(STAFF);

	return async () => {
		kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
		kill('SIGKILL');
	};
}
