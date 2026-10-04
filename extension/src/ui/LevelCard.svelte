<!--
@component One strictness level as a radio card: the recreated rows at that level (the shared
FeedDemo, drawn by the in-page builders), what happened to them, the level and its line.
Selected: brand tint, a 2 px brand outline and a filled radio dot, so it differs in shape too.
Used by Options, Strictness, and by the store art.
-->
<script lang="ts">
	import { FeedDemo } from '@colander/shared';
	import { DEMO_FEED, DEMO_MINI_ITEMS } from '@colander/shared/copy';
	import { demoCounts } from '@colander/shared/inpage';
	import { radioGroupKeydown } from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import { STRICTNESS_HINT, STRICTNESS_WORD, type Strictness } from '@colander/shared/verdicts';

	let { level, on, onpick }: { level: Strictness; on: boolean; onpick?: (level: Strictness) => void } = $props();
	const uid = $props.id();
	const items = DEMO_MINI_ITEMS.map((id) => DEMO_FEED.find((i) => i.id === id)!);

	function keydown(e: KeyboardEvent) {
		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			onpick?.(level);
		} else radioGroupKeydown(e);
	}
</script>

<div
	class="level"
	class:on
	role="radio"
	aria-checked={on}
	aria-labelledby="{uid}-name"
	aria-describedby="{uid}-hint"
	tabindex={on ? 0 : -1}
	onclick={() => onpick?.(level)}
	onkeydown={keydown}
>
	<div class="demo">
		<FeedDemo variant="mini" {level} />
		<span class="cl-figure count" aria-hidden="true">{demoCounts(level, items)}</span>
	</div>
	<span class="head">
		<span class="radio" aria-hidden="true"></span>
		<span class="name" id="{uid}-name">{STRICTNESS_WORD[level]}</span>
		{#if level === 'standard'}<span class="uin-badge uin-badge-md">Default</span>{/if}
	</span>
	<span class="hint" id="{uid}-hint">{STRICTNESS_HINT[level]}</span>
</div>

<style>
	.level {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		cursor: pointer;
		transition: border-color var(--cl-fast) var(--cl-ease);
	}
	.level:hover:not(.on) {
		border-color: var(--cl-border-strong);
	}
	.level:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	.level.on {
		border-color: var(--cl-brand);
		background: var(--cl-brand-tint);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	/* The rows take the card's spare height, so level names line up across a row of cards. */
	.demo {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 4px;
		pointer-events: none;
	}
	.count {
		margin-top: auto;
		color: var(--cl-text-muted);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.radio {
		flex: none;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px var(--cl-border-strong);
	}
	.on .radio {
		box-shadow:
			inset 0 0 0 1.5px var(--cl-brand),
			inset 0 0 0 4px var(--cl-brand-tint),
			inset 0 0 0 8px var(--cl-brand);
	}
	.name {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.hint {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
</style>
