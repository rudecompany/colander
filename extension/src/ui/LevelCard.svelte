<!--
@component One strictness level as a radio card: the radio, the level and its line first, then the
recreated rows at that level (the shared FeedDemo, drawn by the in-page builders) and what
happened to them. Leading with the name keeps radios aligned; spare height falls at the bottom.
Selected: brand tint, a 2 px brand outline and a filled radio dot, so it differs in shape too.
Used by Options, Strictness, and by the store art.
-->
<script lang="ts">
	import { FeedDemo } from '@colander/shared';
	import { DEMO_FEED, DEMO_MINI_ITEMS } from '@colander/shared/copy';
	import { demoCounts } from '@colander/shared/inpage';
	import { radioGroupKeydown } from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import { STRICTNESS_HINT, STRICTNESS_WORD, type Strictness } from '@colander/shared/verdicts';

	// `hint` false drops the level's line, for the store art's larger 2 by 2 picture.
	let { level, on, onpick, hint = true }: { level: Strictness; on: boolean; onpick?: (level: Strictness) => void; hint?: boolean } = $props();
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
	aria-describedby={hint ? `${uid}-hint` : undefined}
	tabindex={on ? 0 : -1}
	onclick={() => onpick?.(level)}
	onkeydown={keydown}
>
	<span class="head">
		<span class="radio" aria-hidden="true"></span>
		<span class="name" id="{uid}-name">{STRICTNESS_WORD[level]}</span>
		{#if level === 'standard'}<span class="uin-badge uin-badge-md">Default</span>{/if}
	</span>
	{#if hint}<span class="hint" id="{uid}-hint">{STRICTNESS_HINT[level]}</span>{/if}
	<div class="demo">
		<FeedDemo variant="mini" {level} />
		<span class="cl-figure count" aria-hidden="true">{demoCounts(level, items)}</span>
	</div>
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
	.demo {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 4px;
		padding-top: 12px;
		border-top: 1px solid var(--cl-border);
		pointer-events: none;
	}
	.count {
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
		min-height: 32px;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
</style>
