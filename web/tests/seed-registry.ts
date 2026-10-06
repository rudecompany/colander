// The seed registry the website's tests build with (COLANDER_SEED_REGISTRY, vite.config.ts), so
// /credits renders a dataset card before any real dataset is cleared. Fictional: one cleared
// dataset whose license asks for credit, which /credits names; one cleared CC0 dataset and one
// pending CC BY dataset, which no page may name.
import type { SeedEntry } from '@colander/shared/seeds';

const entry = (over: Partial<SeedEntry>): SeedEntry => ({
	id: 'example-open-channels',
	name: 'Example Open Channels',
	aliases: ['OpenChannels'],
	homepage: 'https://example.org/open-channels',
	platforms: ['yt'],
	license: 'CC-BY-4.0',
	license_url: 'https://creativecommons.org/licenses/by/4.0/',
	attribution: 'Example Open Channels by the Example Lab, https://example.org/open-channels, licensed under CC BY 4.0. Colander reads only its channel IDs.',
	collection: 'Added by hand by its maintainers (README)',
	scraped: false,
	use: 'lead',
	format: 'lines',
	sha256: 'a'.repeat(64),
	upstream: { ref: 'v1', date: '2026-09-01' },
	expires_after_days: 365,
	calibration: null,
	dev_only: false,
	clearance: { status: 'cleared', by: 'slantview', at: '2026-10-01' },
	...over
});

export const REGISTRY: readonly SeedEntry[] = [
	entry({}),
	entry({ id: 'example-public-list', name: 'Example Public List', aliases: ['PublicList'], homepage: 'https://example.org/public-list', license: 'CC0-1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: null }),
	entry({ id: 'example-pending-list', name: 'Example Pending List', aliases: ['PendingList'], homepage: 'https://example.org/pending-list', sha256: null, clearance: { status: 'pending', by: null, at: null } })
];
