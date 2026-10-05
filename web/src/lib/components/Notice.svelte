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
	<span class="icon"><Icon size={16} aria-hidden="true" /></span>
	<div class="content">
		{#if title}<p class="title">{title}</p>{/if}
		{#if children}<div class="body">{@render children()}</div>{/if}
	</div>
</div>

<style>
	.notice {
		display: flex;
		gap: var(--cl-s2);
		padding: var(--cl-s3) var(--cl-s4);
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
		background: var(--cl-surface);
		font: var(--cl-body);
	}
	.notice-error {
		border-color: var(--cl-border-strong);
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
		margin-top: var(--cl-s1);
	}
	.body {
		color: var(--cl-text-muted);
	}
	.body :global(p + p) {
		margin-top: var(--cl-s2);
	}
</style>
