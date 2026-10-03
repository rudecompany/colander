// Builds the server, the website and the extension, seeds a fresh database and starts the real
// server for the whole run. The returned function stops it.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { EXT_ID, LOG, REPO, RUN, STAFF, apiSignIn } from './stack.ts';

const free = (port: number) =>
	new Promise<boolean>((done) => {
		const s = createServer()
			.once('error', () => done(false))
			.listen(port, '127.0.0.1', () => s.close(() => done(true)));
	});

const run = (cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) =>
	execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });

export default async function globalSetup() {
	// 8787 is the dev default; stay clear of a dev server someone has running.
	let port = Number(process.env.COLANDER_E2E_PORT) || 8791;
	while (!(await free(port))) port++;
	const origin = `http://127.0.0.1:${port}`;

	rmSync(RUN, { recursive: true, force: true });
	mkdirSync(RUN, { recursive: true });
	const bin = resolve(RUN, 'colander');
	run('go', ['build', '-o', bin, './cmd/colander'], resolve(REPO, 'server'));
	run('pnpm', ['-C', 'web', 'build'], REPO, { PUBLIC_EXTENSION_ID: EXT_ID });
	// A copy, so a web test run that rebuilds web/build cannot change the site under this server.
	cpSync(resolve(REPO, 'web/build'), resolve(RUN, 'site'), { recursive: true });
	run('pnpm', ['-C', 'extension', 'build:e2e'], REPO, {
		WXT_COLANDER_API: origin,
		WXT_COLANDER_SITE: origin,
		COLANDER_EXT_OUT_DIR: resolve(RUN, 'extension')
	});

	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		COLANDER_DB: resolve(RUN, 'colander.db'),
		COLANDER_SIGNING_KEY: resolve(REPO, 'server/testdata/dev-signing.key')
	};
	// No Stripe, YouTube or mail keys: billing answers 503 and appeals fall back to manual checks.
	for (const k of Object.keys(env)) if (/^(STRIPE_|YOUTUBE_API_KEY|RESEND_API_KEY|COLANDER_CLIENT_IP_HEADER)/.test(k)) delete env[k];
	execFileSync(bin, ['seed-dev'], { env, stdio: ['ignore', 'ignore', 'inherit'] });

	const out = openSync(LOG, 'w');
	const server = spawn(bin, ['serve'], {
		env: { ...env, COLANDER_DEV: '1', COLANDER_ADDR: `127.0.0.1:${port}`, COLANDER_PUBLIC_URL: origin, COLANDER_SITE_DIR: resolve(RUN, 'site') },
		stdio: ['ignore', out, out]
	});
	const exited = new Promise<void>((done) => server.once('exit', () => done()));
	const kill = () => server.exitCode === null && server.kill('SIGTERM');
	process.once('exit', kill);

	const deadline = Date.now() + 20_000;
	for (;;) {
		if (server.exitCode !== null) throw new Error(`The server exited:\n${readFileSync(LOG, 'utf8')}`);
		const ok = await fetch(`${origin}/healthz`).then((r) => r.ok, () => false);
		if (ok) break;
		if (Date.now() > deadline) {
			kill();
			throw new Error(`The server did not answer /healthz:\n${readFileSync(LOG, 'utf8')}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}

	process.env.COLANDER_E2E_ORIGIN = origin;
	process.env.COLANDER_E2E_STAFF_COOKIE = await apiSignIn(STAFF);

	return async () => {
		kill();
		await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
		if (server.exitCode === null) server.kill('SIGKILL');
	};
}
