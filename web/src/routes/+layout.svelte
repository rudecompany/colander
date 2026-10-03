<script lang="ts">
	import '@colander/shared/styles/tokens.css';
	import '@colander/shared/styles/colander.css';
	import '@colander/shared/components/ui/button/button.css';
	import '@colander/shared/components/ui/input/input.css';
	import '@colander/shared/components/ui/textarea/textarea.css';
	import '@colander/shared/components/ui/native-select/native-select.css';
	import '@colander/shared/components/ui/checkbox/checkbox.css';
	import '@colander/shared/components/ui/segmented-control/segmented-control.css';
	import '@colander/shared/components/ui/kbd/kbd.css';
	import '../app.css';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import SiteFooter from '#lib/components/SiteFooter.svelte';

	let { children } = $props();
</script>

<a class="skip-link" href="#main">Skip to content</a>
<SiteHeader />
<main id="main" tabindex="-1">
	{@render children()}
</main>
<SiteFooter />

<style>
	main {
		display: block;
		flex: 1;
		padding-bottom: var(--w-section);
	}
	main:focus {
		outline: none;
	}
</style>
