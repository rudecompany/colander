<!--
@component Eyebrow: a 3-dot mark and a short sentence-case label in 600 12/16, muted.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { text, children, class: className = '' }: { text?: string; children?: Snippet; class?: string } = $props();
</script>

<p class="cl-eyebrow {className}">{#if children}{@render children()}{:else}{text}{/if}</p>
