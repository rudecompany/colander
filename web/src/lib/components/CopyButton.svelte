<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';

	let { text, label = 'Copy' }: { text: string; label?: string } = $props();
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

<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={copy}>
	{#if copied}<Check size={16} strokeWidth={1.75} aria-hidden="true" />{:else}<Copy size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
	<span>{copied ? 'Copied' : label}</span>
</button>
<span class="sr-only" aria-live="polite">{copied ? 'Copied to the clipboard' : ''}</span>
