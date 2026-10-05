<!--
@component DotField: 1.5 px dots at a 12 px pitch, pure CSS. `mask` fades it, for example
"radial-gradient(closest-side, black, transparent 60%)"; `round` makes a disc. Children sit on
top, centered. Decorative.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		mask,
		round = false,
		class: className = '',
		style = '',
		children
	}: { mask?: string; round?: boolean; class?: string; style?: string; children?: Snippet } = $props();
</script>

<div class="field {className}" class:round {style}>
	<div class="cl-dots dots" style:mask-image={mask} style:-webkit-mask-image={mask} aria-hidden="true"></div>
	{#if children}<div class="content">{@render children()}</div>{/if}
</div>

<style>
	.field {
		position: relative;
		display: grid;
		place-items: center;
	}
	.round,
	.round .dots {
		border-radius: 50%;
	}
	.dots {
		position: absolute;
		inset: 0;
	}
	.content {
		position: relative;
	}
</style>
