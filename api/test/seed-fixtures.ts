// Registry entries and imports for tests: a cleared lead the owner signed off, and the store calls
// the import-seed command makes, so tests list sources without a bucket object.
import type { SeedEntry } from '@colander/shared/seeds';
import type { Db } from '../src/store/db';
import { applyImport, planImport } from '../src/store/seeds';

/** A valid, cleared CC0 lead named "Secret Seed List"; over changes one thing at a time. */
export const clearedEntry = (over: Partial<SeedEntry> = {}): SeedEntry => ({
	id: 'secret-list',
	name: 'Secret Seed List',
	homepage: 'https://example.org/secret-list',
	platforms: ['yt'],
	license: 'CC0-1.0',
	license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
	attribution: null,
	collection: 'Added by hand by its maintainer (README)',
	scraped: false,
	use: 'lead',
	format: 'lines',
	sha256: '0'.repeat(64),
	upstream: { ref: 'abc123', date: '2026-09-01' },
	expires_after_days: 365,
	calibration: null,
	dev_only: false,
	clearance: { status: 'cleared', by: 'slantview', at: '2026-10-01' },
	...over
});

/** Lists aliases on a seed as import-seed --apply does; now and listedAt are unix seconds. Returns the batch. */
export function listSeed(db: Db, entry: SeedEntry, aliases: string[], now: number, listedAt = now, platform = 'yt'): number {
	const plan = planImport(
		db,
		entry.id,
		aliases.map((alias) => ({ platform, alias }))
	);
	return applyImport(db, entry, plan, { sha256: entry.sha256 ?? '', entries: aliases.length, records: { dpia: 'DPIA-1', lia: 'LIA-1' }, listedAt }, now).batch;
}
