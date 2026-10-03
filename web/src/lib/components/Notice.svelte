<!-- @component A calm message box. No alarm colors: the icon and the words carry the meaning. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Info from '@lucide/svelte/icons/info';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';

	let {
		tone = 'info',
		title,
		children
	}: { tone?: 'info' | 'error' | 'success'; title?: string; children?: Snippet } = $props();
	const Icon = $derived(tone === 'error' ? CircleAlert : tone === 'success' ? CircleCheck : Info);
</script>

<div class="notice notice-{tone}" role={tone === 'error' ? 'alert' : 'status'}>
	<span class="icon"><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
	<div class="content">
		{#if title}<p class="title">{title}</p>{/if}
		{#if children}<div class="body">{@render children()}</div>{/if}
	</div>
</div>

<style>
	.notice {
		display: flex;
		gap: 10px;
		padding: 12px 14px;
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
		background: var(--cl-surface-raised);
		font: var(--cl-body);
	}
	.notice-error {
		border-color: var(--w-control-border);
		background: var(--cl-surface);
	}
	.icon {
		flex: none;
		padding-top: 2px;
		color: var(--cl-text-muted);
	}
	.notice-error .icon {
		color: var(--cl-text);
	}
	.title {
		font-weight: 600;
	}
	.title + .body {
		margin-top: 2px;
	}
	.body {
		color: var(--cl-text-muted);
	}
	.body :global(p + p) {
		margin-top: 6px;
	}
</style>
