// Builds the website before the harness tests, so they see the current _redirects, _headers and
// 404 page exactly as `wrangler dev` and `wrangler deploy` would serve them.
import { execFileSync } from 'node:child_process';

export default function setup() {
	try {
		execFileSync('pnpm', ['-C', '../web', 'build'], { cwd: new URL('../../', import.meta.url), stdio: 'pipe' });
	} catch (err) {
		const e = err as { stdout?: Buffer; stderr?: Buffer };
		throw new Error(`web build failed:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
	}
}
