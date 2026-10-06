// The seed source registry's rules (docs/contracts.md section 14), the registry as committed, and
// what /credits may name.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../src/seed-registry';
import { credits, datasetNames, ownerOnlyChanges, usable, validateEntry, validateRegistry, wilsonLower, type SeedEntry } from '../src/seeds';

/** A valid cleared CC0 lead; tests change one thing at a time. */
const cleared = (over: Partial<SeedEntry> = {}): SeedEntry => ({
	id: 'open-list',
	name: 'Open List',
	aliases: ['OpenList'],
	homepage: 'https://example.org/open-list',
	platforms: ['yt'],
	license: 'CC0-1.0',
	license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
	attribution: null,
	collection: 'Added by hand by its maintainer (README)',
	scraped: false,
	use: 'lead',
	format: 'lines',
	sha256: 'a'.repeat(64),
	upstream: { ref: 'abc123', date: '2026-09-01' },
	expires_after_days: 365,
	calibration: null,
	dev_only: false,
	clearance: { status: 'cleared', by: 'slantview', at: '2026-10-01' },
	...over
});

const byAttribution = (over: Partial<SeedEntry> = {}) =>
	cleared({ id: 'by-list', name: 'BY List', license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'BY List by Example, CC BY 4.0', ...over });

const passing = {
	report: '2026-09-30',
	groups: ['all', 'platform:yt', 'audience:not_recorded', 'language:en', 'kind:video'].map((group) => ({ group, n: 150, ai: 149, slop: 146 }))
};

describe('the committed registry', () => {
	it('is valid, and lists the day-one candidates pending the owner, with no list data', () => {
		expect(validateRegistry({ entries: REGISTRY })).toEqual([]);
		const third = REGISTRY.filter((e) => !e.dev_only && e.license !== 'LicenseRef-Colander-internal').map((e) => e.id);
		expect(third).toEqual(['aislist-cc0-20260115-blocklist', 'aislist-cc0-20260115-warnlist', 'cevval-yt-ai-music', 'soul-over-ai-cc-by', 'tubecensus-sample']);
		for (const e of REGISTRY) {
			expect(e.clearance, e.id).toEqual({ status: 'pending', by: null, at: null });
			expect(e.use, e.id).not.toBe('seed');
		}
		expect(REGISTRY.find((e) => e.id === 'tubecensus-sample')?.use).toBe('frame');
		expect(REGISTRY.find((e) => e.id === 'demo-list')?.dev_only).toBe(true);
	});

	it('matches its JSON schema on every field name and choice', () => {
		const schema = JSON.parse(readFileSync(new URL('../src/seed-registry.schema.json', import.meta.url), 'utf8'));
		const entry = schema.$defs.entry;
		expect(entry.required).toEqual(Object.keys(cleared()));
		expect(entry.properties.use.enum).toEqual(['lead', 'seed', 'frame']);
		expect(entry.properties.format.enum).toEqual(['lines', 'ubo', 'soul-over-ai']);
		expect(entry.properties.clearance.properties.status.enum).toEqual(['pending', 'cleared', 'refused', 'revoked']);
	});
});

describe('validateEntry', () => {
	it('passes a cleared CC0 lead and a cleared CC BY lead with its credit', () => {
		expect(validateEntry(cleared())).toEqual([]);
		expect(validateEntry(byAttribution())).toEqual([]);
		expect(validateEntry(cleared({ license: 'LicenseRef-written-grant', license_url: null }))).toEqual([]);
	});

	it('clears nothing a paid product may not use', () => {
		for (const license of ['CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-SA-4.0', 'GPL-3.0-only', 'NOASSERTION']) {
			expect(validateEntry(cleared({ license })), license).toContain(
				'only CC0-1.0, CC-BY-4.0, MIT, LicenseRef-written-grant, LicenseRef-Colander-internal can be cleared; non-commercial, no-derivatives, share-alike, GPL and unlicensed lists never are'
			);
			expect(validateEntry(cleared({ license, clearance: { status: 'refused', by: null, at: null } })), license).toEqual([]);
		}
	});

	it('lets only an owner clear, and only a pinned, dated list its maintainer says was not scraped', () => {
		expect(validateEntry(cleared({ clearance: { status: 'cleared', by: 'someone', at: '2026-10-01' } }))).toEqual(['clearance.by must be one of the owners: slantview']);
		expect(validateEntry(cleared({ clearance: { status: 'cleared', by: 'slantview', at: null } }))).toEqual(['clearance.at is required once cleared']);
		expect(validateEntry(cleared({ sha256: null }))).toEqual(['sha256 is required once cleared: imports must match the file that was cleared']);
		expect(validateEntry(cleared({ upstream: { ref: null, date: null } }))).toEqual(['upstream.date is required once cleared']);
		expect(validateEntry(cleared({ scraped: null }))).toEqual(['only a list the maintainer says was not scraped can be cleared']);
		expect(validateEntry(cleared({ scraped: true }))).toEqual(['only a list the maintainer says was not scraped can be cleared']);
		expect(validateEntry(cleared({ scraped: null, sha256: null, clearance: { status: 'pending', by: null, at: null } }))).toEqual([]);
	});

	it('needs the exact credit for CC BY and MIT, and none for internal data', () => {
		expect(validateEntry(byAttribution({ attribution: null }))).toEqual(['CC-BY-4.0 requires attribution: the exact credit its license asks for']);
		expect(validateEntry(cleared({ license: 'MIT', license_url: 'https://opensource.org/license/mit' }))).toEqual(['MIT requires attribution: the exact credit its license asks for']);
		expect(validateEntry(cleared({ license: 'LicenseRef-Colander-internal', license_url: null, attribution: 'Us' }))).toEqual([
			'LicenseRef-Colander-internal asks for no credit, so attribution stays null'
		]);
		// /credits names only datasets whose license asks for credit, so a courtesy credit is refused.
		expect(validateEntry(cleared({ attribution: 'Thanks to Open List' }))).toEqual(['CC0-1.0 asks for no credit, so attribution stays null']);
		expect(validateEntry(cleared({ license: 'LicenseRef-written-grant', license_url: null, attribution: 'As the grant asks' }))).toEqual([]);
	});

	it('needs the short names a third-party dataset goes by', () => {
		expect(validateEntry(cleared({ aliases: [] }))).toEqual(['a third-party dataset needs aliases: the short names people use for it']);
		expect(validateEntry(cleared({ aliases: ['OL'] }))).toEqual(['aliases must list names of at least 4 characters']);
		expect(validateEntry(cleared({ aliases: ['open list'] }))).toEqual(['aliases must differ from the name and from each other']);
		expect(validateEntry(cleared({ license: 'LicenseRef-Colander-internal', license_url: null, aliases: [] }))).toEqual([]);
	});

	it('promotes a list to seed only with blind calibration that passes in every group', () => {
		expect(validateEntry(cleared({ use: 'seed', calibration: passing, expires_after_days: 180 }))).toEqual([]);
		expect(validateEntry(cleared({ use: 'seed', expires_after_days: 180 }))[0]).toMatch(/^use "seed" needs a calibration block/);
		expect(validateEntry(cleared({ use: 'seed', calibration: passing }))).toEqual(['a seed list stops counting within 180 days of its upstream date']);
		const weakGroup = { report: '2026-09-30', groups: [...passing.groups, { group: 'platform:tt', n: 40, ai: 30, slop: 20 }] };
		expect(validateEntry(cleared({ use: 'seed', calibration: weakGroup, expires_after_days: 180 }))).toEqual([
			'calibration group platform:tt: the AI-made lower bound 0.598 is under 0.9',
			'calibration group platform:tt: the slop lower bound 0.352 is under 0.8'
		]);
		const small = { report: '2026-09-30', groups: [{ group: 'all', n: 60, ai: 60, slop: 60 }] };
		expect(validateEntry(cleared({ use: 'seed', calibration: small, expires_after_days: 180 }))).toEqual([
			'calibration needs the groups by platform:, audience:, language:, kind: that scripts/calibration-report.ts writes, copied whole',
			'calibration group all has 60 labeled sources, under 100'
		]);
		// A list-wide average cannot stand in for the groups: each kind of group must be there.
		const noLanguage = { ...passing, groups: passing.groups.filter((g) => !g.group.startsWith('language:')) };
		expect(validateEntry(cleared({ use: 'seed', calibration: noLanguage, expires_after_days: 180 }))).toEqual([
			'calibration needs the groups by language: that scripts/calibration-report.ts writes, copied whole'
		]);
	});

	it('keeps fictional dev data pending and internal, and refuses unknown or missing fields', () => {
		const dev = cleared({ dev_only: true, license: 'LicenseRef-Colander-internal', license_url: null, clearance: { status: 'pending', by: null, at: null } });
		expect(validateEntry(dev)).toEqual([]);
		expect(validateEntry({ ...dev, clearance: { status: 'cleared', by: 'slantview', at: '2026-10-01' } })).toEqual(['a dev_only entry stays pending: it is never cleared']);
		expect(validateEntry({ ...cleared(), note: 'x' })).toEqual(['unknown fields: note']);
		const { collection: _, ...rest } = cleared();
		expect(validateEntry(rest)).toContain('missing fields: collection');
		expect(validateEntry(cleared({ platforms: ['yt', 'tt'] }))).toEqual(['a lines file holds one platform']);
	});

	it('finds duplicate IDs across the registry', () => {
		expect(validateRegistry({ entries: [cleared(), cleared()] })).toEqual(['open-list: duplicate id']);
	});
});

describe('datasetNames', () => {
	it('gives every name public text may not contain: name, ID, aliases, homepage and the GitHub owner and repository', () => {
		const aislist = REGISTRY.find((e) => e.id === 'aislist-cc0-20260115-blocklist')!;
		expect(datasetNames(aislist)).toEqual([
			'AiSList blocklist, last CC0 version',
			'aislist-cc0-20260115-blocklist',
			'AiSList',
			'AiBlock for YouTube',
			'https://github.com/Override92/AiSList',
			'Override92'
		]);
		expect(datasetNames(REGISTRY.find((e) => e.id === 'cevval-yt-ai-music')!).slice(2)).toEqual([
			'Cevval',
			'CevvalKoala',
			'https://github.com/cevvalkoala/CevvalYoutubeAIBlocklist',
			'CevvalYoutubeAIBlocklist'
		]);
		// Colander's own lists keep their homepage, a Colander page reviewers may cite, out.
		expect(datasetNames(REGISTRY.find((e) => e.id === 'staff-research')!)).toEqual(['Colander staff research', 'staff-research']);
	});
});

describe('use, credits and owner changes', () => {
	it('uses cleared entries everywhere and dev_only ones only in dev mode', () => {
		const dev = cleared({ dev_only: true, license: 'LicenseRef-Colander-internal', license_url: null, clearance: { status: 'pending', by: null, at: null } });
		expect([usable(cleared(), false), usable(cleared(), true)]).toEqual([true, true]);
		expect([usable(dev, false), usable(dev, true)]).toEqual([false, true]);
		expect(usable(cleared({ clearance: { status: 'revoked', by: 'slantview', at: '2026-10-02' } }), true)).toBe(false);
		expect(usable(cleared({ clearance: { status: 'cleared', by: 'someone', at: '2026-10-01' } }), false)).toBe(false);
	});

	it('credits only cleared third-party datasets whose license requires it', () => {
		const internal = cleared({ id: 'staff', license: 'LicenseRef-Colander-internal', license_url: null });
		const pendingBy = byAttribution({ id: 'pending-by', name: 'Pending BY', clearance: { status: 'pending', by: null, at: null } });
		const frame = byAttribution({ id: 'frame-by', name: 'A Frame', use: 'frame' });
		expect(credits([cleared(), internal, pendingBy, byAttribution(), frame])).toEqual([
			{ name: 'A Frame', homepage: 'https://example.org/open-list', license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'BY List by Example, CC BY 4.0' },
			{ name: 'BY List', homepage: 'https://example.org/open-list', license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'BY List by Example, CC BY 4.0' }
		]);
		// Nothing is cleared yet, so /credits names nothing.
		expect(credits(REGISTRY)).toEqual([]);
	});

	it('needs an owner for a cleared entry, a clearance change, or an entry added or removed other than pending', () => {
		const pending = cleared({ id: 'p', clearance: { status: 'pending', by: null, at: null }, sha256: null });
		expect(ownerOnlyChanges([], [pending])).toEqual([]);
		expect(ownerOnlyChanges([pending], [])).toEqual([]);
		expect(ownerOnlyChanges([pending], [{ ...pending, name: 'Renamed' }])).toEqual([]);
		expect(ownerOnlyChanges([pending], [{ ...pending, clearance: { status: 'cleared', by: 'slantview', at: '2026-10-01' } }])).toEqual(['p']);
		expect(ownerOnlyChanges([], [cleared()])).toEqual(['open-list']);
		expect(ownerOnlyChanges([cleared()], [cleared({ sha256: 'b'.repeat(64) })])).toEqual(['open-list']);
		expect(ownerOnlyChanges([cleared()], [])).toEqual(['open-list']);
		expect(ownerOnlyChanges([cleared()], [cleared()])).toEqual([]);
	});

	it('computes the 95% Wilson lower bound', () => {
		expect(wilsonLower(95, 100)).toBeCloseTo(0.8882, 4);
		expect(wilsonLower(0, 0)).toBe(0);
		expect(wilsonLower(30, 30)).toBeCloseTo(0.8865, 4);
	});
});
