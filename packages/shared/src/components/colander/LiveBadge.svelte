<!--
@component LiveBadge: "Core list v.412, updated 3 min ago". The same words in the website
footer, the popup status caption and the options rail. Renders nothing until the list version
is known.
-->
<script lang="ts">
	import { fmtAgo, fmtListVersion, type DateInput } from '../../utils/format';

	let {
		sequence,
		updatedAt,
		now = Date.now()
	}: { sequence: number | null | undefined; updatedAt?: DateInput | null; now?: DateInput } = $props();
</script>

{#if sequence}
	<span class="live">
		<span class="dot" aria-hidden="true"></span>
		<span>Core list {fmtListVersion(sequence)}{#if updatedAt}, updated {fmtAgo(updatedAt, now)}{/if}</span>
	</span>
{/if}

<style>
	.live {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 24px;
		padding: 0 10px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-full);
		color: var(--cl-text-muted);
		font: var(--cl-caption);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cl-text);
	}
</style>
