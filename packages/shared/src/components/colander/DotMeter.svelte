<!--
@component DotMeter: `dots` data dots (50 by default), `value` of `max` filled, row by row.
Filled dots are the text color, empty ones --cl-dot-strong. One row when there is room for it;
narrower than 300 px it wraps to 2 rows of 25, so a dot never renders below 4 px and each dot
keeps its worth. Decorative unless `label` is given: the count always sits beside it in text.
-->
<script lang="ts">
	import DotUnitChart from './DotUnitChart.svelte';

	let { value, max, dots = 50, label }: { value: number; max: number; dots?: number; label?: string } = $props();
	const filled = $derived(max > 0 ? Math.min(dots, Math.round((value / max) * dots)) : 0);
	let width = $state(0);
	const rows = $derived(width > 0 && width < 300 && dots % 2 === 0 ? 2 : 1);
</script>

<span class="meter" bind:clientWidth={width} aria-hidden={label ? undefined : 'true'}>
	<DotUnitChart cols={dots / rows} {rows} {filled} pitch={6} dot={4} label={label ?? ''} />
</span>

<style>
	.meter {
		display: block;
	}
</style>
