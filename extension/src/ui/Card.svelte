<!-- @component A bordered surface for one group of settings. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, aside, children, tone = 'plain' }: { title?: string; aside?: Snippet; children: Snippet; tone?: 'plain' | 'raised' } = $props();
</script>

<div class="card {tone}">
	{#if title || aside}
		<div class="head">
			{#if title}<h3>{title}</h3>{/if}
			{#if aside}<div class="aside">{@render aside()}</div>{/if}
		</div>
	{/if}
	{@render children()}
</div>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.raised {
		background: var(--cl-surface-raised);
		border-color: transparent;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 32px;
	}
	h3 {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.aside {
		display: flex;
		gap: 8px;
		align-items: center;
	}
</style>
