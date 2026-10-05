import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The Worker in api/ serves build/ and the API from one origin, so pages call relative /v1 URLs.
// In dev, Vite proxies /v1 to it (wrangler dev).
const API = process.env.COLANDER_API ?? 'http://localhost:8787';

/** The extension's version, and the commit date of its release tag when one exists. */
function release(): { version: string; released: string | null } {
	const { version } = JSON.parse(readFileSync(new URL('../extension/package.json', import.meta.url), 'utf8')) as { version: string };
	let released: string | null = null;
	try {
		released = execFileSync('git', ['log', '-1', '--format=%cI', `v${version}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
	} catch {
		released = null;
	}
	return { version, released };
}

/**
 * Live numbers baked in at build: /v1/stats and the latest decisions, with the time they were
 * read. Pages refresh them in place on load and keep these when the refresh fails. Set
 * COLANDER_BUILD_API (such as http://127.0.0.1:8787) to read them; without it pages start empty.
 */
async function live(): Promise<{ stats: unknown; log: unknown[]; asOf: string } | null> {
	const base = process.env.COLANDER_BUILD_API;
	if (!base) return null;
	try {
		const get = async (path: string) => {
			const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`${path}: ${res.status}`);
			return res.json();
		};
		const [stats, log] = await Promise.all([get('/v1/stats'), get('/v1/log?limit=4')]);
		return { stats, log: (log as { entries: unknown[] }).entries.slice(0, 4), asOf: new Date().toISOString() };
	} catch (e) {
		console.warn(`Live numbers were not read at build: ${e instanceof Error ? e.message : e}`);
		return null;
	}
}

export default defineConfig(async () => {
	const numbers = await live();
	let warned = false;
	return {
		plugins: [
			// Says so loudly when a build carries no live numbers.
			{
				name: 'colander-live-numbers',
				apply: 'build',
				buildStart() {
					if (numbers || warned) return;
					warned = true;
					this.warn(
						'COLANDER_BUILD_API is not set: pages prerender without live numbers, so the landing pill, the live strip and /transparency start empty until the browser fetches them. Set it for a production build.'
					);
				}
			},
			sveltekit({
				adapter: adapter({ pages: 'build', assets: 'build', fallback: '200.html' }),
				csp: {
					mode: 'hash',
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						// Svelte writes style attributes; scripts stay hash-locked.
						'style-src': ['self', 'unsafe-inline'],
						'img-src': ['self', 'data:'],
						'font-src': ['self'],
						'connect-src': ['self'],
						'form-action': ['self'],
						'base-uri': ['self'],
						'object-src': ['none']
					}
				}
			})
		],
		define: {
			__RELEASE__: JSON.stringify(release()),
			__BUILD_LIVE__: JSON.stringify(numbers)
		},
		build: {
			// The demo thumbnails are files, never inlined into the JavaScript: / allows exactly these 8 images.
			assetsInlineLimit: (file: string) => (file.endsWith('.webp') ? false : undefined),
			// The shared package is side-effect free, so each page loads only the components it uses.
			// Modules that 2 or more pages share travel together in one chunk, so / stays well under
			// 40 requests instead of one request per small component and icon.
			rolldownOptions: {
				output: {
					codeSplitting: {
						groups: [{ name: 'common', test: /[\\/](packages[\\/]shared[\\/]src|@lucide[\\/]svelte|web[\\/]src[\\/]lib)[\\/]/, minShareCount: 2 }]
					}
				}
			}
		},
		server: { proxy: { '/v1': API } }
	};
});
