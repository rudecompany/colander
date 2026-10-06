import { defineEnvVars } from '@sveltejs/kit/env';

// Store listings (src/lib/install.svelte.ts). A store whose variable is empty is not offered, so
// the site can ship before a listing is live; release.yml sets them from repository variables.
export const variables = defineEnvVars({
	PUBLIC_STORE_CHROME: {
		public: true,
		static: true,
		description: 'Chrome Web Store listing. Chrome, Brave and Opera install from it, and so does Edge until its own listing is set.',
		schema: (value) => value || 'https://chromewebstore.google.com/search/Colander'
	},
	PUBLIC_STORE_EDGE: {
		public: true,
		static: true,
		description: 'Edge Add-ons listing, empty until it is live.',
		schema: (value) => value ?? ''
	},
	PUBLIC_TURNSTILE_SITE_KEY: {
		public: true,
		static: true,
		description: 'Cloudflare Turnstile site key for the sign-in code form. Empty: no challenge, and the Worker needs none.',
		schema: (value) => value ?? ''
	},
	PUBLIC_STORE_FIREFOX: {
		public: true,
		static: true,
		description: 'Firefox Add-ons listing, empty until it is live.',
		schema: (value) => value ?? ''
	}
});
