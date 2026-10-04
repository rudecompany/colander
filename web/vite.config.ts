import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The Worker in api/ serves build/ and the API from one origin, so pages call relative /v1 URLs.
// In dev, Vite proxies /v1 to it (wrangler dev).
const API = process.env.COLANDER_API ?? 'http://localhost:8787';

export default defineConfig({
	plugins: [
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
	server: { proxy: { '/v1': API } }
});
