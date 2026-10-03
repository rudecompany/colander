// Reads the cross-language contract fixtures (docs/contracts.md section 13) in Node and hands them to
// the tests through Vitest's provide/inject, so the same test files run in Node and inside workerd,
// which cannot read host files.
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const text = (path: string) => readFileSync(new URL(path, root), 'utf8');
const base64 = (path: string) => readFileSync(new URL(path, root)).toString('base64');

export function contractFiles() {
	return {
		snapshot: base64('testdata/contract/list-snapshot.bin'),
		delta: base64('testdata/contract/list-delta.bin'),
		expected: text('testdata/contract/list-expected.json'),
		configEnvelope: text('testdata/contract/config-envelope.json'),
		planToken: text('testdata/contract/plan-token.txt').trim(),
		canonicalIds: text('testdata/contract/canonical-ids.json'),
		devSeed: text('server/testdata/dev-signing.key').trim(),
		devPublicKey: text('server/testdata/dev-signing.pub').trim()
	};
}

export type ContractFiles = ReturnType<typeof contractFiles>;

declare module 'vitest' {
	export interface ProvidedContext {
		contract: ContractFiles;
	}
}
