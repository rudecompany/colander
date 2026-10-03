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

	let { children } = $props();
	onMount(refreshLive);
</script>

<a class="skip-link" href="#main">Skip to content</a>
<SiteHeader app={page.url.pathname.startsWith('/console')} />
<main id="main" tabindex="-1">
	{@render children()}
</main>
<SiteFooter />
<Toaster />

<style>
	main {
		display: block;
		flex: 1;
	}
	main:focus {
		outline: none;
	}
</style>
