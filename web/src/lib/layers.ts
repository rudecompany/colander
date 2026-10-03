// The four evidence layers from the spec, and which signals belong to each.
import type { Signal } from '@colander/shared';

export type LayerKey = 'provenance' | 'behavior' | 'rubric' | 'consensus';
export const LAYER_KEYS: LayerKey[] = ['provenance', 'behavior', 'rubric', 'consensus'];

export const LAYER_WORD: Record<LayerKey, string> = {
	provenance: 'Provenance',
	behavior: 'Source behavior',
	rubric: 'Content rubric',
	consensus: 'Community consensus'
};

export const LAYER_QUESTION: Record<LayerKey, string> = {
	provenance: 'Is it AI-generated?',
	behavior: 'Is it mass-produced?',
	rubric: 'Is it low effort and hollow?',
	consensus: 'Do people who usually disagree both call it slop?'
};

/** Signals a reviewer can record, grouped by layer. `staff_review` and `open_appeal` are set by the system. */
export const LAYER_SIGNALS: Record<LayerKey, Signal[]> = {
	provenance: ['platform_label', 'content_credentials', 'creator_statement', 'watermark'],
	behavior: ['high_volume', 'mostly_ai', 'templated', 'near_duplicates', 'link_funnel', 'cross_posting'],
	rubric: ['rubric_low_effort', 'rubric_hollow'],
	consensus: ['community_consensus', 'not_slop_consensus']
};

/** Group any signal list for display, with review and appeal signals last. */
export function groupSignals(signals: Signal[]): { key: LayerKey | 'review'; word: string; signals: Signal[] }[] {
	const groups: { key: LayerKey | 'review'; word: string; signals: Signal[] }[] = LAYER_KEYS.map((key) => ({
		key,
		word: LAYER_WORD[key],
		signals: LAYER_SIGNALS[key].filter((s) => signals.includes(s))
	}));
	groups.push({
		key: 'review',
		word: 'Review and appeals',
		signals: (['staff_review', 'open_appeal'] as Signal[]).filter((s) => signals.includes(s))
	});
	return groups.filter((g) => g.signals.length > 0);
}
