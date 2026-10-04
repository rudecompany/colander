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
stays reachable: Show, and the menu's Always allow, Not slop and Why (PopupRows, which the website
also draws in its pictures of the popup). A hidden item always has Show.

The counts follow what is hidden now: an item shown again with Show leaves "Hidden on this page",
the tally and the summary, as it leaves the toolbar badge. After Show, Always allow or Not slop,
focus goes back to the same row, or to the list's heading when the row left the list.
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
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Heart from '@lucide/svelte/icons/heart';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import Button from '../ui/button/button.svelte';
	import ColanderMark from './ColanderMark.svelte';
	import LiveBadge from './LiveBadge.svelte';
	import Menu, { type MenuItem } from './Menu.svelte';
	import PopupRows from './PopupRows.svelte';
	import StatCell from './StatCell.svelte';
	import StrictnessControl from './StrictnessControl.svelte';
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
	/** What the item gets now: shown again with Show, a hidden item is labeled on the page. */
	const now = (r: PopupRow): Action => (r.action === 'hide' && r.shown ? 'label' : r.action);
	const onPage = $derived(s.onPage ?? rows.filter(isHidden).length);
	// The tally breaks down "Hidden on this page" by verdict, so it fits one line.
	const tally = $derived.by(() => {
		const t: Partial<Record<Verdict, number>> = {};
		for (const r of rows) if (r.verdict && isHidden(r)) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
		return t;
	});
	const summary = $derived.by(() => {
		const noun = s.noun ?? 'item';
		const parts: string[] = [];
		const verbs = [['hide', 'hid'], ['label', 'labeled']] as const;
		for (const [action, verb] of verbs) {
			const by = new Map<Verdict, number>();
			for (const r of rows) if (now(r) === action && r.verdict) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
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

	// Show, Always allow and Not slop change the list under the focused control. Once it re-renders,
	// focus goes back to the same row, or to the list's heading when the row has left the list.
	let refocusRow: PopupRow['id'] | null = null;
	const acting = (fn?: (r: PopupRow) => void) => fn && ((r: PopupRow) => ((refocusRow = r.id), fn(r)));
	const rowActions = $derived<PopupActions>({ ...a, show: acting(a.show), allow: acting(a.allow), notSlop: acting(a.notSlop) });
	$effect(() => {
		void visible;
		if (refocusRow == null || !root) return;
		const id = String(refocusRow);
		refocusRow = null;
		const doc = root.ownerDocument;
		const active = doc.activeElement;
		if (active && active !== doc.body && active.isConnected) return;
		const row = [...root.querySelectorAll<HTMLElement>('[data-row]')].find((el) => el.dataset.row === id);
		(row?.querySelector<HTMLElement>('.row-btn') ?? root.querySelector<HTMLElement>('.page-head h2'))?.focus();
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
					<h2 id="{uid}-page" tabindex="-1">On this page</h2>
					{#if rows.length > 3}
						<Button variant="quiet" onclick={() => (all = !all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</Button>
					{/if}
				</div>
				{#if s.status === 'loading'}
					<p class="empty"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>Loading</p>
				{:else if !rows.length}
					<p class="empty"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>{paused ? `Colander is paused on this ${where}, so nothing is hidden.` : 'Nothing hidden on this page.'}</p>
				{:else}
					<PopupRows rows={visible} actions={rowActions} />
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
	/* The scrolled list fades at its bottom edge, so a cut row reads as more to scroll. */
	.all .page :global(.rows) {
		overflow-y: auto;
		padding-bottom: 16px;
		mask-image: linear-gradient(to bottom, black calc(100% - 16px), transparent);
	}
	h2:focus {
		outline: none;
		box-shadow: none;
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
