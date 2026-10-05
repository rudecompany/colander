<!--
@component PopupRows: the popup's On this page rows, 44 tall. Each row is a chip (or a "Your rule"
badge), the title on one line, and a chevron: the row is a button that opens its menu (Show,
Always allow this source, Not slop, Why, Source page). A hidden item also gets Show at the end,
so every item that left the page stays one click from coming back. PopupView lists these, and the
website draws the same rows in its pictures of the popup, where they sit inside an inert picture.

A title is always one line, clipped by its own box: a long one ends in an ellipsis, and a numbered
one keeps its number ("Ancient Rome facts… Part 46"), so the parts of a series stay apart. The
chip, the chevron and Show keep their size. `data-row` carries the row id, so a caller can hand
focus back to a row after its list changes.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Eye from '@lucide/svelte/icons/eye';
	import Info from '@lucide/svelte/icons/info';
	import Tag from '@lucide/svelte/icons/tag';
	import Button from '../ui/button/button.svelte';
	import Menu, { type MenuItem } from './Menu.svelte';
	import VerdictChip from './VerdictChip.svelte';
	import type { PopupActions, PopupRow } from './PopupView.svelte';

	let { rows, actions: a = {} }: { rows: PopupRow[]; actions?: PopupActions } = $props();

	const hidden = (r: PopupRow) => r.action === 'hide' && !r.shown;

	/** A numbered title keeps its last words (up to 9 characters) when cut: "Ancient Rome facts… Part 46". */
	function ends(t: string): [string, string] {
		if (!/\d$/.test(t)) return [t, ''];
		let cut = -1;
		for (let i = t.lastIndexOf(' '); i > 0 && t.length - i <= 9; i = t.lastIndexOf(' ', i - 1)) cut = i;
		return cut < 0 ? [t, ''] : [t.slice(0, cut), t.slice(cut)];
	}

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
</script>

<ul class="rows">
	{#each rows as r (r.id)}
		{@const [head, tail] = ends(r.title)}
		<li class="row" data-row={r.id}>
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
			{#if hidden(r)}
				<Button variant="quiet" class="row-show" onclick={() => a.show?.(r)}><Eye size={16} aria-hidden="true" />Show</Button>
			{/if}
		</li>
	{/each}
</ul>

<style>
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
</style>
