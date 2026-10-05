<script lang="ts">
	import '@colander/shared/styles/tokens.css';
	import '@colander/shared/styles/colander.css';
	import '@colander/shared/components/ui/button/button.css';
	import '@colander/shared/components/ui/badge/badge.css';
	import '@colander/shared/components/ui/card/card.css';
	import '@colander/shared/components/ui/input/input.css';
	import '@colander/shared/components/ui/textarea/textarea.css';
	import '@colander/shared/components/ui/native-select/native-select.css';
	import '@colander/shared/components/ui/checkbox/checkbox.css';
	import '@colander/shared/components/ui/segmented-control/segmented-control.css';
	import '@colander/shared/components/ui/tabs/tabs.css';
	import '@colander/shared/components/ui/kbd/kbd.css';
	import '@colander/shared/components/ui/toast/toaster.css';
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Toaster from '@colander/shared/components/ui/toast/toaster.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import { refreshLive } from '#lib/live.svelte.ts';
	import { onStepUp, type StepUpReason } from '#lib/api.ts';
	import type { Component } from 'svelte';
	import { tick } from 'svelte';

	let { children } = $props();
	onMount(refreshLive);

	// The step-up dialog loads the first time a request needs it, so pages that never ask do not carry it.
	type StepUpDialog = { ask(reason: StepUpReason): Promise<boolean> };
	let StepUp = $state<Component<Record<string, never>, StepUpDialog>>();
	let stepUp = $state<StepUpDialog>();
	onStepUp(async (reason) => {
		StepUp ??= (await import('#lib/components/StepUp.svelte')).default as unknown as Component<Record<string, never>, StepUpDialog>;
		await tick();
		return stepUp!.ask(reason);
	});
</script>

<a class="skip-link" href="#main">Skip to content</a>
<SiteHeader app={page.url.pathname.startsWith('/console') ? 'Review console' : page.url.pathname.startsWith('/admin') ? 'Admin console' : ''} />
<main id="main" tabindex="-1">
	{@render children()}
</main>
<SiteFooter />
<Toaster />
{#if StepUp}<StepUp bind:this={stepUp} />{/if}

<style>
	/* At least a screen tall under the header, so the footer never starts in the first view and
	   jumps while a page loads its data (the CLS budget is 0.02). */
	main {
		display: block;
		flex: 1;
		min-height: calc(100dvh - 64px);
	}
	@media (max-width: 1023px) {
		main {
			min-height: calc(100dvh - 56px);
		}
	}
	main:focus {
		outline: none;
		box-shadow: none;
	}
</style>
