<!--
@component InPage: one <colander-ui> shadow host on a page, filled by a shared in-page builder.
On the website it prerenders as Declarative Shadow DOM (the website registers a prerender
document with setServerDocument), so it reads complete without JavaScript. In the browser it
rebuilds with live callbacks whenever state read by `build` changes, and keeps focus on the
element with the same data-k. In the extension it simply mounts.

`theme="auto"` follows the system setting; `css` adds page-only rules (DEMO_CSS for the feed).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { inpageContext, mountInto, prerender, type Build, type Theme } from '../../inpage/host';

	let {
		build,
		kind,
		theme = 'auto',
		site = '',
		css = '',
		class: className,
		style
	}: { build: Build; kind: string; theme?: Theme; site?: string; css?: string; class?: string; style?: string } = $props();

	// Server only: null in the browser, which drops the branch and mounts instead.
	const ssr = untrack(() => prerender(build, theme, site, css));
	let host = $state<HTMLElement>();

	$effect(() => {
		if (host) mountInto(host, build(inpageContext(host.ownerDocument, site)), theme, css);
	});
</script>

<colander-ui bind:this={host} data-kind={kind} {theme} class={className} {style}
	>{#if ssr}{@html ssr}{/if}</colander-ui
>

<style>
	colander-ui {
		display: block;
	}
</style>
