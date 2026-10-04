// The scoring rules (src/scoring/rules.ts): the port of server/internal/scoring/rules_test.go.
import { describe, expect, it } from 'vitest';
import { signalsFromMask } from '@colander/shared/verdicts';
import { Default, newInput, Sig, TestBit, type Input, type Vote } from '../src/scoring/rules';

const votes = (n: number, verdict: string, weight: number, tests: number): Vote[] =>
	Array.from({ length: n }, () => ({ weight, verdict, slopType: '', tests, platformLabel: false }));

const lowHollow = TestBit.low_effort | TestBit.hollow;
const DAY = 86_400_000;

describe('rules', () => {
	const th = Default;
	const slop5 = votes(5, 'slop', 1, lowHollow);
	const cases: {
		name: string;
		in: Partial<Input>;
		verdict: string;
		rule: number;
		capped?: string;
		/** must all be present */
		signals?: number;
		/** must all be absent */
		excluded?: number;
	}[] = [
		{
			name: 'tags alone never reach Slop: no behavior layer means Likely slop at most',
			in: { votes: votes(40, 'slop', 1, lowHollow), uploadsPerDay: -1 },
			verdict: 'likely_slop',
			rule: 7,
			signals: Sig.community_consensus | Sig.rubric_low_effort | Sig.rubric_hollow,
			excluded: Sig.mostly_ai | Sig.high_volume
		},
		{
			name: 'provenance, behavior and consensus make Slop',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, audienceKnown: true },
			verdict: 'slop',
			rule: 6,
			signals: Sig.platform_label | Sig.high_volume | Sig.community_consensus
		},
		{
			name: '80% rule over at least 5 items counts as behavior',
			in: { votes: slop5, rollupLabelInstalls: 2, uploadsPerDay: -1, itemsSeen: 5, aiItems: 4, audienceKnown: true },
			verdict: 'slop',
			rule: 6,
			signals: Sig.mostly_ai
		},
		{
			name: 'a source of unknown size is capped at Likely slop and escalated',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14 },
			verdict: 'likely_slop',
			rule: 6,
			capped: 'audience'
		},
		{
			name: 'large source is capped at Likely slop and escalated',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, large: true },
			verdict: 'likely_slop',
			rule: 6,
			capped: 'large'
		},
		{
			name: 'mixed source with source-level AI evidence is AI-made, never slop',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, itemsSeen: 10, aiItems: 3, audienceKnown: true },
			verdict: 'ai_made',
			rule: 8
		},
		{
			name: "item labels do not count toward a mixed source's provenance",
			in: { votes: votes(2, 'slop', 1, lowHollow), rollupLabelInstalls: 6, uploadsPerDay: 14, itemsSeen: 10, aiItems: 3, audienceKnown: true },
			verdict: '',
			rule: 4
		},
		{
			name: 'item labels count toward provenance of a source that is not mixed',
			in: { votes: votes(2, 'slop', 1, lowHollow), rollupLabelInstalls: 2, uploadsPerDay: -1 },
			verdict: 'likely_slop',
			rule: 7,
			signals: Sig.platform_label
		},
		{
			name: 'split tags are Disputed',
			in: { votes: [...votes(3, 'slop', 1, 0), ...votes(3, 'not_slop', 1, 0)], labelInstalls: 2, uploadsPerDay: 14 },
			verdict: 'disputed',
			rule: 5
		},
		{
			name: 'verified appeal is Disputed whatever the evidence',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, appealOpen: true, audienceKnown: true },
			verdict: 'disputed',
			rule: 1,
			signals: Sig.open_appeal | Sig.community_consensus
		},
		{
			name: 'appeal outranks a staff decision',
			in: { votes: slop5, appealOpen: true, decision: { verdict: 'slop', signals: 0, slopType: '', tests: 0 }, uploadsPerDay: -1 },
			verdict: 'disputed',
			rule: 1
		},
		{
			name: 'staff decision wins over the computed verdict',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, decision: { verdict: 'clear', signals: 0, slopType: '', tests: 0 }, audienceKnown: true },
			verdict: 'clear',
			rule: 2,
			signals: Sig.staff_review,
			excluded: Sig.community_consensus
		},
		{
			name: 'staff decision none removes the rating',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, decision: { verdict: 'none', signals: 0, slopType: '', tests: 0 }, audienceKnown: true },
			verdict: '',
			rule: 2
		},
		{
			name: 'staff behavior signals count as the behavior layer',
			in: {
				votes: slop5,
				labelInstalls: 2,
				uploadsPerDay: -1,
				decision: { verdict: 'slop', signals: Sig.link_funnel, slopType: '', tests: 0 },
				audienceKnown: true
			},
			verdict: 'slop',
			rule: 2,
			signals: Sig.link_funnel | Sig.staff_review | Sig.community_consensus
		},
		{
			name: 'not-slop consensus is Clear even without AI evidence',
			in: { votes: votes(4, 'not_slop', 1, 0), uploadsPerDay: -1 },
			verdict: 'clear',
			rule: 3,
			signals: Sig.not_slop_consensus
		},
		{
			name: 'no provenance is not rated',
			in: { votes: votes(2, 'slop', 1, lowHollow), uploadsPerDay: 30 },
			verdict: '',
			rule: 4
		},
		{
			name: 'platform label from one install is not enough',
			in: { votes: votes(1, 'slop', 1, 0), labelInstalls: 1, uploadsPerDay: -1 },
			verdict: '',
			rule: 4
		},
		{
			name: 'AI evidence only is AI-made',
			in: { votes: votes(3, 'ai_fine', 1, 0), labelInstalls: 2, uploadsPerDay: -1 },
			verdict: 'ai_made',
			rule: 8,
			signals: Sig.platform_label
		},
		{
			name: 'burst freeze removes the consensus layer',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, frozen: true },
			verdict: 'likely_slop',
			rule: 7,
			excluded: Sig.community_consensus
		},
		{
			name: 'lapsed Slop holds at Likely slop until reviewed',
			in: { votes: slop5, labelInstalls: 2, uploadsPerDay: 14, lapseHold: true, audienceKnown: true },
			verdict: 'likely_slop',
			rule: 6,
			capped: 'lapsed'
		},
		{
			name: 'items are scored on their own and inherit source behavior',
			in: { item: true, votes: slop5, labelInstalls: 2, uploadsPerDay: -1, sourceBehavior: { met: true, signals: Sig.mostly_ai } },
			verdict: 'slop',
			rule: 6,
			signals: Sig.mostly_ai
		},
		{
			name: 'an item scoring weaker than its source is covered by the source',
			in: {
				item: true,
				votes: votes(2, 'slop', 1, lowHollow),
				labelInstalls: 2,
				sourceVerdict: 'slop',
				sourceBehavior: { met: true, signals: Sig.mostly_ai }
			},
			verdict: '',
			rule: 7
		},
		{
			name: 'an item scoring stronger than its source keeps its own verdict',
			in: {
				item: true,
				votes: votes(2, 'slop', 1, lowHollow),
				labelInstalls: 2,
				sourceVerdict: 'ai_made',
				sourceBehavior: { met: false, signals: 0 }
			},
			verdict: 'likely_slop',
			rule: 7
		},
		{
			name: 'items of a mixed source keep their own entries even when they match the source',
			in: { item: true, votes: votes(3, 'ai_fine', 1, 0), labelInstalls: 2, sourceVerdict: 'ai_made', sourceMixed: true },
			verdict: 'ai_made',
			rule: 8
		},
		{
			name: 'items of a mixed source are covered by the source under an appeal',
			in: { item: true, votes: votes(3, 'ai_fine', 1, 0), labelInstalls: 2, sourceVerdict: 'disputed', sourceMixed: true, appealOpen: true },
			verdict: '',
			rule: 1
		},
		{
			name: 'the large cap never applies to items',
			in: { item: true, votes: slop5, labelInstalls: 2, large: true, sourceBehavior: { met: true, signals: 0 } },
			verdict: 'slop',
			rule: 6
		},
		{
			name: 'low-weight new installs cannot form consensus',
			in: { votes: votes(20, 'slop', th.weight(Date.now(), Date.now(), 0, 0), lowHollow), labelInstalls: 2, uploadsPerDay: 14 },
			verdict: 'likely_slop',
			rule: 7,
			excluded: Sig.community_consensus
		}
	];

	it.each(cases)('$name', (c) => {
		const r = th.score(newInput(c.in));
		expect({ verdict: r.verdict, rule: r.rule, capped: r.cappedBy }).toEqual({ verdict: c.verdict, rule: c.rule, capped: c.capped ?? '' });
		// The queue shows what scoring says before the cap.
		if (c.capped) expect(r.computed).toBe('slop');
		expect(signalsFromMask(r.signals)).toEqual(expect.arrayContaining(signalsFromMask(c.signals ?? 0)));
		expect(signalsFromMask(r.signals & (c.excluded ?? 0))).toEqual([]);
	});
});

describe('weight', () => {
	it('starts new installs at 0.1 and moves mature ones by their accuracy', () => {
		const th = Default;
		const now = Date.now();
		expect(th.weight(now, now, 0, 0)).toBe(0.1);
		const mature = th.weight(now - 60 * DAY, now, 98, 98);
		expect(mature).toBeGreaterThanOrEqual(0.98);
		expect(mature).toBeLessThanOrEqual(1);
		expect(th.weight(now - 60 * DAY, now, 0, 98)).toBeLessThanOrEqual(0.11);
	});
});
