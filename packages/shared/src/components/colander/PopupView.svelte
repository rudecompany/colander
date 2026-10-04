<!--
@component PopupView: the toolbar popup, as pure presentation. The extension's real popup and
the website hero render this one component from a PopupState, so they cannot drift.

360 wide, never over 600 tall, no scroll in the default state: header 48, status card 48,
strictness card 80, stats card 104, On this page card (a 36 header and up to 3 rows of 44), a
64 slot, and the list version. Cards sit 8 apart with 12 px side padding, on paper.
"Show all" folds the stats card to one 40 line and scrolls the list inside the card.
Flat: the website adds the shadow where it docks the popup. Only "Show all" caps the height at
600 (the extension's window); otherwise the popup grows with its content, so a narrow website
column never clips it. Hidden items leave the page without a trace, so this list is where each one
stays reachable: Show, and the menu's Always allow, Not slop and Why. A row title is always one
line, clipped by its own box: a long one ends in an ellipsis, and a numbered one keeps its number
("Ancient Rome facts… Part 46"), so the parts of a series stay apart. The chip and the actions keep
their size and alignment.
-->
<script lang="ts" module>
	import type { Action, Strictness, Verdict } from '../../verdicts';
	import type { DateInput } from '../../utils/format';

	export interface PopupRow {
		id: string | number;
		/** Null for the person's own rules, which show a "Your rule" badge. */
		verdict: Verdict | null;
		title: string;
		action: Action;
		/** Shown again with Show. */
		shown?: boolean;
	}

	export interface PopupState {
		status: 'loading' | 'active' | 'paused' | 'unsupported';
		/** "youtube.com" */
		domain?: string;
		pausedScope?: 'site' | 'tab';
		plus?: boolean;
		strictness: Strictness;
		/** A per-platform override line, such as "YouTube uses No AI, set in Options." */
		strictnessNote?: string;
		hiddenToday: number;
		/** Hidden on this page. */
		onPage?: number;
		/** The item noun, for the summary sentence. */
		noun?: string;
		rows?: PopupRow[];
		/** The one 64 px slot: a sync failure, a report update, or the weekly card. Default: the footer. */
		slot?: { kind: 'sync' } | { kind: 'report' } | { kind: 'weekly'; hidden: number } | null;
		list?: { sequence: number | null; updatedAt?: DateInput | null };
		/** False when the page has no content script to pause. */
		canPauseTab?: boolean;
	}

	export interface PopupActions {
		strictness?: (level: Strictness) => void;
		pause?: (scope: 'site' | 'tab') => void;
		resume?: () => void;
		options?: () => void;
		show?: (row: PopupRow) => void;
		allow?: (row: PopupRow) => void;
		notSlop?: (row: PopupRow) => void;
		why?: (row: PopupRow) => void;
		sourcePage?: (row: PopupRow) => void;
		sync?: () => void;
		reports?: () => void;
		dismissWeekly?: () => void;
		plus?: () => void;
		support?: () => void;
		log?: () => void;
	}
</script>

<script lang="ts">
	import '../ui/badge/badge.css';
	import '../ui/button/button.css';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Eye from '@lucide/svelte/icons/eye';
	import Heart from '@lucide/svelte/icons/heart';
	import Info from '@lucide/svelte/icons/info';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import Settings from '@lucide/svelte/icons/settings';
	import Tag from '@lucide/svelte/icons/tag';
	import X from '@lucide/svelte/icons/x';
	import Button from '../ui/button/button.svelte';
	import ColanderMark from './ColanderMark.svelte';
	import LiveBadge from './LiveBadge.svelte';
	import Menu, { type MenuItem } from './Menu.svelte';
	import StatCell from './StatCell.svelte';
	import StrictnessControl from './StrictnessControl.svelte';
	import VerdictChip from './VerdictChip.svelte';
	import VerdictTally from './VerdictTally.svelte';
	import { SUPPORTED_SITES, WEEKLY_HIDDEN } from '../../copy';
	import { fmtNum } from '../../utils/format';
	import { VERDICT_WORD } from '../../verdicts';

	let { state: s, actions: a = {} }: { state: PopupState; actions?: PopupActions } = $props();

	function isHidden(r: PopupRow) {
		return r.action === 'hide' && !r.shown;
	}

	const uid = $props.id();
	let all = $state(false);
	// Hidden items first: they leave no trace on the page, so this list is where they are reached.
	const rows = $derived([...(s.rows ?? [])].sort((x, y) => Number(isHidden(y)) - Number(isHidden(x))));
	const onPage = $derived(s.onPage ?? rows.filter((r) => r.action === 'hide').length);
	// The tally breaks down "Hidden on this page" by verdict, so it fits one line.
	const tally = $derived.by(() => {
		const t: Partial<Record<Verdict, number>> = {};
		for (const r of rows) if (r.verdict && r.action === 'hide') t[r.verdict] = (t[r.verdict] ?? 0) + 1;
		return t;
	});
	const summary = $derived.by(() => {
		const noun = s.noun ?? 'item';
		const parts: string[] = [];
		const verbs = [['hide', 'hid'], ['label', 'labeled']] as const;
		for (const [action, verb] of verbs) {
			const by = new Map<Verdict, number>();
			for (const r of rows) if (r.action === action && r.verdict) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
			for (const [v, n] of by) parts.push(`${verb} ${n} ${VERDICT_WORD[v]}${action === 'hide' ? ` ${n === 1 ? noun : `${noun}s`}` : ''}`);
		}
		if (!parts.length) return 'Nothing hidden on this page.';
		const last = parts.pop()!;
		return `On this page Colander ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
	});
	const visible = $derived(all ? rows : rows.slice(0, 3));
	const paused = $derived(s.status === 'paused');
	const where = $derived(s.pausedScope === 'tab' ? 'tab' : 'site');
	// While paused the level still saves, but nothing on the page follows it until Resume.
	const note = $derived(paused ? 'This level applies again when you resume.' : s.strictnessNote);

	/** A numbered title keeps its last words (up to 9 characters) when cut: "Ancient Rome facts… Part 46". */
	function ends(t: string): [string, string] {
		if (!/\d$/.test(t)) return [t, ''];
		let cut = -1;
		for (let i = t.lastIndexOf(' '); i > 0 && t.length - i <= 9; i = t.lastIndexOf(' ', i - 1)) cut = i;
		return cut < 0 ? [t, ''] : [t.slice(0, cut), t.slice(cut)];
	}
	const hidden = isHidden;

	// The same icon for an action everywhere: the Why popover, the row menu and in-page.
	function rowItems(r: PopupRow): MenuItem[] {
		return [
			...(hidden(r) && a.show ? [{ label: 'Show', icon: Eye, onSelect: () => a.show!(r) }] : []),
			...(a.allow ? [{ label: 'Always allow this source', icon: Check, onSelect: () => a.allow!(r) }] : []),
			...(r.verdict && a.notSlop ? [{ label: 'Not slop', icon: Tag, onSelect: () => a.notSlop!(r) }] : []),
			...(a.why ? [{ label: 'Why', icon: Info, onSelect: () => a.why!(r) }] : []),
			...(a.sourcePage ? [{ label: 'Source page', icon: ArrowRight, onSelect: () => a.sourcePage!(r) }] : [])
		];
	}

	// Pause and Resume replace each other, so focus moves to the new control instead of the page.
	let root = $state<HTMLElement>();
	let refocus = false;
	const pauseItems = $derived<MenuItem[]>([
		{ label: 'Pause on this site', onSelect: () => ((refocus = true), a.pause?.('site')) },
		{ label: 'Pause on this tab', onSelect: () => ((refocus = true), a.pause?.('tab')), disabled: s.canPauseTab === false }
	]);
	$effect(() => {
		void s.status;
		if (!refocus || !root) return;
		const active = root.ownerDocument.activeElement;
		const btn = root.querySelector<HTMLElement>('.status button');
		if (!btn || (active && active !== root.ownerDocument.body && !root.contains(active))) return;
		refocus = false;
		btn.focus();
	});
</script>

<div class="popup" class:all bind:this={root}>
	<header class="head">
		<span class="brand"><ColanderMark size={20} /><span class="name">Colander</span></span>
		{#if s.plus}<span class="uin-badge uin-badge-md">Plus</span>{/if}
		<Button variant="quiet" class="opts" onclick={() => a.options?.()}><Settings size={16} aria-hidden="true" />Options</Button>
	</header>

	<div class="cards">
		<section class="card status" aria-label="Status">
			{#if s.status === 'loading'}
				<span class="state"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>Loading</span>
			{:else if s.status === 'unsupported'}
				<p class="state wrap">{SUPPORTED_SITES}</p>
			{:else if s.status === 'paused'}
				<span class="state" role="status"><span class="ring" aria-hidden="true"></span>{s.pausedScope === 'tab' ? 'Paused on this tab.' : 'Paused on this site.'}</span>
				<Button variant="primary" onclick={() => ((refocus = true), a.resume?.())}>Resume</Button>
			{:else}
				<span class="state"><span class="dot" aria-hidden="true"></span><span class="ell">Active on {s.domain}</span></span>
				<Menu items={pauseItems} label="Pause">
					{#snippet trigger(props)}
						<button {...props} type="button" class="uin-btn uin-btn-outline uin-btn-md">Pause<ChevronDown size={16} aria-hidden="true" /></button>
					{/snippet}
				</Menu>
			{/if}
		</section>

		<section class="card strict" aria-label="Strictness">
			<!-- A per-platform note takes the hint's line, so the card stays 80 tall. -->
			<StrictnessControl value={s.strictness} onChange={(l) => a.strictness?.(l)} label="Strictness" hint={!note} />
			{#if note}<p class="note">{note}</p>{/if}
		</section>

		{#if all}
			<section class="card folded" aria-label="Counts">
				<span>Hidden for you today <b>{fmtNum(s.hiddenToday)}</b></span>
				<span aria-hidden="true">·</span>
				<span>Hidden on this page <b>{fmtNum(onPage)}</b></span>
			</section>
		{:else}
			<section class="card stats" aria-label="Counts" aria-describedby={s.status === 'unsupported' ? undefined : `${uid}-sum`}>
				<div class="cells">
					<StatCell label="Hidden for you today" value={s.hiddenToday} reserve={3} />
					{#if s.status !== 'unsupported'}<StatCell label="Hidden on this page" value={onPage} reserve={3} />{/if}
				</div>
				{#if s.status !== 'unsupported'}
					<VerdictTally counts={tally} hideZero />
					<p class="cl-sr-only" id="{uid}-sum">{summary}</p>
				{/if}
			</section>
		{/if}

		{#if s.status !== 'unsupported'}
			<section class="card page" aria-labelledby="{uid}-page">
				<div class="page-head">
					<h2 id="{uid}-page">On this page</h2>
					{#if rows.length > 3}
						<Button variant="quiet" onclick={() => (all = !all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</Button>
					{/if}
				</div>
				{#if s.status === 'loading'}
					<p class="empty"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>Loading</p>
				{:else if !rows.length}
					<p class="empty"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>{paused ? `Colander is paused on this ${where}, so nothing is hidden.` : 'Nothing hidden on this page.'}</p>
				{:else}
					<ul class="rows">
						{#each visible as r (r.id)}
							{@const [head, tail] = ends(r.title)}
							<li class="row">
								<Menu items={rowItems(r)} label={r.title} align="start">
									{#snippet trigger(props)}
										<button {...props} type="button" class="row-btn">
											{#if r.verdict}<VerdictChip verdict={r.verdict} size="sm" />{:else}<span class="uin-badge uin-badge-md">Your rule</span>{/if}
											<span class="title" title={r.title}><span class="t-start">{head}</span>{#if tail}<span class="t-end">{tail}</span>{/if}</span>
											<!-- The row opens a menu: say so, so it never reads as a static line. -->
											<ChevronDown size={16} aria-hidden="true" class="more" />
										</button>
									{/snippet}
								</Menu>
								{#if hidden(r) && a.show}
									<Button variant="quiet" onclick={() => a.show!(r)}><Eye size={16} aria-hidden="true" />Show</Button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<div class="slot">
			{#if s.slot?.kind === 'sync'}
				<div class="card notice" role="status">
					<p>The list could not update.</p>
					<Button variant="quiet" onclick={() => a.sync?.()}><RefreshCw size={16} aria-hidden="true" />Sync now</Button>
				</div>
			{:else if s.slot?.kind === 'report'}
				<div class="card notice" role="status">
					<p>A report you sent has a verdict.</p>
					<Button variant="quiet" onclick={() => a.reports?.()}>My reports</Button>
				</div>
			{:else if s.slot?.kind === 'weekly'}
				<div class="card weekly">
					<p>{WEEKLY_HIDDEN(s.slot.hidden, fmtNum(s.slot.hidden))}</p>
					<Button variant="quiet" icon size="sm" aria-label="Dismiss" onclick={() => a.dismissWeekly?.()}><X size={16} aria-hidden="true" /></Button>
					{#if s.plus}
						<Button variant="quiet" size="sm" onclick={() => a.support?.()}><Heart size={16} aria-hidden="true" />Support our work</Button>
					{:else}
						<Button variant="quiet" size="sm" onclick={() => a.plus?.()}>Get Plus</Button>
					{/if}
				</div>
			{:else}
				<div class="foot">
					<Button variant="quiet" onclick={() => a.support?.()}><Heart size={16} aria-hidden="true" />Support our work</Button>
					<Button variant="quiet" onclick={() => a.log?.()}><ScrollText size={16} aria-hidden="true" />Decision log</Button>
				</div>
			{/if}
		</div>

		{#if s.list?.sequence}
			<p class="list"><LiveBadge sequence={s.list.sequence} updatedAt={s.list.updatedAt} /></p>
		{/if}
	</div>
</div>

<style>
	.popup {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 360px;
		padding-bottom: 12px;
		background: var(--cl-paper);
		color: var(--cl-text);
		font: var(--cl-body);
	}
	.head {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		height: 48px;
		padding: 0 4px 0 12px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.name {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.head :global(.opts) {
		margin-left: auto;
	}
	.cards {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
		padding: 0 12px;
	}
	.card {
		flex: none;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	p,
	h2 {
		margin: 0;
	}
	.status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 48px;
		padding: 8px 8px 8px 12px;
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font: var(--cl-body-strong);
	}
	.state.wrap {
		display: block;
	}
	.ell {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dot,
	.ring {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--cl-text);
	}
	.ring {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--cl-text);
	}
	.three {
		display: inline-flex;
		gap: 4px;
	}
	.three i {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
	.strict {
		padding: 12px 8px;
	}
	.strict :global(.uin-seg) {
		width: 100%;
	}
	.strict :global(.sc) {
		justify-items: stretch;
	}
	.note {
		margin-top: 8px;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.stats {
		display: grid;
		gap: 8px;
		padding: 12px;
	}
	.cells {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.folded {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		padding: 0 12px;
		color: var(--cl-text-muted);
	}
	.folded b {
		color: var(--cl-text);
		font-variant-numeric: tabular-nums;
	}
	.page {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: 0 4px 4px;
	}
	.all {
		max-height: 600px;
	}
	.all .page {
		flex: 1;
	}
	.page-head {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		height: 36px;
		padding-left: 8px;
	}
	h2 {
		font: var(--cl-body-strong);
	}
	/* Every row shares one trailing column: Show where the item is hidden, empty space elsewhere, so
	   the menu chevrons line up down the list. */
	.rows {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		column-gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* The scrolled list fades at its bottom edge, so a cut row reads as more to scroll. */
	.all .rows {
		overflow-y: auto;
		padding-bottom: 16px;
		mask-image: linear-gradient(to bottom, black calc(100% - 16px), transparent);
	}
	.row {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		height: 44px;
	}
	.row-btn {
		display: flex;
		grid-column: 1;
		align-items: center;
		gap: 8px;
		min-width: 0;
		height: 40px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--cl-r-chip);
		background: transparent;
		color: var(--cl-text);
		font: var(--cl-body);
		text-align: left;
		cursor: pointer;
	}
	.row-btn:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	/* The chip, the chevron and Show keep their size; only the title gives way, on one line. */
	.row-btn > :global(*),
	.row > :global(.uin-btn) {
		flex: none;
	}
	.row-btn :global(.more) {
		color: var(--cl-text-muted);
	}
	/* One line whatever happens: the title clips itself, and only its start gives way. */
	.row-btn > .title {
		display: flex;
		flex: 1 1 0;
		align-items: baseline;
		min-width: 0;
		height: 20px;
		overflow: hidden;
		line-height: 20px;
		white-space: nowrap;
	}
	.t-start {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.t-end {
		flex: none;
		white-space: pre;
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 8px 12px;
		color: var(--cl-text-muted);
	}
	.slot {
		display: flex;
		flex: none;
		flex-direction: column;
		justify-content: center;
		min-height: 64px;
	}
	.notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 4px 8px 12px;
	}
	.weekly {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 0 4px;
		padding: 4px 4px 4px 12px;
	}
	.weekly :global(.uin-btn-sm) {
		justify-self: start;
		margin-left: -10px;
	}
	.foot {
		display: flex;
		justify-content: center;
		gap: 8px;
	}
	.list {
		display: flex;
		justify-content: center;
	}
</style>
