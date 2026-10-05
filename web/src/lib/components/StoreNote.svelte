<!--
@component StoreNote: what the install button's store needs said, inline, for the line under it:
Opera's one step first, then "Also in Firefox Add-ons and Edge Add-ons." for every other store with
a live listing. Empty when there is nothing to say.
-->
<script lang="ts">
	import { install, STORES } from '#lib/install.svelte.ts';

	const others = $derived(STORES.filter((s) => s.href !== install.store.href));
</script>

{#if install.store.hint}{install.store.hint}{' '}{/if}{#if others.length}Also in {#each others as s, i (s.href)}{i ? (i === others.length - 1 ? ' and ' : ', ') : ''}<a class="cl-link" href={s.href}>{s.store}</a>{/each}.{/if}
