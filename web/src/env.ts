import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_EXTENSION_ID: {
		public: true,
		static: true,
		description: 'Chrome extension ID the website sends plan and reviewer tokens to.',
		schema: (value) => value ?? ''
	},
	PUBLIC_TURNSTILE_SITE_KEY: {
		public: true,
		static: true,
		description: 'Cloudflare Turnstile site key for the sign-in code form. Empty: no challenge, and the Worker needs none.',
		schema: (value) => value ?? ''
	},
	PUBLIC_STORE_URL: {
		public: true,
		static: true,
		description: 'Where the install buttons point.',
		schema: (value) => value || 'https://chromewebstore.google.com/search/Colander'
	}
});
