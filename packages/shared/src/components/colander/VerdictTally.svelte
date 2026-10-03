<!--
@component VerdictTally: verdict chips with their counts. `inline` sets them in a row (popup
stats, the /log summary); `rows` stacks them with a 50-dot DotMeter each, scaled so each dot is
`perDot` (the caller states it, as in "Each dot is 4 sources"). `hideZero` drops verdicts at 0.
-->
<script lang="ts">
	import DotMeter from './DotMeter.svelte';
	import VerdictChip from './VerdictChip.svelte';
	import { fmtNum } from '../../utils/format';
	import { VERDICTS, type Verdict } from '../../verdicts';

	let {
		counts,
		layout = 'inline',
		size = 'sm',
		hideZero = false,
		perDot = 1
	}: {
		counts: Partial<Record<Verdict, number>>;
		layout?: 'inline' | 'rows';
		size?: 'sm' | 'md';
		hideZero?: boolean;
		perDot?: number;
	} = $props();

	const list = $derived(VERDICTS.filter((v) => !hideZero || (counts[v] ?? 0) > 0));
</script>

<ul class="tally tally-{layout}">
	{#each list as v (v)}
		<li>
			<VerdictChip verdict={v} {size} />
			{#if layout === 'rows'}<DotMeter value={counts[v] ?? 0} max={50 * perDot} />{/if}
			<span class="n">{fmtNum(counts[v] ?? 0)}</span>
		</li>
	{/each}
</ul>

<style>
	.tally {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.tally-inline {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
	}
	.tally-inline li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.tally-rows {
		display: grid;
		grid-template-columns: max-content minmax(0, auto) max-content;
		gap: 8px 16px;
		align-items: center;
	}
	.tally-rows li {
		display: contents;
	}
	.n {
		font: var(--cl-body-strong);
		font-variant-numeric: tabular-nums;
	}
</style>
