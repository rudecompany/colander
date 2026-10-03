// In-page UI: chips, collapsed bars, swipe covers, the Tag button and the layer that holds
// the tag menu, the Why popover, notices and the Report source dialog. Vanilla DOM in shadow
// roots, styled by styles.ts. Copy follows the spec's sample copy and vocabulary exactly.
import { ChevronsDownUp, Eye, Flag, Info, Scale, Tag, X, Check, SkipForward } from 'lucide';
import {
	SIGNAL_TEXT,
	SLOP_TYPES,
	SLOP_TYPE_WORD,
	SOURCE_NOUN,
	TESTS,
	TEST_HINT,
	TEST_WORD,
	VERDICT_PLAIN,
	VERDICT_WORD,
	shortReason,
	type Action,
	type Platform,
	type SlopType,
	type TagVerdict,
	type Test,
	type Verdict
} from '@colander/shared/verdicts';
import { SITE } from '../lib/env';
import { idSegment } from '../lib/ids';
import { dayToDate } from '../lib/list';
import type { Decision } from '../lib/match';
import { formatDate, glyph, h, icon, makeHost, reducedMotion, trapFocus } from './dom';

export interface CardView {
	platform: Platform;
	decision: Decision;
	/** Display noun for the item: video, post or reel. */
	noun: string;
	sourceId: string | null;
	plain: boolean;
}

/** The short reason in a collapsed bar ("Mass-produced, AI-made"). */
export function reasonText(d: Decision): string {
	switch (d.reason) {
		case 'own_tag':
			return 'Your tag';
		case 'my_list':
			return 'On My list';
		case 'topic':
			return `Your rule: ${d.topic}`;
		case 'platform_label':
			return 'The platform’s own label';
		default: {
			// Never repeat the verdict word ("AI-made · AI-made").
			const word = d.verdict ? VERDICT_WORD[d.verdict] : '';
			const words = shortReason(d.signals, 4).split(', ').filter((w) => w && w !== word);
			return words.slice(0, 2).join(', ') || 'Core list';
		}
	}
}

function word(v: Verdict, plain: boolean): string {
	return plain ? VERDICT_PLAIN[v] : VERDICT_WORD[v];
}

export function chip(v: CardView, tone: 'ink' | 'tint', onWhy: (anchor: HTMLElement) => void): HTMLElement {
	const { host, root } = makeHost('chip');
	const verdict = v.decision.verdict!;
	const btn = h(
		'button',
		{
			type: 'button',
			class: `chip ${tone}${v.plain ? ' plain' : ''}`,
			'data-v': verdict,
			'aria-haspopup': 'dialog',
			'aria-label': `${word(verdict, v.plain)}. Why`
		},
		glyph(verdict, v.plain ? 16 : 12),
		h('span', {}, word(verdict, v.plain)),
		h('span', { class: 'why', 'aria-hidden': 'true' }, 'Why')
	);
	btn.addEventListener('click', () => onWhy(btn));
	root.append(btn);
	return host;
}

export function bar(v: CardView, onShow: () => void, onWhy: (anchor: HTMLElement) => void): HTMLElement {
	const { host, root } = makeHost('bar');
	const verdict = v.decision.verdict;
	const label = verdict ? word(verdict, v.plain) : 'Hidden for you';
	const reason = reasonText(v.decision);
	const why = h('button', { type: 'button', class: 'link', 'aria-haspopup': 'dialog' }, 'Why');
	const el = h(
		'div',
		{ class: 'bar', role: 'group', tabindex: 0, 'aria-label': `${label}, collapsed for you: ${reason}. Press Enter to show.` },
		verdict ? glyph(verdict, 16) : icon(ChevronsDownUp, 16),
		h('span', { class: 'verdict' }, label),
		h('span', { class: 'dot', 'aria-hidden': 'true' }, '·'),
		h('span', { class: 'reason' }, reason),
		h('span', { class: 'actions' }, h('button', { type: 'button', class: 'link', onclick: onShow }, 'Show'), why)
	);
	why.addEventListener('click', () => onWhy(why));
	el.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && e.target === el) {
			e.preventDefault();
			onShow();
		}
	});
	root.append(el);
	return host;
}

/** Swipe feeds: covers the video until the viewer chooses Show or Skip. */
export function cover(v: CardView, onShow: () => void, onSkip: () => void, onWhy: (anchor: HTMLElement) => void): HTMLElement {
	const { host, root } = makeHost('cover');
	const verdict = v.decision.verdict;
	const label = verdict ? word(verdict, v.plain) : 'Hidden for you';
	const why = h('button', { type: 'button', class: 'link' }, 'Why');
	why.addEventListener('click', () => onWhy(why));
	root.append(
		h(
			'div',
			{ class: 'cover', role: 'group', 'aria-label': `${label}, covered for you` },
			h('div', { class: 'verdict' }, verdict ? glyph(verdict, 20) : null, h('span', {}, label)),
			h('p', { class: 'reason', style: 'margin:0' }, reasonText(v.decision)),
			h(
				'div',
				{ class: 'actions' },
				h('button', { type: 'button', class: 'btn', onclick: onShow }, icon(Eye), 'Show'),
				h('button', { type: 'button', class: 'btn primary', onclick: onSkip }, icon(SkipForward), 'Skip'),
				why
			)
		)
	);
	return host;
}

export function tagButton(noun: string, ink: boolean, onOpen: (anchor: HTMLElement) => void): HTMLElement {
	const { host, root } = makeHost('tag');
	const btn = h(
		'button',
		{ type: 'button', class: `tag${ink ? ' ink' : ''}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': `Tag this ${noun}` },
		icon(Tag),
		h('span', {}, 'Tag')
	);
	btn.addEventListener('click', () => onOpen(btn));
	root.append(btn);
	return host;
}

export function reportButton(noun: string, onOpen: () => void): HTMLElement {
	const { host, root } = makeHost('report');
	root.append(h('button', { type: 'button', class: 'btn', onclick: onOpen, 'aria-haspopup': 'dialog' }, icon(Flag), `Report source`));
	host.setAttribute('title', `Report this ${noun} to Colander`);
	return host;
}

export interface TagMenuHandlers {
	/** Applies the tag at once; resolves to the action the item now gets. */
	tag(verdict: TagVerdict): Promise<Action | 'none'>;
	/** Refines the Slop tag with an optional type and tests. */
	detail(type: SlopType | null, tests: Test[]): void;
	reportHelp: string;
	noun: string;
}

export interface WhyHandlers {
	show?: () => void;
	allow?: () => void;
	notSlop?: () => void;
}

const ACTION_PHRASE: Record<string, string> = {
	hide: 'Hidden for you now',
	collapse: 'Collapsed for you now',
	label: 'Labeled for you now',
	allow: 'Shown for you',
	none: 'Saved for you'
};

/** The full-page layer: one popover, one notice and one dialog at a time. */
export class Layer {
	private host: HTMLElement;
	private root: ShadowRoot;
	private box: HTMLElement;
	private pop: { el: HTMLElement; anchor: HTMLElement; restore: HTMLElement | null; onClose?: () => void } | null = null;
	private toast: { el: HTMLElement; timer: number } | null = null;
	private dialog: { el: HTMLElement; restore: HTMLElement | null } | null = null;
	private raf = 0;

	constructor() {
		const { host, root } = makeHost('layer');
		this.host = host;
		this.root = root;
		this.box = h('div', { class: 'layer' });
		root.append(this.box);
		document.addEventListener('pointerdown', (e) => {
			if (this.pop && !e.composedPath().some((n) => n === this.pop!.el || n === this.pop!.anchor)) this.closePop(false);
		}, true);
		const follow = () => {
			cancelAnimationFrame(this.raf);
			this.raf = requestAnimationFrame(() => this.place());
		};
		addEventListener('scroll', follow, { capture: true, passive: true });
		addEventListener('resize', follow, { passive: true });
	}

	private mount() {
		if (!this.host.isConnected) document.documentElement.append(this.host);
	}

	/** Called by the page controller's early key guard for every keydown. */
	onKey(e: KeyboardEvent) {
		if (this.dialog) {
			if (e.key === 'Escape') {
				e.stopPropagation();
				this.closeDialog();
			} else trapFocus(this.root, this.dialog.el, e);
			return;
		}
		if (!this.pop) return;
		const inside = e.composedPath().includes(this.pop.el);
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			this.closePop(true);
		} else if (inside) trapFocus(this.root, this.pop.el, e);
	}

	private place() {
		if (!this.pop) return;
		const { el, anchor } = this.pop;
		if (!anchor.isConnected || !anchor.getClientRects().length) {
			// The card it belonged to went away (for example it was just hidden): keep the
			// popover where it was rather than jumping.
			return;
		}
		const r = anchor.getBoundingClientRect();
		const w = el.offsetWidth, hgt = el.offsetHeight, m = 8;
		let top = r.bottom + 4;
		if (top + hgt > innerHeight - m && r.top - 4 - hgt > m) top = r.top - 4 - hgt;
		let left = Math.min(Math.max(m, r.left), innerWidth - w - m);
		top = Math.min(Math.max(m, top), innerHeight - hgt - m);
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(top)}px`;
	}

	private openPop(anchor: HTMLElement, el: HTMLElement, onClose?: () => void) {
		this.closePop(false);
		this.mount();
		this.box.append(el);
		this.pop = { el, anchor, restore: anchor, onClose };
		anchor.setAttribute('aria-expanded', 'true');
		(anchor.getRootNode() as ShadowRoot).host?.setAttribute('data-open', '');
		this.place();
		el.querySelector<HTMLElement>('button, a[href], input')?.focus();
	}

	closePop(restoreFocus: boolean) {
		if (!this.pop) return;
		const { el, anchor, onClose } = this.pop;
		this.pop = null;
		el.remove();
		anchor.setAttribute('aria-expanded', 'false');
		(anchor.getRootNode() as ShadowRoot).host?.removeAttribute('data-open');
		if (restoreFocus && anchor.isConnected && anchor.getClientRects().length) anchor.focus();
		onClose?.();
	}

	tagMenu(anchor: HTMLElement, x: TagMenuHandlers) {
		const titleId = 'cl-tag-title';
		const close = h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => this.closePop(true) }, icon(X, 16));
		const body = h('div', { class: 'opts', role: 'group', 'aria-labelledby': titleId });
		const pop = h(
			'div',
			{ class: 'pop', role: 'dialog', 'aria-labelledby': titleId },
			h('div', { class: 'head' }, h('h2', { id: titleId }, `Tag this ${x.noun}`), close),
			body,
			h(
				'div',
				{ class: 'foot' },
				h('a', { class: 'scam', href: x.reportHelp, target: '_blank', rel: 'noopener noreferrer' }, 'This is a scam or deepfake')
			)
		);
		const option = (verdict: TagVerdict, t: string, d: string) =>
			h(
				'button',
				{
					type: 'button',
					class: 'opt',
					onclick: async () => {
						const action = await x.tag(verdict);
						if (verdict === 'slop') this.slopDetail(pop, body, action, x);
						else {
							this.closePop(true);
							this.notice(
								verdict === 'not_slop'
									? 'Tagged as not slop. Shown for you, and counted toward the shared list.'
									: 'Tagged as AI-made but fine. Counted toward the shared list.'
							);
						}
					}
				},
				h('span', {}, h('span', { class: 't' }, t), h('span', { class: 'd' }, d))
			);
		body.append(
			option('slop', 'Slop', 'AI-made, and low effort, mass-produced or hollow'),
			option('ai_fine', 'AI-made but fine', 'Made with AI, and worth seeing'),
			option('not_slop', 'Not slop', 'Made by people, or AI only helped')
		);
		this.openPop(anchor, pop);
	}

	private slopDetail(pop: HTMLElement, body: HTMLElement, action: Action | 'none', x: TagMenuHandlers) {
		let type: SlopType | null = null;
		const tests = new Set<Test>();
		const typeButtons = SLOP_TYPES.map((t) =>
			h('button', { type: 'button', class: 'choice', 'aria-pressed': 'false', onclick: (e: Event) => pickType(t, e.currentTarget as HTMLElement) }, SLOP_TYPE_WORD[t])
		);
		const pickType = (t: SlopType, btn: HTMLElement) => {
			type = type === t ? null : t;
			typeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn && type !== null)));
			x.detail(type, [...tests]);
		};
		const testBoxes = TESTS.map((t) => {
			const input = h('input', { type: 'checkbox' });
			input.addEventListener('change', () => {
				if (input.checked) tests.add(t);
				else tests.delete(t);
				x.detail(type, [...tests]);
			});
			return h('label', { class: 'check top' }, input, h('span', {}, h('span', { class: 't' }, TEST_WORD[t]), h('span', { class: 'd' }, TEST_HINT[t])));
		});
		body.replaceChildren(
			h('div', { class: 'done', role: 'status' }, icon(Check, 16), h('p', {}, `Tagged. ${ACTION_PHRASE[action]}, and counted toward the shared list.`)),
			h('div', { class: 'group', role: 'group', 'aria-label': 'Type, optional' }, h('span', { class: 'label' }, 'Type, optional'), h('div', { class: 'choices' }, ...typeButtons)),
			h('div', { class: 'group', role: 'group', 'aria-label': 'Tests, optional' }, h('span', { class: 'label' }, 'Tests, optional'), ...testBoxes)
		);
		const foot = pop.querySelector('.foot')!;
		foot.append(h('button', { type: 'button', class: 'btn primary', onclick: () => this.closePop(true) }, 'Done'));
		typeButtons[0]!.focus();
		this.place();
	}

	why(anchor: HTMLElement, v: CardView, x: WhyHandlers) {
		const d = v.decision;
		const titleId = 'cl-why-title';
		const hidden = d.action === 'hide' || d.action === 'collapse';
		const title = hidden ? 'Why this is hidden' : 'Why this is labeled';
		const lines: string[] = [];
		let listLine = '';
		switch (d.reason) {
			case 'own_tag':
				lines.push(`You tagged it as ${d.verdict === 'slop' ? 'slop' : d.verdict === 'clear' ? 'not slop' : 'AI-made but fine'}.`);
				listLine = 'Your tags apply on this device at once.';
				break;
			case 'my_list':
				lines.push('It is on My list blocks.');
				listLine = 'My list, on this device';
				break;
			case 'topic':
				lines.push(`It matches your rule: ${d.topic}.`);
				listLine = 'Your topic rules, on this device';
				break;
			case 'platform_label':
				lines.push(SIGNAL_TEXT.platform_label);
				listLine = 'The platform’s own label';
				break;
			default: {
				for (const s of d.signals.slice(0, 2)) lines.push(SIGNAL_TEXT[s]);
				const hit = d.hit;
				listLine = hit ? `Core list, updated ${formatDate(dayToDate(hit.updated))}${hit.imported ? ', imported and not yet reviewed' : ''}` : 'Core list';
			}
		}
		const sourceId = v.sourceId;
		const fromList = d.reason === 'item_list' || d.reason === 'source_list' || d.reason === 'platform_label';
		const links =
			fromList && sourceId
				? h(
						'div',
						{ class: 'why-links' },
						h('a', { href: `${SITE}/s/${v.platform}/${idSegment(sourceId)}`, target: '_blank', rel: 'noopener' }, 'Source page'),
						h(
							'a',
							{ href: `${SITE}/appeal/${v.platform}/${idSegment(sourceId)}`, target: '_blank', rel: 'noopener' },
							`Is this your ${SOURCE_NOUN[v.platform]}? Appeal this verdict.`
						)
					)
				: null;
		const actions = h('div', { class: 'why-actions' });
		if (x.show) actions.append(h('button', { type: 'button', class: 'link sm', onclick: () => (this.closePop(false), x.show!()) }, icon(Eye), 'Show'));
		if (x.allow) actions.append(h('button', { type: 'button', class: 'link sm', onclick: () => (this.closePop(false), x.allow!()) }, icon(Check), 'Always allow'));
		if (x.notSlop) actions.append(h('button', { type: 'button', class: 'link sm', onclick: () => (this.closePop(false), x.notSlop!()) }, icon(Scale), 'Not slop'));
		const pop = h(
			'div',
			{ class: 'pop', role: 'dialog', 'aria-labelledby': titleId },
			h(
				'div',
				{ class: 'head' },
				h('h2', { id: titleId }, title),
				h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => this.closePop(true) }, icon(X, 16))
			),
			h('ul', { class: 'why-sig' }, ...lines.map((l) => h('li', {}, d.verdict ? glyph(d.verdict, 12) : icon(Info, 12), h('span', {}, l)))),
			h('p', { class: 'why-src' }, listLine),
			links,
			actions.childElementCount ? actions : null
		);
		this.openPop(anchor, pop);
	}

	/** One notice at a time; a new one replaces the old. Announced politely. */
	notice(text: string, undo?: () => void, ms = 4000) {
		this.mount();
		if (this.toast) {
			clearTimeout(this.toast.timer);
			this.toast.el.remove();
		}
		const el = h(
			'div',
			{ class: `toast${undo ? '' : ' solo'}`, role: 'status', 'aria-live': 'polite' },
			h('span', {}, text),
			undo ? h('button', { type: 'button', class: 'link', onclick: () => (this.dismissNotice(), undo()) }, 'Undo') : null
		);
		this.box.append(el);
		this.toast = { el, timer: window.setTimeout(() => this.dismissNotice(), ms) };
	}

	dismissNotice() {
		if (!this.toast) return;
		clearTimeout(this.toast.timer);
		this.toast.el.remove();
		this.toast = null;
	}

	report(r: ReportDialog) {
		this.closePop(false);
		this.closeDialog();
		this.mount();
		const restore = (document.activeElement as HTMLElement | null) ?? null;
		const titleId = 'cl-report-title';
		const picked = new Set<string>();
		let type: SlopType | null = null;
		const tests = new Set<Test>();
		const reason = h('textarea', { id: 'cl-reason', maxlength: 500, required: true, 'aria-describedby': 'cl-reason-count', placeholder: 'For example: posts 40 AI history videos a day with the same voice.' });
		const count = h('div', { id: 'cl-reason-count', class: 'count caption muted num' }, '0 of 500');
		const error = h('p', { class: 'error', role: 'alert' });
		error.hidden = true;
		const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Send report');
		reason.addEventListener('input', () => (count.textContent = `${reason.value.length} of 500`));
		const exampleBoxes = r.items.slice(0, 12).map((it) => {
			const input = h('input', { type: 'checkbox', value: it.id });
			input.addEventListener('change', () => {
				if (input.checked) picked.add(it.id);
				else picked.delete(it.id);
				for (const box of exampleBoxes) {
					const i = box.querySelector('input')!;
					i.disabled = !i.checked && picked.size >= 3;
				}
			});
			return h('label', { class: 'check' }, input, h('span', { title: it.title || it.id }, it.title || it.id));
		});
		const typeButtons = SLOP_TYPES.map((t) => {
			const b = h('button', { type: 'button', class: 'choice', 'aria-pressed': 'false' }, SLOP_TYPE_WORD[t]);
			b.addEventListener('click', () => {
				type = type === t ? null : t;
				typeButtons.forEach((o, i) => o.setAttribute('aria-pressed', String(SLOP_TYPES[i] === type)));
			});
			return b;
		});
		const testBoxes = TESTS.map((t) => {
			const input = h('input', { type: 'checkbox' });
			input.addEventListener('change', () => (input.checked ? tests.add(t) : tests.delete(t)));
			return h('label', { class: 'check' }, input, h('span', {}, TEST_WORD[t]));
		});
		const form = h(
			'form',
			{ novalidate: true },
			h('div', { class: 'field' }, h('span', { class: 'label' }, 'Source'), h('div', { class: 'source-box' }, h('strong', {}, r.name || r.sourceId), h('span', { class: 'caption muted' }, `${r.platformName} ${SOURCE_NOUN[r.platform]} · ${r.sourceId}`))),
			exampleBoxes.length
				? h('fieldset', { class: 'field' }, h('legend', {}, 'Examples, up to 3'), h('div', { class: 'examples' }, ...exampleBoxes))
				: null,
			h('div', { class: 'field' }, h('label', { class: 'label', for: 'cl-reason' }, 'Reason'), reason, count),
			h('div', { class: 'field', role: 'group', 'aria-label': 'Type, optional' }, h('span', { class: 'label' }, 'Type, optional'), h('div', { class: 'choices' }, ...typeButtons)),
			h('fieldset', { class: 'field' }, h('legend', {}, 'Tests, optional'), ...testBoxes),
			error,
			h('div', { class: 'foot' }, h('button', { type: 'button', class: 'btn', onclick: () => this.closeDialog() }, 'Cancel'), submit)
		);
		const dialog = h(
			'div',
			{ class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
			h(
				'div',
				{ class: 'head' },
				h('h2', { id: titleId }, icon(Flag, 16), 'Report source'),
				h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => this.closeDialog() }, icon(X, 16))
			),
			form
		);
		form.addEventListener('submit', async (e) => {
			e.preventDefault();
			const text = reason.value.trim();
			if (!text) {
				error.hidden = false;
				error.textContent = 'Add a reason, so reviewers know what to look for.';
				reason.focus();
				return;
			}
			submit.disabled = true;
			submit.textContent = 'Sending';
			const res = await r.send({ examples: [...picked], reason: text, slopType: type, tests: [...tests] });
			if (!res.ok) {
				submit.disabled = false;
				submit.textContent = 'Send report';
				error.hidden = false;
				error.textContent = res.error;
				return;
			}
			form.replaceWith(
				h(
					'div',
					{ role: 'status' },
					h('p', { style: 'margin:0' }, 'Reported. It is under review, and you can follow it in My reports.'),
					h(
						'div',
						{ class: 'foot' },
						h('button', { type: 'button', class: 'btn', onclick: () => (this.closeDialog(), r.openReports()) }, 'Open My reports'),
						h('button', { type: 'button', class: 'btn primary', onclick: () => this.closeDialog() }, 'Close')
					)
				)
			);
			(dialog.querySelector('.foot .primary') as HTMLElement | null)?.focus();
		});
		const backdrop = h('div', { class: 'backdrop' }, dialog);
		backdrop.addEventListener('mousedown', (e) => {
			if (e.target === backdrop) this.closeDialog();
		});
		this.box.append(backdrop);
		this.dialog = { el: backdrop, restore };
		(exampleBoxes[0]?.querySelector('input') ?? reason).focus();
	}

	closeDialog() {
		if (!this.dialog) return;
		const { el, restore } = this.dialog;
		this.dialog = null;
		el.remove();
		if (restore?.isConnected) restore.focus();
	}

	get reduced() {
		return reducedMotion();
	}
}

export interface ReportDialog {
	platform: Platform;
	platformName: string;
	sourceId: string;
	name: string;
	items: { id: string; title: string }[];
	send(input: { examples: string[]; reason: string; slopType: SlopType | null; tests: Test[] }): Promise<{ ok: true } | { ok: false; error: string }>;
	openReports(): void;
}
