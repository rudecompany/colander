<!-- @component A titled options section with a one-line description. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { id, title, description, children }: { id: string; title: string; description?: string; children: Snippet } = $props();
</script>

<section class="section" aria-labelledby="{id}-title">
	<header>
		<h2 id="{id}-title" class="t-title">{title}</h2>
		{#if description}<p class="muted">{description}</p>{/if}
	</header>
	{@render children()}
</section>

<style>
	.section {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	header {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
	}
	header p {
		max-width: 60ch;
	}
</style>
