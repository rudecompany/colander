// What a decorated card shows, from the matching engine's decision: the chip and bar view and
// the evidence behind Why. Pure, so it is unit tested; the shared builders draw the result.
import { evidence, type Evidence } from '@colander/shared/inpage/evidence.ts';
import type { ItemView } from '@colander/shared/inpage/ui.ts';
import { barReason, type Platform, type Verdict } from '@colander/shared/verdicts';
import { dayToDate } from '../lib/list';
import type { Decision } from '../lib/match';

/** An own tag's verdict back to the words of the tag the person chose. */
const TAGGED_AS: Partial<Record<Verdict, string>> = { slop: 'slop', ai_made: 'AI-made but fine', clear: 'not slop' };

/** The short reason in a collapsed bar or cover ("Mass-produced, AI-made"). Never repeats the verdict word. */
export function reasonText(d: Decision): string {
	switch (d.reason) {
		case 'own_tag':
			return 'Your tag';
		case 'my_list':
			return 'On My list';
		case 'topic':
			return `Your rule: ${d.topic}`;
		case 'platform_label':
			return 'Labeled by the platform';
		default:
			return barReason(d.signals, d.verdict) || 'Core list';
	}
}

export function itemView(d: Decision, hidden: boolean, plain: boolean): ItemView {
	return { verdict: d.verdict, word: d.verdict ? undefined : 'Your rule', reason: reasonText(d), plain, hidden };
}

/**
 * Why: the layers that agreed, the list and its date, and the links. Only a list verdict can be
 * appealed, and the person's own tags, blocks and rules link nowhere.
 */
export function whyEvidence(d: Decision, o: { hidden: boolean; platform: Platform; sourceId: string | null; site: string }): Evidence {
	const own = (label: string, text: string) => evidence({ verdict: d.verdict, word: d.verdict ? undefined : 'Your rule', hidden: o.hidden, rows: [{ key: 'rule', label, text, agreed: true }] });
	switch (d.reason) {
		case 'own_tag':
			return own('Your tag', `You tagged it as ${TAGGED_AS[d.verdict!] ?? 'slop'}.`);
		case 'my_list':
			return own('My list', 'It is on My list blocks.');
		case 'topic':
			return own('Your rule', `It matches your rule: ${d.topic}.`);
		default: {
			const listed = d.reason === 'item_list' || d.reason === 'source_list';
			return evidence({
				verdict: d.verdict,
				hidden: o.hidden,
				signals: d.signals,
				listDate: d.hit ? dayToDate(d.hit.updated) : null,
				platform: o.platform,
				sourceId: listed || d.reason === 'platform_label' ? o.sourceId : null,
				site: o.site,
				appealable: listed
			});
		}
	}
}
