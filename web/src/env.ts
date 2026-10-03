import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_EXTENSION_ID: {
		public: true,
		static: true,
		description: 'Chrome extension ID the website sends plan and reviewer tokens to.',
		schema: (value) => value ?? ''
	},
	PUBLIC_STORE_URL: {
		public: true,
		static: true,
		description: 'Where the install buttons point.',
		schema: (value) => value || 'https://chromewebstore.google.com/search/Colander'
	}
});
