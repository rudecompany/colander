// The plain-language reasons the decision log and the review queue show (Go's scoring/reason.go).
import type { Result } from './rules';

/** Plain-language signal clauses, worded after SIGNAL_TEXT in packages/shared/src/verdicts.ts. */
const signalPhrase = [
	'the platform labels it AI-generated',
	'Content Credentials say it was made with AI',
	'the creator says it is AI-made',
	'a generator watermark is visible',
	'it posts at a volume no person could sustain',
	'most recent items are AI-made',
	'it uses one template across titles and thumbnails',
	'it has many near-duplicate items',
	'it routes viewers off the platform',
	'other pages share the same captions',
	'taggers found little human effort',
	'taggers found it hollow',
	'it is tagged as slop by the community',
	'staff review confirmed it',
	'an appeal is open',
	'the community says it is not slop'
];

const verdictWords: Record<string, string> = {
	slop: 'Slop',
	likely_slop: 'Likely slop',
	ai_made: 'AI-made',
	disputed: 'Disputed',
	clear: 'Clear'
};

/** The display word for a verdict ("Not rated" for none). */
const verdictWord = (v: string): string => verdictWords[v] ?? 'Not rated';

function sentence(parts: string[]): string {
	if (parts.length === 0) return '';
	let s = parts[0]!;
	if (parts.length === 2) s = `${parts[0]} and ${parts[1]}`;
	else if (parts.length > 2) s = `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
	return s[0]!.toUpperCase() + s.slice(1) + '.';
}

/** Explains a verdict the scoring pass set, in plain words built from the signals. */
export function communityReason(r: Result): string {
	if (r.verdict === '') return 'Not rated any more. The remaining evidence does not meet any verdict rule.';
	if (r.rule === 1) return 'An appeal is open, so this shows as Disputed while staff review it.';
	if (r.rule === 3) return 'The community says it is not slop.';
	if (r.rule === 5) return 'Tags are split between slop and not slop, so this shows as Disputed.';
	// Seed lists never give a verdict, so a reason never mentions one (contracts 9.3).
	const parts: string[] = [];
	if (r.provenance.signals === 0) parts.push('taggers agree it is AI-made');
	signalPhrase.forEach((p, i) => {
		if ((r.signals & (1 << i)) !== 0) parts.push(p);
	});
	let out = `${verdictWord(r.verdict)}. ${sentence(parts)}`;
	if (r.rule === 6) {
		if (r.cappedBy === 'large') out += ' Held at Likely slop until staff review it, because it has a large audience.';
		else if (r.cappedBy === 'audience') out += ' Held at Likely slop until staff review it, because its audience size is unknown.';
		else if (r.cappedBy === 'lapsed') out += ' Held at Likely slop until staff review it again, because the earlier verdict expired.';
	}
	return out;
}

/** Describes why rule 6 was capped, for the review queue. */
export function escalationSummary(cappedBy: string): string {
	switch (cappedBy) {
		case 'large':
			return 'Scores as Slop, held at Likely slop: large source needs staff review';
		case 'audience':
			return 'Scores as Slop, held at Likely slop: audience size unknown, needs staff review';
		default:
			return 'Verdict expired and scores as Slop again: held at Likely slop until reviewed';
	}
}
