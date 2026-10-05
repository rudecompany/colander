<!--
@component PageHeader: eyebrow, a two-tone H1 and a lede, opening every inner page and every
options section. `site` sets display-lg and the lead type (website pages, welcome); `app` sets
display 32/40 and body large (options sections, the source page). `title2` is the muted
continuation of a two-tone headline, at the same size and weight.
Spacing: eyebrow to title 12, title to lede 16.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		title2,
		lede,
		variant = 'site',
		id,
		children
	}: { eyebrow?: string; title: string; title2?: string; lede?: string; variant?: 'site' | 'app'; id?: string; children?: Snippet } = $props();
</script>

<header class="ph ph-{variant}">
	{#if eyebrow}<p class="cl-eyebrow">{eyebrow}</p>{/if}
	<h1 {id} class={variant === 'site' ? 'cl-display-lg' : 'cl-display'}>
		{title}{#if title2}{' '}<span class="cl-tone2">{title2}</span>{/if}
	</h1>
	{#if lede}<p class="lede">{lede}</p>{/if}
	{#if children}{@render children()}{/if}
</header>

<style>
	.ph {
		display: grid;
		justify-items: start;
	}
	h1 {
		margin: 12px 0 0;
		max-width: 22ch;
	}
	.cl-eyebrow + h1,
	.ph > h1:first-child {
		margin-top: 0;
	}
	.cl-eyebrow {
		margin: 0 0 12px;
	}
	.lede {
		margin: 16px 0 0;
		max-width: 68ch;
		color: var(--cl-text-muted);
	}
	.ph-site .lede {
		font: var(--cl-lead);
	}
	.ph-app .lede {
		font: var(--cl-body-lg);
	}
	.ph-app h1 {
		max-width: none;
	}
</style>
