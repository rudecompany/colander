// The recreated feed for the website hero, the strictness cards, the welcome page and the store
// art. One shadow host holds the whole host page, so the sheet ships once. The chips, bars,
// stubs, covers and popover inside are the builders the extension ships; the host pages around
// them are drawn here, one per platform tab: a YouTube Home grid, a TikTok For You video, an
// Instagram feed and a Facebook feed. Phones get a plain list.
import { Heart, MessageCircle, Send, Share2, ThumbsUp } from 'lucide';
import { DEMO_FEED, ITEM_NOUN, type DemoItem, type ThumbScene } from '../copy';
import { ACTION_TABLE, PLATFORM_NAME, barReason, type Action, type Platform, type Strictness } from '../verdicts';
import { hyper, icon, trapFocus } from './dom';
import { evidence } from './evidence';
import type { InpageContext } from './host';
import { THUMB_CSS, THUMB_SCENES, numeralText, toneVar } from './thumbs';
import { bar, chip, cover, evidencePopover, gridStub, type ItemView } from './ui';

/** grid: YouTube Home. swipe: one TikTok For You video. square: Instagram feed. post: Facebook feed. */
export type DemoLayout = 'grid' | 'list' | 'swipe' | 'square' | 'post' | 'mini';

export const PLATFORM_LAYOUT: Record<Platform, Exclude<DemoLayout, 'mini'>> = { yt: 'grid', tt: 'swipe', ig: 'square', fb: 'post' };

/**
 * Item order per layout, when the caller does not pick items. The grid puts the Likely slop stub
 * at the end of row 2 at Standard, so its open popover drops into the free end of row 3 and covers
 * no card. Feeds of tall posts start with it, so the bar and its popover are in the first view.
 */
export const DEMO_ORDER: Partial<Record<DemoLayout, number[]>> = {
	grid: [1, 2, 3, 4, 5, 7, 8, 6, 9],
	swipe: [6, 2, 4, 3, 1, 5, 7, 8, 9],
	square: [6, 3, 1, 5, 2, 7, 4, 8, 9],
	post: [6, 3, 1, 5, 2, 7, 4, 8, 9]
};

export interface DemoState {
	layout: DemoLayout;
	level: Strictness;
	/** Without Colander: no chips, every item visible. */
	paused?: boolean;
	platform?: Platform;
	items?: DemoItem[];
	/** Items shown again with Show. */
	revealed?: number[];
	/** Items allowed with Always allow or Not slop. */
	allowed?: number[];
	/** The item whose evidence card is open. */
	open?: number | null;
	/** The live list date at build, for the evidence caption; omitted when unknown. */
	listDate?: string | null;
	/** Items whose treatment the visitor just changed: they fade in, once. */
	changed?: number[];
	/** The item whose popover the visitor just opened: it fades in, once. Never on load. */
	opened?: number | null;
	/** data-k keys to move focus to after this build, the first that exists wins. */
	focus?: string[];
}

export interface DemoHandlers {
	show(id: number): void;
	why(id: number): void;
	allow(id: number): void;
	notSlop(id: number): void;
	skip(id: number): void;
}

/** What the strictness level does to an item, before Show and Always allow. */
export function demoAction(item: DemoItem, level: Strictness, paused = false): Action {
	return paused || !item.verdict ? 'allow' : ACTION_TABLE[level][item.verdict];
}

/**
 * Hidden and collapsed items at a level: the toolbar badge and the popup's "Hidden on this page",
 * as the extension counts them. Label 0, Standard 3, Strict 4, No AI 4.
 */
export function demoHiddenCount(level: Strictness, paused = false, items = DEMO_FEED): number {
	return items.filter((i) => {
		const a = demoAction(i, level, paused);
		return a === 'hide' || a === 'collapse';
	}).length;
}

/** "1 hidden, 1 collapsed, 1 labeled", the count line under a strictness card. */
export function demoCounts(level: Strictness, items = DEMO_FEED): string {
	const n = (a: Action) => items.filter((i) => demoAction(i, level) === a).length;
	return `${n('hide')} hidden, ${n('collapse')} collapsed, ${n('label')} labeled`;
}

/** The thumbnail picture, in the given document. */
export function thumbSvg(doc: Document, scene: ThumbScene, part?: number): SVGElement {
	const NS = 'http://www.w3.org/2000/svg';
	const el = (tag: string, attrs: Record<string, string | number>) => {
		const n = doc.createElementNS(NS, tag);
		for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
		return n;
	};
	const s = THUMB_SCENES[scene];
	const svg = el('svg', { viewBox: '0 0 160 90', class: 'cl-thumb', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid slice' });
	svg.append(el('rect', { width: 160, height: 90, style: `fill:${toneVar(s.bg)}` }));
	svg.append(el('image', { href: s.image, width: 160, height: 90, preserveAspectRatio: 'xMidYMid slice' }));
	if (part != null) {
		for (const line of s.numeral ?? []) {
			const t = el('text', {
				x: line.x,
				y: line.y,
				'text-anchor': 'middle',
				style: `fill:${line.fill};stroke:${line.halo};stroke-width:${line.size / 9};paint-order:stroke;font:700 ${line.size}px var(--cl-font)`
			});
			t.textContent = numeralText(line, part);
			svg.append(t);
		}
	}
	return svg;
}

/** A one-shot entrance: the class goes once its animation ends, so a later rebuild or re-display never replays it. */
function once(el: HTMLElement, cls: string): void {
	el.classList.add(cls);
	el.addEventListener('animationend', function done(e) {
		if (e.target !== el) return;
		el.classList.remove(cls);
		el.removeEventListener('animationend', done);
	});
}

export function demoFeed(ctx: InpageContext, s: DemoState, x: DemoHandlers): HTMLElement {
	const h = hyper(ctx.doc);
	const platform = s.platform ?? 'yt';
	const noun = ITEM_NOUN[platform];
	const mini = s.layout === 'mini';
	const swipe = s.layout === 'swipe';
	// Flat popovers sit in the flow under their bar; the grid and the video float theirs.
	const inline = s.layout === 'list' || s.layout === 'square' || s.layout === 'post';
	// The For You page shows one video at a time; Skip moves to the next.
	const items = swipe ? (s.items ?? DEMO_FEED).slice(0, 1) : (s.items ?? DEMO_FEED);
	const cards: HTMLElement[] = [];

	for (const item of items) {
		let action = demoAction(item, s.level, s.paused);
		if (s.allowed?.includes(item.id)) action = 'allow';
		if (action === 'hide' && !swipe) continue;
		const covered = action === 'hide' || action === 'collapse';
		const shown = s.revealed?.includes(item.id) ?? false;
		const open = s.open === item.id && !!item.verdict && !mini;
		const popId = `cl-pop-${item.id}`;
		const view: ItemView = { verdict: item.verdict, reason: barReason(item.signals, item.verdict), hidden: covered };
		const anchor = { key: item.id, expanded: open, controls: popId };
		const reveal = { onShow: () => x.show(item.id), onWhy: () => x.why(item.id), ...anchor };
		const label =
			!shown && action === 'label' && item.verdict
				? chip(ctx, view, mini ? { tone: 'tint', size: 'sm' } : { tone: s.layout === 'square' || s.layout === 'post' ? 'tint' : 'ink', onWhy: () => x.why(item.id), ...anchor })
				: null;
		let pop: HTMLElement | null = null;
		if (open) {
			const ev = evidence({
				verdict: item.verdict,
				hidden: covered,
				signals: item.signals,
				rows: item.evidence,
				listDate: s.listDate,
				platform,
				sourceId: item.handle,
				appealable: true,
				inertLinks: true
			});
			pop = evidencePopover(
				ctx,
				ev,
				{ show: covered && !shown ? () => x.show(item.id) : undefined, allow: () => x.allow(item.id), notSlop: () => x.notSlop(item.id) },
				{ flat: inline, key: item.id, id: popId }
			);
			if (s.opened === item.id) once(pop, 'pop-in');
			const popEl = pop;
			popEl.addEventListener('keydown', (e) => trapFocus(popEl.getRootNode() as ShadowRoot, popEl, e));
		}
		const art = () => thumbSvg(ctx.doc, item.scene, item.part);
		const meta = (text: string) => h('p', { class: 'meta' }, text);
		let card: HTMLElement;

		if (covered && !shown && swipe) {
			card = h('article', { class: 'card reel' }, h('div', { class: 'video' }, art(), cover(ctx, view, { ...reveal, onSkip: () => x.skip(item.id) }), pop), rail(ctx));
		} else if (covered && !shown && s.layout === 'grid') {
			card = h('article', { class: 'card stubbed' }, h('div', { class: 'thumb' }, gridStub(ctx, view, reveal), pop));
		} else if (covered && !shown) {
			card = h('article', { class: 'card barred' }, bar(ctx, view, reveal), pop);
		} else if (swipe) {
			const caption = h('div', { class: 'cap' }, h('p', { class: 'creator' }, h('b', {}, item.handle), label), h('p', { class: 'title' }, item.title));
			card = h('article', { class: 'card reel' }, h('div', { class: 'video' }, art(), caption, pop), rail(ctx));
		} else if (s.layout === 'square') {
			card = h(
				'article',
				{ class: 'card' },
				h('div', { class: 'post-head' }, h('span', { class: 'avatar' }), h('b', { class: 'name' }, item.handle.slice(1)), h('span', { class: 'meta' }, `· ${item.age}`), label),
				pop,
				h('div', { class: 'media' }, art()),
				actions(ctx, [Heart, 'Like'], [MessageCircle, 'Comment'], [Send, 'Share']),
				h('p', { class: 'caption' }, h('b', {}, item.handle.slice(1)), ` ${item.title}`)
			);
		} else if (s.layout === 'post') {
			card = h(
				'article',
				{ class: 'card' },
				h(
					'div',
					{ class: 'post-head' },
					h('span', { class: 'avatar' }),
					h('div', { class: 'who' }, h('p', { class: 'name-row' }, h('b', { class: 'name' }, item.handle.slice(1)), label), meta(item.age))
				),
				pop,
				h('p', { class: 'text' }, item.title),
				h('div', { class: 'media' }, art()),
				actions(ctx, [ThumbsUp, 'Like'], [MessageCircle, 'Comment'], [Share2, 'Share'])
			);
		} else {
			// Grid, list and mini rows. Mini rows are too small for a chip on the thumbnail, so it sits under the title.
			card = h(
				'article',
				{ class: 'card' },
				h('div', { class: 'thumb' }, art(), !mini && label && h('div', { class: 'on-media' }, label)),
				h('div', { class: 'text' }, h('p', { class: 'title' }, item.title), mini ? label : meta(`${item.handle} · ${item.age}`)),
				pop
			);
		}
		if (s.changed?.includes(item.id)) once(card, 'enter');
		card.setAttribute('data-k', `card-${item.id}`);
		card.setAttribute('tabindex', '-1');
		cards.push(card);
	}
	const root = h(
		'div',
		{ class: `feed feed-${s.layout}`, role: 'group', 'aria-label': `Recreated ${PLATFORM_NAME[platform]} feed of ${noun}s` },
		...cards
	);
	if (s.focus?.length) root.setAttribute('data-focus', s.focus.join(' '));
	return root;
}

/** The host page's own buttons: pictures here, so plain words, not controls. */
function actions(ctx: InpageContext, ...list: [Parameters<typeof icon>[1], string][]): HTMLElement {
	const h = hyper(ctx.doc);
	return h('p', { class: 'acts-row', 'aria-hidden': 'true' }, ...list.map(([node, word]) => h('span', {}, icon(ctx.doc, node, 20), word)));
}

/** TikTok's action rail beside the video. */
function rail(ctx: InpageContext): HTMLElement {
	const h = hyper(ctx.doc);
	return h(
		'div',
		{ class: 'rail', 'aria-hidden': 'true' },
		...([[Heart, 'Like'], [MessageCircle, 'Comment'], [Share2, 'Share']] as const).map(([node, word]) =>
			h('span', {}, h('i', {}, icon(ctx.doc, node, 20)), word)
		)
	);
}

/**
 * Host-page look for the recreated feeds: the system font, each platform's own page and card
 * colors (illustration only, not theme tokens), and no Colander chrome. `--demo-end` reserves the
 * right edge where the website docks the popup, so the page runs on under it. A host with the
 * `crop` class has a fixed height: the page fades out over its last 48 px instead of being cut
 * through a row, under any open popover.
 */
export const DEMO_CSS =
	THUMB_CSS +
	`.feed{--hb:#ffffff;--hm:#606060;--hs:#ffffff;--hl:#e4e6eb;--hf:#f1f1f2;display:grid;gap:16px;box-sizing:border-box;min-height:100%;padding:16px var(--demo-end,16px) 16px 16px;background:var(--hb);color:var(--cl-text);font:400 14px/20px var(--cl-font-system)}
.feed-post{--hb:#f0f2f5;--hm:#65676b}
:host([theme='dark']) .feed{--hb:#0f0f0f;--hm:#aaaaaa;--hs:#242526;--hl:#3e4042;--hf:#2f2f2f}
:host([theme='dark']) .feed-post{--hb:#18191a;--hm:#b0b3b8}
@media (prefers-color-scheme:dark){:host([theme='auto']) .feed{--hb:#0f0f0f;--hm:#aaaaaa;--hs:#242526;--hl:#3e4042;--hf:#2f2f2f}:host([theme='auto']) .feed-post{--hb:#18191a;--hm:#b0b3b8}}
:host(.crop) .feed{position:relative;height:100%;overflow:hidden}
:host(.crop) .feed::after{content:'';position:absolute;inset:auto 0 0;z-index:1;height:48px;background:linear-gradient(transparent,var(--hb));pointer-events:none}
.card{position:relative;min-width:0;border-radius:10px}
.card:focus{outline:none}
.card:focus-visible{outline:2px solid var(--cl-brand);outline-offset:2px}
.bar,.stub,.cover{animation:none}
.thumb,.video,.media{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;container-type:inline-size}
.barred{container-type:inline-size}
.thumb>svg,.video>svg,.media>svg{width:100%;height:100%}
.stubbed .thumb{overflow:visible}
.on-media{position:absolute;top:8px;left:8px}
.title{margin:8px 0 0;font:600 14px/20px var(--cl-font-system);display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.meta{margin:2px 0 0;color:var(--hm);font:400 12px/16px var(--cl-font-system)}
.feed-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 16px;align-content:start}
.feed-grid .card>.cl-pop{position:absolute;top:36px;left:8px;z-index:2}
.feed-grid .card:nth-child(3n)>.cl-pop{left:auto;right:8px}
.feed-grid .stubbed .thumb>.cl-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:2}
.feed-grid .stubbed:nth-child(3n) .thumb>.cl-pop{left:auto;right:-48px}
.feed-list .card{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:start}
.feed-list .title{margin:0}
.feed-list .text{min-width:0;padding-right:4px}
.feed-list .meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-list .barred,.feed-list .card:has(>.cl-pop){display:block}
.feed-list .card>.cl-pop{margin-top:8px}
@media (max-width:379px){.feed-list .card{grid-template-columns:minmax(96px,40%) minmax(0,1fr)}}
.feed-swipe{justify-content:center;align-content:start}
.reel{display:flex;align-items:flex-end;gap:12px;margin-left:56px}
.feed-swipe .video{width:min(340px,70vw);aspect-ratio:9/16;overflow:visible}
.feed-swipe .video>svg{border-radius:10px}
.cap{position:absolute;inset:auto 0 0;display:grid;gap:4px;padding:56px 12px 12px;border-radius:0 0 10px 10px;background:linear-gradient(transparent,rgb(0 0 0/0.62));color:#ffffff}
.cap .title{margin:0;font-weight:400}
.creator{display:flex;align-items:center;gap:8px;margin:0;font:600 14px/20px var(--cl-font-system)}
.rail{display:grid;gap:16px;justify-items:center;padding-bottom:8px;color:var(--hm);font:400 12px/16px var(--cl-font-system)}
.rail span{display:grid;justify-items:center;gap:4px}
.rail i{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--hf);color:var(--cl-text)}
.feed-swipe .video>.cl-pop{position:absolute;bottom:112px;left:50%;margin-left:-160px;z-index:2}
.feed-swipe .video:has(>.cover)>.cl-pop{top:224px;bottom:auto}
.feed-swipe .video:has(>.cl-pop)>.cover{justify-content:flex-start;padding-top:40px}
.feed-swipe .cover{border-radius:10px}
.feed-square,.feed-post{justify-items:center;align-content:start}
.feed-square .card,.feed-square .barred{width:min(100%,420px)}
.feed-post .card{width:min(100%,500px);padding:12px 16px 4px;background:var(--hs);border-radius:8px}
.feed-post .barred{padding:8px}
.post-head{display:flex;align-items:center;gap:8px;min-height:48px}
.avatar{flex:none;width:32px;height:32px;border-radius:50%;background:var(--hf);box-shadow:inset 0 0 0 1px var(--hl)}
.feed-post .avatar{width:40px;height:40px}
.name{font:600 14px/20px var(--cl-font-system)}
.post-head .meta{margin:0}
.name-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0}
.feed-square .media{aspect-ratio:1;border-radius:4px}
.feed-post .media{margin:8px -16px 0;border-radius:0}
.text{margin:0}
.feed-post .text{margin-top:8px}
.acts-row{display:flex;gap:16px;margin:0;padding:10px 0;color:var(--cl-text);font:600 14px/20px var(--cl-font-system)}
.acts-row span{display:inline-flex;align-items:center;gap:6px}
.feed-post .acts-row{justify-content:space-around;margin-top:4px;border-top:1px solid var(--hl);color:var(--hm)}
.caption{margin:0}
.feed-square .card>.cl-pop,.feed-post .card>.cl-pop{margin:4px 0 8px}
.feed-mini{gap:8px;padding:0;min-height:0;background:transparent}
.feed-mini .card{display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center}
.feed-mini .text{display:grid;gap:4px;justify-items:start}
.feed-mini .barred{display:block}
.feed-mini .thumb{border-radius:6px}
.feed-mini .title{margin:0;-webkit-line-clamp:1}
.enter{animation:cl-in var(--cl-slow) var(--cl-ease)}
.pop-in{animation:cl-pop var(--cl-fast) var(--cl-ease)}`;
