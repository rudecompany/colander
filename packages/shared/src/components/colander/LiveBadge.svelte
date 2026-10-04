<!--
@component LiveBadge: "Core list v.1791151393, updated 3 min ago". The same words in the website
footer, the popup status caption and the options rail. Renders nothing until the list version
is known. The version is a 10-digit sequence, so in a narrow place the pill wraps inside its
container, after the comma, rather than running past it.
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
		<span class="text">Core list {fmtListVersion(sequence)}{#if updatedAt}, <span class="ago">updated {fmtAgo(updatedAt, now)}</span>{/if}</span>
	</span>
{/if}

<style>
	.live {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 24px;
		padding: 2px 10px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-full);
		color: var(--cl-text-muted);
		font: var(--cl-caption);
		font-variant-numeric: tabular-nums;
	}
	.text {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.ago {
		white-space: nowrap;
	}
	.dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cl-text);
	}
</style>
