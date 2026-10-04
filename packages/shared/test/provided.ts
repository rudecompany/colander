// The contract fixture files as Vitest provides them to the tests (see contract-files.ts), kept
// apart from the Node reader so test programs for workerd can use the type.
export interface ContractFiles {
	/** base64 of list-snapshot.bin */
	snapshot: string;
	/** base64 of list-delta.bin */
	delta: string;
	expected: string;
	configEnvelope: string;
	planToken: string;
	canonicalIds: string;
	/** base64 of the dev Ed25519 seed (testdata/dev-signing.key) */
	devSeed: string;
	devPublicKey: string;
}

declare module 'vitest' {
	export interface ProvidedContext {
		contract: ContractFiles;
	}
}
