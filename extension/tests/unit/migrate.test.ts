// The rewrite after an update (migrateSettings): a removed level an older version stored, such as
// Strict, becomes Standard and goes out to the other synced browsers. chrome.storage.local is in memory.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
let writes = 0;
vi.stubGlobal('chrome', {
	runtime: { getManifest: () => ({ version: '1.0.0' }) },
	storage: {
		local: {
			get: async (key: string) => (store.has(key) ? { [key]: structuredClone(store.get(key)) } : {}),
			set: async (items: Record<string, unknown>) => {
				writes++;
				for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
			}
		}
	}
});
const { migrateSettings } = await import('../../src/background/worker');
const { K } = await import('../../src/lib/settings');

const topic = (strictness: string) => ({ id: 't1', name: 'Kids', terms: ['#kids'], strictness, hide: false });

beforeEach(() => {
	store.clear();
	writes = 0;
});

describe('migrateSettings', () => {
	it('rewrites Strict as Standard in all three places and marks the synced copy to go out', async () => {
		const blocks = [{ key: 'yt:s:@endlessfacts', name: 'Endless Facts', at: 1 }];
		store.set(K.settings, { strictness: 'strict', perPlatform: { yt: 'strict', tt: 'no_ai' }, topics: [topic('strict')], blocks, onboarded: true });
		store.set(K.syncState, { version: 7, dirty: false });
		await migrateSettings();
		const s = store.get(K.settings) as Record<string, unknown>;
		expect(s).toMatchObject({ strictness: 'standard', perPlatform: { yt: 'standard', tt: 'no_ai' }, topics: [topic('standard')], blocks, onboarded: true });
		expect(store.get(K.syncState)).toEqual({ version: 7, dirty: true });
		expect(writes).toBe(1);
	});

	it('leaves valid levels and a fresh install alone, with no write', async () => {
		await migrateSettings();
		expect(store.has(K.settings)).toBe(false);
		for (const settings of [{ strictness: 'label' }, { strictness: 'no_ai', perPlatform: { ig: 'label' }, topics: [topic('no_ai')] }, { onboarded: true }]) {
			store.set(K.settings, settings);
			await migrateSettings();
			expect(store.get(K.settings)).toEqual(settings);
		}
		expect(store.has(K.syncState)).toBe(false);
		expect(writes).toBe(0);
	});
});
