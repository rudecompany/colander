<!--
@component CopyButton: a secondary button that copies `text`, saying "Copied" for 2 seconds.
-->
<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Button from '../ui/button/button.svelte';

	let { text, label = 'Copy', size = 'md' }: { text: string; label?: string; size?: 'sm' | 'md' | 'lg' | 'xl' } = $props();
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}
</script>

<Button variant="secondary" {size} onclick={copy}>
	{#if copied}<Check size={16} aria-hidden="true" />{:else}<Copy size={16} aria-hidden="true" />{/if}
	<span>{copied ? 'Copied' : label}</span>
</Button>
<span class="cl-sr-only" aria-live="polite">{copied ? 'Copied to the clipboard' : ''}</span>
