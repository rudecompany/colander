// scripts/calibration-report.ts: settled labels, Cohen's kappa, per-group counts with Wilson bounds,
// and the calibration block a seed list needs before it can be promoted (seed design section 8).
import { describe, expect, it } from 'vitest';
import { kappa, report, settled, type ExportItem } from '../../../scripts/calibration-report.ts';
import { validateEntry } from '../src/seeds';

const item = (frame: string, labels: ExportItem['labels'][number]['label'][], over: Partial<ExportItem> = {}): ExportItem => ({
	platform: 'yt',
	frame,
	large: false,
	computed: null,
	labels: labels.map((label, i) => ({ labeler: `acc_${i}`, label, labeled_at: i })),
	...over
});

describe('calibration report', () => {
	it('settles a label on agreement or a majority of three, never on a tie', () => {
		expect(settled(item('x', ['slop', 'slop']).labels)).toBe('slop');
		expect(settled(item('x', ['slop', 'not_ai']).labels)).toBeNull();
		expect(settled(item('x', ['slop', 'not_ai', 'not_ai']).labels)).toBe('not_ai');
		expect(settled(item('x', ['slop']).labels)).toBeNull();
	});

	it("computes Cohen's kappa over the first two labels", () => {
		expect(kappa([])).toEqual({ pairs: 0, value: null });
		// Two raters, 50 pairs: 20 slop/slop, 5 slop/not_ai, 10 not_ai/slop, 15 not_ai/not_ai: po 0.7, pe 0.5.
		const items = [
			...Array(20).fill(item('x', ['slop', 'slop'])),
			...Array(5).fill(item('x', ['slop', 'not_ai'])),
			...Array(10).fill(item('x', ['not_ai', 'slop'])),
			...Array(15).fill(item('x', ['not_ai', 'not_ai']))
		];
		const k = kappa(items);
		expect(k.pairs).toBe(50);
		expect(k.value).toBeCloseTo(0.4, 6);
	});

	it('counts each frame by group, leaves out gone, unsure and unsettled items, and yields a block validateEntry accepts', () => {
		const items = [
			...Array(140).fill(item('seed:open-list', ['slop', 'slop'], { computed: 'likely_slop' })),
			...Array(8).fill(item('seed:open-list', ['ai_not_slop', 'ai_not_slop'])),
			item('seed:open-list', ['gone', 'gone']),
			item('seed:open-list', ['slop', 'not_ai']),
			item('random:frame', ['not_ai', 'not_ai'], { platform: 'tt', large: true })
		];
		const r = report(items, '2026-10-05');
		expect(r).toMatchObject({ items: 151, unsettled: 1 });
		const seed = r.frames['seed:open-list'] as { groups: { group: string; n: number; ai: number; slop: number; ai_lower: number; slop_lower: number }[]; calibration: unknown };
		expect(seed.groups.map((g) => [g.group, g.n, g.ai, g.slop])).toEqual([
			['all', 148, 148, 140],
			['platform:yt', 148, 148, 140],
			['audience:not_recorded', 148, 148, 140]
		]);
		expect(seed.groups[0]!.ai_lower).toBeGreaterThan(0.97);
		expect(seed.groups[0]!.slop_lower).toBeCloseTo(0.897, 3);
		expect(r.frames['random:frame']).toEqual({ groups: [expect.objectContaining({ group: 'all', n: 1, ai: 0, slop: 0 }), expect.anything(), expect.anything()] });
		expect(r.confusion).toEqual({ likely_slop: { slop: 140 }, not_rated: { ai_not_slop: 8, gone: 1, not_ai: 1 } });
		const entry = {
			id: 'open-list',
			name: 'Open List',
			homepage: 'https://example.org',
			platforms: ['yt'],
			license: 'CC0-1.0',
			license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
			attribution: null,
			collection: 'By hand (README)',
			scraped: false,
			use: 'seed',
			format: 'lines',
			sha256: 'a'.repeat(64),
			upstream: { ref: 'abc', date: '2026-09-01' },
			expires_after_days: 180,
			calibration: seed.calibration,
			dev_only: false,
			clearance: { status: 'cleared', by: 'slantview', at: '2026-10-05' }
		};
		expect(validateEntry(entry)).toEqual([]);
	});
});
