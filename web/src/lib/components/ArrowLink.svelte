<!--
@component ArrowLink: a text link that ends in arrow-right at 16 px, for every "->" in the copy.
Inline, so a long link wraps like text; a word joiner keeps the arrow on the last word's line.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	let { href, children, class: className = '', size = 'md' }: { href: string; children: Snippet; class?: string; size?: 'sm' | 'md' | 'lg' } = $props();
</script>

<a {href} class="arrow arrow-{size} {className}">{@render children()}&#8288;<ArrowRight size={16} aria-hidden="true" /></a>

<style>
	.arrow {
		display: inline;
		font-weight: 600;
		text-decoration: none;
	}
	.arrow:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.arrow :global(svg) {
		display: inline-block;
		margin-left: 6px;
		vertical-align: -3px;
		transition: transform var(--cl-fast) var(--cl-ease);
	}
	.arrow:hover :global(svg) {
		transform: translateX(2px);
	}
	.arrow-sm {
		font: var(--cl-chip);
	}
	.arrow-md {
		font: var(--cl-body-strong);
	}
	.arrow-lg {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
</style>
