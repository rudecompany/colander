<!-- @component Page heading: a short label, the title and an optional lede, over a perforated rule. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		lede,
		narrow = false,
		children
	}: { eyebrow?: string; title: string; lede?: string; narrow?: boolean; children?: Snippet } = $props();
</script>

<header class="page-head">
	<div class="wrap" class:wrap-narrow={narrow}>
		<div class="inner">
			{#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
			<h1 class="t-display">{title}</h1>
			{#if lede}<p class="t-lede">{lede}</p>{/if}
			{#if children}{@render children()}{/if}
		</div>
	</div>
	<div class="wrap" class:wrap-narrow={narrow}><hr class="dot-rule" /></div>
</header>

<style>
	.page-head {
		padding-top: 64px;
	}
	.inner {
		display: grid;
		gap: var(--cl-s3);
		max-width: 760px;
		padding-bottom: var(--cl-s6);
	}
	.t-lede {
		font-size: 18px;
		line-height: 28px;
	}
	@media (max-width: 720px) {
		.page-head {
			padding-top: var(--cl-s6);
		}
	}
</style>
