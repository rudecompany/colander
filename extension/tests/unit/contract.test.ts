// The extension's trusted keys against the signed cross-language fixtures. The list, envelope and
// plan token code itself lives in @colander/shared and is tested there (packages/shared/test).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyList } from '@colander/shared/list';
import { CONFIG_CONTEXT, importKeys, verifyEnvelope, verifyPlanToken } from '@colander/shared/signing';
import { DEV_PUBLIC_KEY, PUBLIC_KEYS } from '../../src/lib/env';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root));

describe('trusted keys', () => {
	it('bundles the dev key from server/testdata', () => {
		expect(read('server/testdata/dev-signing.pub').toString('utf8').trim()).toBe(DEV_PUBLIC_KEY);
	});

	it('verifies every signed fixture with the default build keys', async () => {
		const keys = await importKeys(PUBLIC_KEYS);
		expect((await verifyList(new Uint8Array(read('testdata/contract/list-snapshot.bin')), keys)).sequence).toBe(42);
		expect((await verifyList(new Uint8Array(read('testdata/contract/list-delta.bin')), keys)).sequence).toBe(43);
		const env = JSON.parse(read('testdata/contract/config-envelope.json').toString('utf8'));
		expect(await verifyEnvelope(env, CONFIG_CONTEXT, keys)).toEqual({ version: 7, note: 'contract fixture' });
		expect(await verifyPlanToken(read('testdata/contract/plan-token.txt').toString('utf8'), keys)).not.toBeNull();
	});
});
