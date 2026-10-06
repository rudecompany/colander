import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { ALL_ORIGINS } from './src/lib/platforms';

/**
 * Public half of the development signing key (RSA 2048, SubjectPublicKeyInfo, base64). It pins
 * the unpacked Chrome extension ID to nninnogmbhfebflkcgghlmjmplmpodlc on every machine, which the
 * end-to-end tests open pages by. Nothing else depends on the ID: the website reaches the extension
 * through pairing codes (contract 7). The stores assign their own IDs and reject this key.
 */
const DEV_KEY =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtuhGUcSmAzGZphMLWdlsdVxSnezBr4AfS1iJyJ3K0I1cGj9vfWBkVDmAZWTKW8r0HRs3yfWdzEKkfZVwUKXidi8fsOuQmkeInqFklkVIhKcarzKJ9sSnBEnKdc4Oq0dWR/u5YyiS3kc6gLmGu9nB7FoVhyw3z4FTdF5UG11FPcpnB1aI7Y3W/BWcfoXat+N3GHbPZ19wS8Z+l/lebzniF4sQc+b97rv/S8h7Jk5FIFTI8YSVx8HjmWle/GHN4fR5B+jd5bekjDMyxZETtLqxSFEdWfOd47y1taxZ8q0UBP5gXqHWYIi/pwZHG+7QxP1AweyhSEtGF4L5M7t6ka7bxwIDAQAB';

/** The add-on's permanent ID on addons.mozilla.org. */
export const GECKO_ID = 'colander@getcolander.com';

/** The repository root: the Firefox sources zip unpacks to this layout anywhere. */
const REPO = fileURLToPath(new URL('..', import.meta.url));

const icons = (state: string) => ({ 16: `/icons/${state}-16.png`, 32: `/icons/${state}-32.png`, 48: `/icons/${state}-48.png`, 128: `/icons/${state}-128.png` });

export default defineConfig({
	srcDir: 'src',
	// The full-stack suite builds against its own server origin, so it builds into its own folder.
	outDir: process.env.COLANDER_EXT_OUT_DIR || 'dist',
	modules: ['@wxt-dev/module-svelte'],
	// Svelte's scoped class names hash the component's file path. Hashing the path inside the
	// repository, not the absolute one, makes the build the same in any checkout, which is how AMO
	// checks that a package was built from its sources zip.
	svelte: { vite: { compilerOptions: { cssHash: ({ hash, filename }) => `svelte-${hash(relative(REPO, resolve(REPO, 'extension', filename)))}` } } },
	// WXT builds Firefox as Manifest V2 unless told otherwise; every target here is MV3.
	manifestVersion: 3,
	// The Firefox sources zip is what AMO reviewers rebuild from (AMO_REVIEW.md): the workspace root,
	// the shared package and the extension, without tests, art or anything the build does not read.
	zip: {
		sourcesRoot: '..',
		includeSources: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/shared/**', 'extension/**'],
		excludeSources: ['extension/dist/**', 'extension/tests/**', 'extension/screenshots/**', 'extension/store/**', 'extension/test-results/**', 'packages/shared/test/**']
	},
	manifest: ({ mode, browser }) => {
		const firefox = browser === 'firefox';
		return {
			name: 'Colander: drain the slop from your feed',
			short_name: 'Colander',
			description: 'Hides AI slop on YouTube, TikTok, Instagram and Facebook from shared, signed lists. Every action is explained and reversible.',
			// Only unpacked Chrome builds carry the key: store packages never do, since each store assigns
			// the ID and rejects a key that is not its own (scripts/build-store.sh sets WXT_COLANDER_STORE_BUILD).
			...(browser === 'chrome' && !process.env.WXT_COLANDER_STORE_BUILD ? { key: DEV_KEY } : {}),
			// WXT adds sidePanel for Chromium and turns the side panel into Firefox's sidebar_action.
			permissions: ['storage', 'alarms', 'scripting'],
			optional_host_permissions: ALL_ORIGINS,
			icons: icons('active'),
			action: { default_title: 'Colander', default_icon: { 16: '/icons/active-16.png', 32: '/icons/active-32.png' } },
			...(firefox
				? {
						browser_specific_settings: {
							gecko: {
								id: GECKO_ID,
								// 140 is the first release with built-in data collection consent, and an ESR.
								strict_min_version: '140.0',
								// Nothing is sent until the person allows it (src/lib/consent.ts): tags and reports
								// carry what was seen on a page, and Plus and review carry a sign-in token.
								// "none" is the only way to require nothing; Firefox ignores it next to optional kinds.
								data_collection_permissions: { required: ['none'], optional: ['websiteContent', 'authenticationInfo'] }
							}
							// No gecko_android: that key marks the add-on as made for Firefox for Android, which
							// waits for mobile adapters. web-ext lint still warns about Android 140 (web-ext#3561).
						}
					}
				: { minimum_chrome_version: '137' }),
			// End-to-end builds are granted every platform at install, so the browser's site access
			// prompt (which automation cannot click) resolves at once. Release builds ask per platform.
			...(mode === 'e2e' ? { host_permissions: ALL_ORIGINS } : {})
		};
	},
	hooks: {
		// The in-page tokens are generated from colander.css; a stale copy fails here, before any build.
		'prepare:types': () => {
			execFileSync(process.execPath, ['../packages/shared/scripts/gen-inpage-tokens.ts', '--check'], { stdio: 'inherit' });
		},
		// The store art page (scripts/make-store-art.ts) ships only in the end-to-end build.
		'entrypoints:found': (wxt, infos) => {
			if (wxt.config.mode === 'e2e') return;
			const i = infos.findIndex((e) => e.name === 'storeart');
			if (i >= 0) infos.splice(i, 1);
		},
		'build:manifestGenerated': (wxt, manifest) => {
			// Runtime-registered content scripts must not grant themselves site access: access is
			// optional and asked for per platform.
			if (wxt.config.mode === 'e2e') manifest.host_permissions = ALL_ORIGINS;
			else delete manifest.host_permissions;
		}
	}
});
