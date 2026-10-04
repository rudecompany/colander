<!--
@component EvidenceCard: why an item or source has its verdict. Renders the shared Evidence model
from inpage/evidence.ts with the same markup and CSS as the in-page evidence popover.

- `popover`: floating, with the one shadow; up to 3 rows (bento tile 03, store art).
- `inline`: the same content, flat and full width (/log rows, the phone hero, My reports).
- `full`: every layer with a 2 px rule, all of its signals, and the layers with no data folded
  into one line (/s pages, the side panel).
Show, Always allow and Not slop appear when their handlers are given.
-->
<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import Eye from '@lucide/svelte/icons/eye';
	import Tag from '@lucide/svelte/icons/tag';
	import VerdictChip from './VerdictChip.svelte';
	import { INPAGE_COPY } from '../../copy';
	import { emptyLayersLine, keepTogether, popoverRows, type Evidence } from '../../inpage/evidence';
	import { LAYER_WORD, type LayerKey } from '../../layers';

	let {
		evidence: ev,
		variant = 'popover',
		show,
		allow,
		notSlop,
		headingLevel = 2
	}: {
		evidence: Evidence;
		variant?: 'popover' | 'inline' | 'full';
		show?: () => void;
		allow?: () => void;
		notSlop?: () => void;
		headingLevel?: 2 | 3 | 4;
	} = $props();

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const s = INPAGE_COPY;
	const actions = $derived(
		[
			show && { label: s.show, icon: Eye, onclick: show },
			allow && { label: s.alwaysAllow, icon: Check, onclick: allow },
			notSlop && { label: s.notSlop, icon: Tag, onclick: notSlop }
		].filter((a) => !!a)
	);
	const layerWord = (key: string, label: string) => (key in LAYER_WORD ? LAYER_WORD[key as LayerKey] : label);
</script>

<svelte:element
	this={variant === 'popover' ? 'div' : 'section'}
	class="cl-pop ev-{variant}"
	class:cl-flat={variant !== 'popover'}
	role={variant === 'popover' ? 'dialog' : undefined}
	aria-labelledby={titleId}
>
	<div class="cl-ev-head">
		<VerdictChip verdict={ev.verdict} />
		<svelte:element this={`h${headingLevel}`} class="cl-ev-title" id={titleId}>{ev.title}</svelte:element>
	</div>
	{#if variant === 'full'}
		{#each ev.rows.filter((r) => r.agreed) as r (r.key)}
			<div class="layer">
				<p class="layer-word">{layerWord(r.key, r.label)}</p>
				<ul>
					{#each r.texts as t (t)}<li>{t}</li>{/each}
				</ul>
			</div>
		{/each}
		{@const folded = emptyLayersLine(ev)}
		{#if folded}<p class="cl-ev-list">{folded}</p>{/if}
	{:else}
		<ul class="cl-ev-rows">
			{#each popoverRows(ev) as r (r.key)}
				<li class="cl-ev-row" data-agreed={String(r.agreed)}>
					<span><b>{r.label}:</b>{' '}{#each keepTogether(r.texts[0] ?? '') as part, i (i)}{#if i % 2}<span class="cl-nw">{part}</span>{:else}{part}{/if}{/each}</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if ev.list}<p class="cl-ev-list">{ev.list}</p>{/if}
	{#if actions.length}
		<hr class="cl-ev-rule" />
		<div class="cl-ev-actions">
			{#each actions as a (a.label)}
				<button type="button" class="cl-b cl-b-q cl-b-sm" onclick={a.onclick}><a.icon size={16} aria-hidden="true" />{a.label}</button>
			{/each}
		</div>
	{/if}
	{#if ev.sourceUrl || ev.appealUrl}
		<p class="cl-ev-links">
			<!-- The demo's invented sources have no pages: there the links are plain words. -->
			{#if ev.inertLinks}
				{#if ev.sourceUrl}<span class="cl-link-inert">{s.sourcePage}</span>{/if}
				{#if ev.appealUrl}<span class="cl-link-inert">{ev.appealText}</span>{/if}
			{:else}
				{#if ev.sourceUrl}<a class="cl-link" href={ev.sourceUrl}>{s.sourcePage}<ArrowRight size={16} aria-hidden="true" /></a>{/if}
				{#if ev.appealUrl}<a class="cl-link" href={ev.appealUrl}>{ev.appealText}</a>{/if}
			{/if}
		</p>
	{/if}
</svelte:element>

<style>
	.ev-full {
		display: grid;
		gap: 16px;
	}
	.ev-full .cl-ev-list,
	.ev-full .cl-ev-rule,
	.ev-full .cl-ev-links {
		margin: 0;
	}
	.layer {
		padding-top: 8px;
		border-top: 2px solid var(--cl-text);
	}
	.layer-word {
		margin: 0 0 4px;
		font: var(--cl-body-strong);
	}
	.layer ul {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
