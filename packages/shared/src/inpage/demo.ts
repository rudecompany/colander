// The recreated feed for the website hero, the strictness cards, the welcome page and the store
// art. One shadow host holds the whole host page, so the sheet ships once. The chips, bars,
// stubs, covers and popover inside are the builders the extension ships.
import { DEMO_FEED, ITEM_NOUN, type DemoItem, type ThumbScene } from '../copy';
import { ACTION_TABLE, PLATFORM_NAME, barReason, type Action, type Platform, type Strictness } from '../verdicts';
import { hyper } from './dom';
import { evidence } from './evidence';
import type { InpageContext } from './host';
import { THUMB_CSS, THUMB_SCENES, toneVar } from './thumbs';
import { bar, chip, cover, evidencePopover, gridStub, type ItemView } from './ui';

export type DemoLayout = 'grid' | 'list' | 'swipe' | 'mini';

export const PLATFORM_LAYOUT: Record<Platform, Exclude<DemoLayout, 'mini'>> = { yt: 'grid', tt: 'swipe', ig: 'swipe', fb: 'list' };

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
	/** Items whose treatment just changed, which fade in. */
	changed?: number[];
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

/** Hidden items at a level: the toolbar badge. Label 0, Standard 2, Strict 3, No AI 4. */
export function demoHiddenCount(level: Strictness, paused = false, items = DEMO_FEED): number {
	return items.filter((i) => demoAction(i, level, paused) === 'hide').length;
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
	for (const p of s.prims) {
		const paint = 'stroke' in p && p.stroke ? `fill:none;stroke:${toneVar(p.tone)};stroke-width:${p.stroke}` : `fill:${toneVar(p.tone)}`;
		if ('rect' in p) svg.append(el('rect', { x: p.rect[0], y: p.rect[1], width: p.rect[2], height: p.rect[3], style: paint }));
		else if ('circle' in p) svg.append(el('circle', { cx: p.circle[0], cy: p.circle[1], r: p.circle[2], style: paint }));
		else if ('path' in p) svg.append(el('path', { d: p.path, style: paint }));
		else if (part != null) {
			const t = el('text', { x: p.x, y: p.y, style: `${paint};font:700 ${p.size}px var(--cl-font)` });
			t.textContent = scene === 'template-a' ? `Part ${part}` : String(part);
			svg.append(t);
		}
	}
	return svg;
}

export function demoFeed(ctx: InpageContext, s: DemoState, x: DemoHandlers): HTMLElement {
	const h = hyper(ctx.doc);
	const items = s.items ?? DEMO_FEED;
	const platform = s.platform ?? 'yt';
	const noun = ITEM_NOUN[platform];
	const mini = s.layout === 'mini';
	const cards: HTMLElement[] = [];

	for (const item of items) {
		let action = demoAction(item, s.level, s.paused);
		if (s.allowed?.includes(item.id)) action = 'allow';
		if (action === 'hide' && s.layout !== 'swipe') continue;
		const covered = action === 'hide' || action === 'collapse';
		const shown = s.revealed?.includes(item.id) ?? false;
		const view: ItemView = { verdict: item.verdict, reason: barReason(item.signals, item.verdict), hidden: covered };
		const reveal = { onShow: () => x.show(item.id), onWhy: () => x.why(item.id) };
		const open = s.open === item.id;
		const label = !shown && action === 'label' && item.verdict ? chip(ctx, view, mini ? { tone: 'tint', size: 'sm' } : { tone: 'ink', onWhy: () => x.why(item.id) }) : null;
		const pop =
			open && item.verdict && !mini
				? evidencePopover(
						ctx,
						evidence({ verdict: item.verdict, hidden: covered, signals: item.signals, rows: item.evidence, listDate: s.listDate }),
						{
							show: covered && !shown ? () => x.show(item.id) : undefined,
							allow: () => x.allow(item.id),
							notSlop: () => x.notSlop(item.id)
						},
						{ flat: s.layout === 'list' }
					)
				: null;
		pop?.classList.add('pop-in');
		pop?.setAttribute('data-k', `pop-${item.id}`);
		// Mini rows are too small for a chip on the thumbnail, so it sits under the title.
		const thumb = () => h('div', { class: 'thumb' }, thumbSvg(ctx.doc, item.scene, item.part), !mini && label && h('div', { class: 'on-media' }, label));
		const text = () =>
			h(
				'div',
				{ class: 'text' },
				h('p', { class: 'title' }, item.title),
				mini ? label : h('p', { class: 'meta' }, `${item.handle} · ${item.age}`)
			);
		const cls = `card${s.changed?.includes(item.id) ? ' enter' : ''}`;
		let card: HTMLElement;

		if (covered && !shown && s.layout === 'swipe') {
			card = h('article', { class: cls }, h('div', { class: 'video' }, thumbSvg(ctx.doc, item.scene, item.part), cover(ctx, view, { ...reveal, onSkip: () => x.skip(item.id) })), text());
		} else if (covered && !shown && s.layout === 'grid') {
			card = h('article', { class: `${cls} stubbed` }, h('div', { class: 'thumb' }, gridStub(ctx, view, reveal)));
		} else if (covered && !shown) {
			card = h('article', { class: `${cls} barred` }, bar(ctx, view, reveal));
		} else if (s.layout === 'swipe') {
			card = h(
				'article',
				{ class: cls },
				h('div', { class: 'video' }, thumbSvg(ctx.doc, item.scene, item.part)),
				h('div', { class: 'creator' }, h('span', { class: 'meta' }, item.handle), label),
				h('p', { class: 'title' }, item.title)
			);
		} else {
			card = h('article', { class: cls }, thumb(), text());
		}
		card.setAttribute('data-k', `card-${item.id}`);
		card.setAttribute('tabindex', '-1');
		if (pop) card.append(pop);
		cards.push(card);
	}
	return h(
		'div',
		{ class: `feed feed-${s.layout}`, role: 'group', 'aria-label': `Recreated ${PLATFORM_NAME[platform]} feed of ${noun}s` },
		...cards
	);
}

/** Host-page look for the recreated feed: system font, host colors, no Colander chrome. */
export const DEMO_CSS =
	THUMB_CSS +
	`.feed{--hb:#ffffff;--hm:#606060;display:grid;gap:16px;padding:16px;background:var(--hb);color:var(--cl-text);font:400 14px/20px var(--cl-font-system)}
:host([theme='dark']) .feed{--hb:#0f0f0f;--hm:#aaaaaa}
@media (prefers-color-scheme:dark){:host([theme='auto']) .feed{--hb:#0f0f0f;--hm:#aaaaaa}}
.card{position:relative;min-width:0;border-radius:10px}
.card:focus{outline:none}
.thumb,.video{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;container-type:inline-size}
.barred{container-type:inline-size}
.thumb>svg,.video>svg{width:100%;height:100%}
.stubbed .thumb{overflow:visible}
.on-media{position:absolute;top:8px;left:8px}
.title{margin:8px 0 0;font:600 14px/20px var(--cl-font-system);display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.meta{margin:2px 0 0;color:var(--hm);font:400 12px/16px var(--cl-font-system)}
.feed-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 16px;align-content:start}
.feed-grid .card>.cl-pop{position:absolute;top:36px;left:8px;z-index:2}
.feed-grid .stubbed>.cl-pop{top:16px;left:calc(100% - 24px)}
.feed-grid .stubbed:nth-child(3n)>.cl-pop{left:auto;right:calc(100% - 24px)}
.feed-list .card{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:start}
.feed-list .title{margin:0}
.feed-list .barred,.feed-list .card:has(>.cl-pop){display:block}
.feed-list .card>.cl-pop{margin-top:8px}
.feed-swipe{grid-template-columns:repeat(3,minmax(0,220px));justify-content:center;gap:16px}
.feed-swipe .video{aspect-ratio:9/16}
.feed-swipe .card>.cl-pop{position:absolute;top:48px;left:8px;z-index:2}
.creator{display:flex;align-items:center;gap:8px;margin-top:8px}
.creator .meta{margin:0}
.feed-mini{gap:8px;padding:0;background:transparent}
.feed-mini .card{display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center}
.feed-mini .text{display:grid;gap:4px;justify-items:start}
.feed-mini .barred{display:block}
.feed-mini .thumb{border-radius:6px}
.feed-mini .title{margin:0;-webkit-line-clamp:1}
.enter{animation:cl-in var(--cl-slow) var(--cl-ease)}
.pop-in{animation:cl-pop var(--cl-fast) var(--cl-ease)}`;
