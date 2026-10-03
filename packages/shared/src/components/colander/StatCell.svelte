<!--
@component StatCell: a label, a number, a foot line, and a sentence in place of the number when
there is nothing to count ("None this week"). `lg` is the website's 48/52 (36/40 on phones);
`md` the extension's 28/32. The number reserves `reserve` characters of width so a refresh never
shifts the layout, and fades in over 120 ms when it changes. Live numbers are not aria-live.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { fmtNum } from '../../utils/format';

	let {
		label,
		value,
		zero,
		foot,
		size = 'md',
		reserve = 0
	}: {
		label: string;
		value: number | string | null;
		/** Shown in place of the number when the value is 0 or null. */
		zero?: string;
		foot?: string;
		size?: 'md' | 'lg';
		reserve?: number;
	} = $props();

	const empty = $derived(zero != null && (value === 0 || value === null));
	const text = $derived(typeof value === 'number' ? fmtNum(value) : (value ?? ''));
	let prev = untrack(() => value);
	let fade = $state(false);
	$effect.pre(() => {
		if (value !== prev) {
			prev = value;
			fade = true;
		}
	});
</script>

<div class="cell cell-{size}">
	<span class="label">{label}</span>
	{#key value}
		{#if empty}
			<span class="zero" class:fade>{zero}</span>
		{:else}
			<span class="value" class:fade style:min-width={reserve ? `${reserve}ch` : undefined}>{text}</span>
		{/if}
	{/key}
	{#if foot}<span class="foot">{foot}</span>{/if}
</div>

<style>
	.cell {
		display: grid;
		align-content: start;
		gap: 4px;
		min-width: 0;
	}
	.label {
		color: var(--cl-text-muted);
	}
	.cell-md .label {
		font: var(--cl-caption);
	}
	.cell-lg .label {
		font: var(--cl-body);
	}
	.value {
		font-variant-numeric: tabular-nums;
	}
	.cell-md .value {
		font: var(--cl-stat);
	}
	.cell-lg .value {
		font: var(--cl-stat-lg);
	}
	.cell-md .zero {
		font: var(--cl-body-strong);
		line-height: 32px;
	}
	.cell-lg .zero {
		font: var(--cl-body-lg);
		font-weight: 600;
		align-self: end;
	}
	.foot {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.fade {
		animation: cl-stat-fade var(--cl-fast) var(--cl-ease);
	}
	@keyframes cl-stat-fade {
		from {
			opacity: 0;
		}
	}
</style>
