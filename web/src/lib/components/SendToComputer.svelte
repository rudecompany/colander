<!--
@component SendToComputer: on phones, where Chrome extensions do not run, the install button
becomes "Send to my computer". It opens the share sheet, or copies the address and says
"Link copied". `onDone` runs after either, such as closing the menu sheet first.
-->
<script lang="ts">
	import Send from '@lucide/svelte/icons/send';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { toast } from '@colander/shared/components/ui/toast/toast.svelte.ts';

	let {
		onDone,
		caption = true,
		variant = 'primary',
		size = 'xxl'
	}: { onDone?: () => void; caption?: boolean; variant?: 'primary' | 'secondary'; size?: 'xl' | 'xxl' } = $props();

	async function send() {
		const url = location.origin + '/';
		try {
			if (navigator.share) {
				await navigator.share({ title: 'Colander', text: 'Colander hides AI slop in your feeds. Install it on a computer.', url });
				onDone?.();
				return;
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return;
		}
		try {
			await navigator.clipboard.writeText(url);
			onDone?.();
			toast({ title: 'Link copied' });
		} catch {
			onDone?.();
			toast({ title: `Open ${url} on your computer.` });
		}
	}
</script>

<div class="send">
	<Button {variant} {size} block onclick={send}><Send size={16} aria-hidden="true" />Send to my computer</Button>
	{#if caption}<p class="cap">Colander runs in Chrome on desktop.</p>{/if}
</div>

<style>
	.send {
		display: grid;
		gap: 8px;
		width: 100%;
	}
	.cap {
		color: var(--cl-text-muted);
		font: var(--cl-body);
		text-align: center;
	}
</style>
