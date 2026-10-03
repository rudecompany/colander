<!--
@component DotMeter: one row of `dots` data dots (50 by default), `value` of `max` filled.
Filled dots are the text color, empty ones --cl-dot-strong. Decorative unless `label` is given:
the count always sits beside it in text.
-->
<script lang="ts">
	import DotUnitChart from './DotUnitChart.svelte';

	let { value, max, dots = 50, label }: { value: number; max: number; dots?: number; label?: string } = $props();
	const filled = $derived(max > 0 ? Math.min(dots, Math.round((value / max) * dots)) : 0);
</script>

{#if label}
	<DotUnitChart cols={dots} rows={1} {filled} pitch={6} dot={4} {label} />
{:else}
	<span class="meter" aria-hidden="true"><DotUnitChart cols={dots} rows={1} {filled} pitch={6} dot={4} label="" /></span>
{/if}

<style>
	.meter {
		display: block;
	}
</style>
