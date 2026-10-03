<!--
@component SectionHead: a landing section's eyebrow, two-tone H2 and lead, with an optional link.
Eyebrow to H2 12, H2 to lead 16, lead to link 16. The heading block sits 48 above the content
(32 on phones); the section adds that space.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		title2,
		lead,
		id,
		center = false,
		children
	}: { eyebrow: string; title: string; title2?: string; lead?: string; id: string; center?: boolean; children?: Snippet } = $props();
</script>

<header class="head" class:center>
	<p class="cl-eyebrow">{eyebrow}</p>
	<h2 class="cl-display-lg" {id}>{title}{#if title2}{' '}<br /><span class="cl-tone2">{title2}</span>{/if}</h2>
	{#if lead}<p class="cl-lead lead">{lead}</p>{/if}
	{#if children}<div class="link">{@render children()}</div>{/if}
</header>

<style>
	.head {
		display: grid;
		justify-items: start;
		margin-bottom: var(--cl-s7);
	}
	.center {
		justify-items: center;
		text-align: center;
	}
	/* A two-tone headline sets each clause on its own line. */
	h2 {
		max-width: 1000px;
		margin-top: 12px;
		text-wrap: balance;
	}
	.lead {
		max-width: 640px;
		margin-top: 16px;
		color: var(--cl-text-muted);
	}
	.link {
		margin-top: 16px;
	}
	@media (max-width: 639px) {
		.head {
			margin-bottom: var(--cl-s6);
		}
	}
</style>
