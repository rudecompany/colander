// Verdicts, signals, strictness and vocabulary shared by the extension and the website.
// The numeric codes match the binary list format in docs/contracts.md. Never renumber.

export type Platform = 'yt' | 'tt' | 'ig' | 'fb';
export const PLATFORMS: Platform[] = ['yt', 'tt', 'ig', 'fb'];
export const PLATFORM_CODE: Record<Platform, number> = { yt: 0, tt: 1, ig: 2, fb: 3 };
export const PLATFORM_NAME: Record<Platform, string> = {
	yt: 'YouTube',
	tt: 'TikTok',
	ig: 'Instagram',
	fb: 'Facebook'
};
export const SOURCE_NOUN: Record<Platform, string> = {
	yt: 'channel',
	tt: 'profile',
	ig: 'profile',
	fb: 'page'
};

export type Verdict = 'slop' | 'likely_slop' | 'ai_made' | 'disputed' | 'clear';
export const VERDICTS: Verdict[] = ['slop', 'likely_slop', 'ai_made', 'disputed', 'clear'];
export const VERDICT_CODE: Record<Verdict, number> = {
	slop: 1,
	likely_slop: 2,
	ai_made: 3,
	disputed: 4,
	clear: 5
};
export const VERDICT_BY_CODE: Record<number, Verdict> = {
	1: 'slop',
	2: 'likely_slop',
	3: 'ai_made',
	4: 'disputed',
	5: 'clear'
};
/** The verdict word, exactly as the vocabulary table spells it. */
export const VERDICT_WORD: Record<Verdict, string> = {
	slop: 'Slop',
	likely_slop: 'Likely slop',
	ai_made: 'AI-made',
	disputed: 'Disputed',
	clear: 'Clear'
};
/** Plain-language long form for the larger, plainer chip option. */
export const VERDICT_PLAIN: Record<Verdict, string> = {
	slop: 'Low-effort AI content',
	likely_slop: 'Probably low-effort AI content',
	ai_made: 'Made with AI',
	disputed: 'People disagree about this',
	clear: 'Checked and fine'
};

export type Strictness = 'label' | 'standard' | 'no_ai';
export const STRICTNESS: Strictness[] = ['label', 'standard', 'no_ai'];
export const STRICTNESS_WORD: Record<Strictness, string> = {
	label: 'Label',
	standard: 'Standard',
	no_ai: 'No AI'
};
/** The one line under the strictness control that says what the level does. */
export const STRICTNESS_HINT: Record<Strictness, string> = {
	label: 'Labels everything with AI evidence. Nothing is hidden.',
	standard: 'Hides slop and likely slop, and labels AI-made items.',
	no_ai: 'Hides slop, likely slop and AI-made items.'
};

/** Hidden items leave the page like ads under an ad blocker: no gap, no placeholder. */
export type Action = 'hide' | 'label' | 'allow';
/** The strictness table from the spec. Disputed is always labeled and Clear is always allowed. */
export const ACTION_TABLE: Record<Strictness, Record<Verdict, Action>> = {
	label: { slop: 'label', likely_slop: 'label', ai_made: 'label', disputed: 'label', clear: 'allow' },
	standard: { slop: 'hide', likely_slop: 'hide', ai_made: 'label', disputed: 'label', clear: 'allow' },
	no_ai: { slop: 'hide', likely_slop: 'hide', ai_made: 'hide', disputed: 'label', clear: 'allow' }
};

export type SlopType = 'filler' | 'bait' | 'deceptive';
export const SLOP_TYPES: SlopType[] = ['filler', 'bait', 'deceptive'];
export const SLOP_TYPE_CODE: Record<SlopType, number> = { filler: 1, bait: 2, deceptive: 3 };
export const SLOP_TYPE_WORD: Record<SlopType, string> = {
	filler: 'Filler',
	bait: 'Bait',
	deceptive: 'Deceptive'
};
export const SLOP_TYPE_HINT: Record<SlopType, string> = {
	filler: 'Generic content tuned for engagement, with no real subject',
	bait: 'Routes you to a link, product, install or scam',
	deceptive: 'Synthetic content presented as real'
};

export type Test = 'low_effort' | 'mass_produced' | 'hollow';
export const TESTS: Test[] = ['low_effort', 'mass_produced', 'hollow'];
/** Bit positions inside the list entry `detail` byte. */
export const TEST_BIT: Record<Test, number> = { low_effort: 2, mass_produced: 3, hollow: 4 };
export const TEST_WORD: Record<Test, string> = {
	low_effort: 'Low effort',
	mass_produced: 'Mass-produced',
	hollow: 'Hollow'
};
export const TEST_HINT: Record<Test, string> = {
	low_effort: 'Little sign of human authorship',
	mass_produced: 'Volume and sameness point to a pipeline',
	hollow: 'Looks competent but says little, or pushes a link'
};

export type TagVerdict = 'slop' | 'ai_fine' | 'not_slop';
export const TAG_WORD: Record<TagVerdict, string> = {
	slop: 'Slop',
	ai_fine: 'AI-made but fine',
	not_slop: 'Not slop'
};

/** Signal bit positions in the list entry `signals` field. Order is part of the wire format. */
export const SIGNALS = [
	'platform_label',
	'content_credentials',
	'creator_statement',
	'watermark',
	'high_volume',
	'mostly_ai',
	'templated',
	'near_duplicates',
	'link_funnel',
	'cross_posting',
	'rubric_low_effort',
	'rubric_hollow',
	'community_consensus',
	'staff_review',
	'open_appeal',
	'not_slop_consensus'
] as const;
export type Signal = (typeof SIGNALS)[number];
export const SIGNAL_BIT = Object.fromEntries(SIGNALS.map((s, i) => [s, i])) as Record<Signal, number>;
/** Short reasons used in the Why popover. */
export const SIGNAL_TEXT: Record<Signal, string> = {
	platform_label: 'The platform labels it AI-generated',
	content_credentials: 'Content Credentials say it was made with AI',
	creator_statement: 'The creator says it is AI-made',
	watermark: 'A generator watermark is visible',
	high_volume: 'Posts at a volume no person could sustain',
	mostly_ai: 'Most recent items are AI-made',
	templated: 'One template across titles and thumbnails',
	near_duplicates: 'Many near-duplicate items',
	link_funnel: 'Routes viewers off the platform',
	cross_posting: 'Other pages share the same captions',
	rubric_low_effort: 'Taggers found little human effort',
	rubric_hollow: 'Taggers found it hollow',
	community_consensus: 'Tagged as slop by the community',
	staff_review: 'Confirmed by staff review',
	open_appeal: 'An appeal is open',
	not_slop_consensus: 'The community says it is not slop'
};

export function signalsFromMask(mask: number): Signal[] {
	return SIGNALS.filter((_, i) => (mask >> i) & 1);
}

export function maskFromSignals(list: Signal[]): number {
	return list.reduce((m, s) => m | (1 << SIGNAL_BIT[s]), 0);
}

/** The treatment as a past-tense word: "Hidden", "Labeled", "Shown". */
export const ACTION_DONE_WORD: Record<Action, string> = {
	hide: 'Hidden',
	label: 'Labeled',
	allow: 'Shown'
};
