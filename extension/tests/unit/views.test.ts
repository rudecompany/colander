// What a decorated card says: the bar reason and the evidence behind Why, from a decision.
import { popoverRows } from '@colander/shared/inpage';
import { describe, expect, it } from 'vitest';
import type { ListHit } from '../../src/lib/list';
import type { Decision } from '../../src/lib/match';
import { itemView, reasonText, whyEvidence } from '../../src/content/views';

const hit: ListHit = { verdict: 'likely_slop', signals: ['mostly_ai', 'rubric_hollow'], slopType: null, tests: [], item: false, large: false, imported: true, staffReviewed: false, updated: 2039 };
const base: Decision = { action: 'collapse', verdict: 'likely_slop', reason: 'source_list', signals: hit.signals, key: 'yt:s:@catrescuetales', hit, strictness: 'standard' };
const o = { hidden: true, platform: 'yt' as const, sourceId: '@catrescuetales', site: 'https://colander.app' };

describe('views', () => {
	it('name the bar without repeating the verdict word', () => {
		expect(reasonText(base)).toBe('Mostly AI, Hollow');
		expect(reasonText({ ...base, verdict: 'ai_made', signals: ['creator_statement'] })).toBe('Core list');
		expect(reasonText({ ...base, reason: 'topic', verdict: null, topic: 'Kids' })).toBe('Your rule: Kids');
		expect(itemView({ ...base, reason: 'topic', verdict: null, topic: 'Kids' }, true, false)).toMatchObject({ verdict: null, word: 'Your rule', hidden: true });
	});

	it('explain a list verdict with its layers, list date and appeal', () => {
		const ev = whyEvidence(base, o);
		expect(ev.title).toBe('Why this is hidden');
		expect(popoverRows(ev).map((r) => `${r.label}: ${r.texts[0]}`)).toEqual([
			'Source behavior: Most recent items are AI-made.',
			'Content: Taggers found it hollow.',
			'AI evidence: No AI label or credentials found yet.'
		]);
		expect(ev.list).toBe('Core list, updated 1 Aug 2025');
		expect(ev.sourceUrl).toBe('https://colander.app/s/yt/@catrescuetales');
		expect(ev.appealUrl).toBe('https://colander.app/appeal/yt/@catrescuetales');
	});

	it('link a platform label to the source page only, and your own rules nowhere', () => {
		const label = whyEvidence({ ...base, reason: 'platform_label', verdict: 'ai_made', signals: ['platform_label'], hit: null }, { ...o, hidden: false });
		expect(label.title).toBe('Why this is labeled');
		expect(label.sourceUrl).toBe('https://colander.app/s/yt/@catrescuetales');
		expect(label.appealUrl).toBeNull();
		const own = whyEvidence({ ...base, reason: 'own_tag', verdict: 'ai_made', signals: [], hit: null }, { ...o, hidden: false });
		expect(own.rows.map((r) => `${r.label}: ${r.texts[0]}`)).toEqual(['Your tag: You tagged it as AI-made but fine.']);
		expect(own.sourceUrl).toBeNull();
		expect(own.list).toBeNull();
	});
});
