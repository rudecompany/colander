<!--
@component Toast: ink, 44 tall, radius 10, the one shadow, bottom center 24 px up (the Toaster
places it). The same markup and CSS (styles/parts.css) as the in-page skip notice.

The 4-dot countdown drains one dot a second and calls `onTimeout` after 4 s; hover and focus
pause it, and `paused` holds it full for static pictures. Announced politely, once.
Actions sit beside their words, such as Undo (undo-2) and Why.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import VerdictGlyph from './VerdictGlyph.svelte';
	import type { Verdict } from '../../verdicts';

	type Action = { label: string; icon?: Component<{ size?: number; 'aria-hidden'?: 'true' }>; onClick: () => void };

	let {
		text,
		verdict,
		actions = [],
		paused = false,
		onClose,
		onTimeout
	}: { text: string; verdict?: Verdict; actions?: Action[]; paused?: boolean; onClose?: () => void; onTimeout?: () => void } = $props();
</script>

<div class="cl-toast cl-ink" role="status" aria-live="polite" data-v={verdict}>
	{#if verdict}<VerdictGlyph {verdict} size={16} />{/if}
	<span class="cl-toast-t">{text}</span>
	{#each actions as a (a.label)}
		<button type="button" class="cl-b cl-b-q cl-b-sm" onclick={a.onClick}>
			{#if a.icon}<a.icon size={16} aria-hidden="true" />{/if}{a.label}
		</button>
	{/each}
	<span class="cl-count" aria-hidden="true" data-paused={paused || undefined}>
		<i onanimationend={() => onTimeout?.()}></i><i></i><i></i><i></i>
	</span>
	<button type="button" class="cl-b cl-x" aria-label="Close" onclick={() => onClose?.()}><X size={16} aria-hidden="true" /></button>
</div>
