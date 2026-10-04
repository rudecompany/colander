import { defineConfig } from 'wxt';
import { ALL_ORIGINS } from './src/lib/platforms';

/**
 * Public half of the development signing key (RSA 2048, SubjectPublicKeyInfo, base64). It pins
 * the unpacked extension ID to nninnogmbhfebflkcgghlmjmplmpodlc on every machine (contract 7).
 * The private key is not in the repository; the Chrome Web Store signs release builds itself.
 */
const DEV_KEY =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtuhGUcSmAzGZphMLWdlsdVxSnezBr4AfS1iJyJ3K0I1cGj9vfWBkVDmAZWTKW8r0HRs3yfWdzEKkfZVwUKXidi8fsOuQmkeInqFklkVIhKcarzKJ9sSnBEnKdc4Oq0dWR/u5YyiS3kc6gLmGu9nB7FoVhyw3z4FTdF5UG11FPcpnB1aI7Y3W/BWcfoXat+N3GHbPZ19wS8Z+l/lebzniF4sQc+b97rv/S8h7Jk5FIFTI8YSVx8HjmWle/GHN4fR5B+jd5bekjDMyxZETtLqxSFEdWfOd47y1taxZ8q0UBP5gXqHWYIi/pwZHG+7QxP1AweyhSEtGF4L5M7t6ka7bxwIDAQAB';

const icons = (state: string) => ({ 16: `/icons/${state}-16.png`, 32: `/icons/${state}-32.png`, 48: `/icons/${state}-48.png`, 128: `/icons/${state}-128.png` });

export default defineConfig({
	srcDir: 'src',
	// The full-stack suite builds against its own server origin, so it builds into its own folder.
	outDir: process.env.COLANDER_EXT_OUT_DIR || 'dist',
	modules: ['@wxt-dev/module-svelte'],
	manifest: ({ mode }) => {
		const site = (process.env.WXT_COLANDER_SITE || process.env.WXT_COLANDER_API || 'http://localhost:8787').replace(/\/+$/, '');
		return {
			name: 'Colander: drain the slop from your feed',
			short_name: 'Colander',
			description: 'Hides AI slop on YouTube, TikTok, Instagram and Facebook from shared, signed lists. Every action is explained and reversible.',
			// Store packages carry no key: the Chrome Web Store assigns the ID and rejects a key that
			// is not the item's own (release.yml sets WXT_COLANDER_STORE_BUILD).
			...(process.env.WXT_COLANDER_STORE_BUILD ? {} : { key: DEV_KEY }),
			permissions: ['storage', 'alarms', 'sidePanel', 'scripting'],
			optional_host_permissions: ALL_ORIGINS,
			externally_connectable: { matches: [`${site}/*`] },
			icons: icons('active'),
			action: { default_title: 'Colander', default_icon: { 16: '/icons/active-16.png', 32: '/icons/active-32.png' } },
			minimum_chrome_version: '137',
			// End-to-end builds are granted every platform at install, so Chrome's site access
			// prompt (which automation cannot click) resolves at once. Release builds ask per platform.
			...(mode === 'e2e' ? { host_permissions: ALL_ORIGINS } : {})
		};
	},
	hooks: {
		'build:manifestGenerated': (wxt, manifest) => {
			// Runtime-registered content scripts must not grant themselves site access: access is
			// optional and asked for per platform.
			if (wxt.config.mode === 'e2e') manifest.host_permissions = ALL_ORIGINS;
			else delete manifest.host_permissions;
		}
	}
});
