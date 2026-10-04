// Matching precedence and the strictness table.
import { describe, expect, it } from 'vitest';
import { STRICTNESS, VERDICTS, ACTION_TABLE, type Strictness, type TagVerdict, type Verdict } from '@colander/shared/verdicts';
import { decide, type CardFacts, type MatchContext } from '../../src/lib/match';
import type { ListHit } from '@colander/shared/list';
import type { Topic } from '../../src/lib/settings';

const hit = (verdict: Verdict): ListHit => ({
	verdict,
	signals: ['mostly_ai'],
	slopType: null,
	tests: [],
	item: false,
	large: false,
	imported: false,
	staffReviewed: false,
	updated: 2465
});

const card: CardFacts = { platform: 'yt', itemId: 'dQw4w9WgXcQ', sourceIds: ['UCaaaaaaaaaaaaaaaaaaaaaa', '@chan'], aiLabel: false, text: 'Ancient history explained #aihistory' };

function ctx(over: Partial<MatchContext> & { list?: Record<string, Verdict> } = {}): MatchContext {
	const list = over.list ?? {};
	return {
		strictness: 'standard',
		perPlatform: {},
		topics: [],
		plus: false,
		paused: false,
		allows: new Set(),
		blocks: new Set(),
		ownTags: new Map(),
		lookup: (k) => (list[k] ? hit(list[k]) : null),
		...over
	};
}

describe('strictness table', () => {
	const table: [Strictness, Verdict, string][] = [];
	for (const s of STRICTNESS) for (const v of VERDICTS) table.push([s, v, ACTION_TABLE[s][v]]);
	it.each(table)('%s + %s source -> %s', (s, v, action) => {
		const d = decide(card, ctx({ strictness: s, list: { 'yt:s:@chan': v } }));
		expect(d.verdict).toBe(v);
		expect(d.action).toBe(action);
		expect(d.reason).toBe('source_list');
	});

	it('matches the spec rows', () => {
		expect(ACTION_TABLE.standard).toMatchObject({ slop: 'hide', likely_slop: 'collapse', ai_made: 'label', disputed: 'label', clear: 'allow' });
		expect(ACTION_TABLE.strict).toMatchObject({ slop: 'hide', likely_slop: 'hide', ai_made: 'collapse' });
		expect(ACTION_TABLE.no_ai).toMatchObject({ slop: 'hide', likely_slop: 'hide', ai_made: 'hide', disputed: 'label' });
		expect(ACTION_TABLE.label).toMatchObject({ slop: 'label', likely_slop: 'label', ai_made: 'label' });
	});
});

describe('precedence', () => {
	const slopEverywhere = { 'yt:s:@chan': 'slop', 'yt:i:dQw4w9WgXcQ': 'slop' } as Record<string, Verdict>;
	const cases: [string, Partial<MatchContext> & { list?: Record<string, Verdict> }, Partial<CardFacts>, string, string | null, string][] = [
		['pause beats everything', { paused: true, list: slopEverywhere, blocks: new Set(['yt:s:@chan']) }, {}, 'paused', null, 'none'],
		['allow beats lists and own tags', { list: slopEverywhere, allows: new Set(['yt:s:@chan']), ownTags: new Map<string, TagVerdict>([['yt:i:dQw4w9WgXcQ', 'slop']]) }, {}, 'allowed', null, 'allow'],
		['own Slop tag acts as Slop', { ownTags: new Map<string, TagVerdict>([['yt:i:dQw4w9WgXcQ', 'slop']]) }, {}, 'own_tag', 'slop', 'hide'],
		['own Not slop tag clears a listed item', { list: slopEverywhere, ownTags: new Map<string, TagVerdict>([['yt:i:dQw4w9WgXcQ', 'not_slop']]) }, {}, 'own_tag', 'clear', 'allow'],
		['own AI-made but fine tag labels', { list: slopEverywhere, ownTags: new Map<string, TagVerdict>([['yt:s:UCaaaaaaaaaaaaaaaaaaaaaa', 'ai_fine']]) }, {}, 'own_tag', 'ai_made', 'label'],
		['own tag beats own block', { blocks: new Set(['yt:s:@chan']), ownTags: new Map<string, TagVerdict>([['yt:s:@chan', 'not_slop']]) }, {}, 'own_tag', 'clear', 'allow'],
		['block hides even on Label', { strictness: 'label', blocks: new Set(['yt:s:@chan']) }, {}, 'my_list', 'slop', 'hide'],
		['item entry beats source entry', { list: { 'yt:s:@chan': 'slop', 'yt:i:dQw4w9WgXcQ': 'clear' } }, {}, 'item_list', 'clear', 'allow'],
		['source entry by any alias', { list: { 'yt:s:UCaaaaaaaaaaaaaaaaaaaaaa': 'likely_slop' } }, {}, 'source_list', 'likely_slop', 'collapse'],
		['list beats the platform label', { list: { 'yt:s:@chan': 'clear' } }, { aiLabel: true }, 'source_list', 'clear', 'allow'],
		['platform label alone is AI-made (P0-4)', {}, { aiLabel: true }, 'platform_label', 'ai_made', 'label'],
		['disputed shows with its mark', { strictness: 'no_ai', list: { 'yt:s:@chan': 'disputed' } }, {}, 'source_list', 'disputed', 'label'],
		['nothing matches', {}, {}, 'none', null, 'none'],
		['item-only card with no source', { list: { 'yt:i:dQw4w9WgXcQ': 'ai_made' } }, { sourceIds: [] }, 'item_list', 'ai_made', 'label']
	];
	it.each(cases)('%s', (_name, c, f, reason, verdict, action) => {
		const d = decide({ ...card, ...f }, ctx(c));
		expect(d.reason).toBe(reason);
		expect(d.verdict).toBe(verdict);
		expect(d.action).toBe(action);
	});
});

describe('Plus strictness', () => {
	const kids: Topic = { id: 't1', name: 'Kids', terms: ['#aihistory', 'cartoon'], strictness: 'no_ai', hide: false };
	const muted: Topic = { id: 't2', name: 'Muted', terms: ['ancient history'], strictness: 'standard', hide: true };

	it('per-platform strictness replaces the global level only with Plus', () => {
		const c = { list: { 'yt:s:@chan': 'likely_slop' as Verdict }, perPlatform: { yt: 'label' as Strictness } };
		expect(decide(card, ctx({ ...c, plus: true })).action).toBe('label');
		expect(decide(card, ctx({ ...c, plus: false })).action).toBe('collapse');
	});

	it('the strictest matching topic wins', () => {
		const d = decide(card, ctx({ plus: true, topics: [kids], perPlatform: { yt: 'label' }, list: { 'yt:s:@chan': 'ai_made' } }));
		expect(d.strictness).toBe('no_ai');
		expect(d.action).toBe('hide');
	});

	it('hashtags and keywords match whole words', () => {
		expect(decide({ ...card, text: 'my #aihistoryfan page' }, ctx({ plus: true, topics: [kids], list: { 'yt:s:@chan': 'ai_made' } })).strictness).toBe('standard');
		expect(decide({ ...card, text: 'A CARTOON for kids' }, ctx({ plus: true, topics: [kids], list: { 'yt:s:@chan': 'ai_made' } })).strictness).toBe('no_ai');
	});

	it('a muting topic hides unlisted matches, last in precedence', () => {
		expect(decide(card, ctx({ plus: true, topics: [muted] }))).toMatchObject({ reason: 'topic', action: 'hide', topic: 'Muted' });
		expect(decide(card, ctx({ plus: false, topics: [muted] })).reason).toBe('none');
		expect(decide(card, ctx({ plus: true, topics: [muted], list: { 'yt:s:@chan': 'clear' } })).action).toBe('allow');
	});
});
