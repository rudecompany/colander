import { defineConfig } from 'vitest/config';
import { contractFiles } from './test/contract-files';

// The same test files also run inside workerd from api/vitest.config.ts.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		provide: { contract: contractFiles() }
	}
});
