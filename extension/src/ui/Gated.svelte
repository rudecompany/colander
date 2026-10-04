<!--
@component A Plus feature for someone without Plus: the content stays in view at 60% opacity,
inert, with one line that says so. The one upsell sits at the top of the Plus section.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { locked, children }: { locked: boolean; children: Snippet } = $props();
</script>

{#if locked}
	<p class="part">Part of Plus.</p>
	<div class="gated" inert>{@render children()}</div>
{:else}
	{@render children()}
{/if}

<style>
	.part {
		margin: 12px 0 8px;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.gated {
		opacity: 0.6;
	}
</style>
