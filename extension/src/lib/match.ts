// The matching engine: decides what happens to one card. Pure and synchronous, so content
// scripts call it inside a MutationObserver callback before the page paints.
//
// Precedence, first match wins:
//   pause (site or tab) -> Always allow (My list allows) -> own tags -> own blocks (My list blocks)
//   -> item list entry -> source list entry (any alias) -> platform AI label -> Plus topic rules.
import {
	ACTION_TABLE,
	type Action,
	type Platform,
	type Signal,
	type Strictness,
	type TagVerdict,
	type Verdict
} from '@colander/shared/verdicts';
import { targetKey } from '@colander/shared/ids';
import type { ListHit } from '@colander/shared/list';
import { STRICTNESS_RANK, type Topic } from './settings';

export interface CardFacts {
	platform: Platform;
	itemId: string | null;
	/** Canonical source IDs; a channel ID and its handle are aliases of one source. */
	sourceIds: string[];
	/** The platform's own AI disclosure is shown on the item. */
	aiLabel: boolean;
	/** Title, caption and hashtags, for topic rules. */
	text: string;
}

export interface MatchContext {
	strictness: Strictness;
	perPlatform: Partial<Record<Platform, Strictness>>;
	topics: Topic[];
	plus: boolean;
	paused: boolean;
	allows: Set<string>;
	blocks: Set<string>;
	ownTags: Map<string, TagVerdict>;
	lookup(key: string): ListHit | null;
}

export type Reason =
	| 'paused'
	| 'allowed'
	| 'own_tag'
	| 'my_list'
	| 'item_list'
	| 'source_list'
	| 'platform_label'
	| 'topic'
	| 'none';

export interface Decision {
	action: Action | 'none';
	verdict: Verdict | null;
	reason: Reason;
	signals: Signal[];
	/** The target key that decided it (list entry, tag, allow or block). */
	key: string | null;
	hit: ListHit | null;
	strictness: Strictness;
	topic?: string;
}

const OWN_TAG_VERDICT: Record<TagVerdict, Verdict> = { slop: 'slop', ai_fine: 'ai_made', not_slop: 'clear' };

export function cardKeys(f: CardFacts): string[] {
	const keys = f.itemId ? [targetKey(f.platform, 'item', f.itemId)] : [];
	for (const s of f.sourceIds) keys.push(targetKey(f.platform, 'source', s));
	return keys;
}

const topicRegex = new WeakMap<Topic, RegExp | null>();

function topicPattern(t: Topic): RegExp | null {
	let re = topicRegex.get(t);
	if (re !== undefined) return re;
	const terms = t.terms.map((s) => s.trim().toLowerCase()).filter(Boolean);
	re = terms.length
		? new RegExp(
				`(?:^|[^\\p{L}\\p{N}_#])(?:${terms.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_])`,
				'iu'
			)
		: null;
	topicRegex.set(t, re);
	return re;
}

export function matchingTopics(text: string, topics: Topic[]): Topic[] {
	if (!text || !topics.length) return [];
	return topics.filter((t) => topicPattern(t)?.test(text));
}

/** The strictness that applies to this card: global, or per-platform and per-topic with Plus. Strictest topic wins. */
export function effectiveStrictness(f: CardFacts, ctx: MatchContext, topics: Topic[]): Strictness {
	let s = ctx.plus ? (ctx.perPlatform[f.platform] ?? ctx.strictness) : ctx.strictness;
	for (const t of topics) if (STRICTNESS_RANK[t.strictness] > STRICTNESS_RANK[s]) s = t.strictness;
	return s;
}

export function decide(f: CardFacts, ctx: MatchContext): Decision {
	const topics = ctx.plus ? matchingTopics(f.text, ctx.topics) : [];
	const strictness = effectiveStrictness(f, ctx, topics);
	const out = (
		reason: Reason,
		verdict: Verdict | null,
		key: string | null,
		extra: Partial<Decision> = {}
	): Decision => ({
		action: verdict ? ACTION_TABLE[strictness][verdict] : 'none',
		verdict,
		reason,
		signals: [],
		key,
		hit: null,
		strictness,
		...extra
	});

	if (ctx.paused) return out('paused', null, null);
	const keys = cardKeys(f);

	const allowed = keys.find((k) => ctx.allows.has(k));
	if (allowed) return out('allowed', null, allowed, { action: 'allow' });

	for (const k of keys) {
		const tag = ctx.ownTags.get(k);
		if (tag) return out('own_tag', OWN_TAG_VERDICT[tag], k);
	}

	// A personal block always hides, whatever the strictness: the user asked for exactly that.
	const blocked = keys.find((k) => ctx.blocks.has(k));
	if (blocked) return out('my_list', 'slop', blocked, { action: 'hide' });

	for (const k of keys) {
		const hit = ctx.lookup(k);
		if (hit) return out(k.charAt(3) === 'i' ? 'item_list' : 'source_list', hit.verdict, k, { hit, signals: hit.signals });
	}

	if (f.aiLabel) return out('platform_label', 'ai_made', keys[0] ?? null, { signals: ['platform_label'] });

	const muting = topics.find((t) => t.hide);
	if (muting) return out('topic', null, null, { action: 'hide', topic: muting.name });

	return out('none', null, null);
}
