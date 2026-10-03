<!-- @component Shown in place of a Plus feature: what it does, a 14-day trial with no card, and Get Plus. -->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { SITE } from '../lib/env';
	import { send } from './store.svelte';

	let { what }: { what: string } = $props();
	let busy = $state(false);
	let error = $state('');

	async function trial() {
		busy = true;
		error = '';
		const r = await send<{ ok: boolean; error?: string }>({ type: 'start-trial' }).catch(() => ({ ok: false, error: 'Could not reach Colander.' }));
		busy = false;
		if (!r.ok) error = r.error ?? 'The trial could not start.';
	}
</script>

<div class="gate">
	<p><strong>{what}</strong> Part of Plus, which also syncs your settings across browsers. Blocking stays free.</p>
	<div class="btns">
		<Button variant="primary" onclick={trial} aria-busy={busy}>Start 14-day trial, no card</Button>
		<Button variant="outline" onclick={() => chrome.tabs.create({ url: `${SITE}/plans` })}>Get Plus</Button>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.gate {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border-radius: var(--cl-r-chip);
		background: var(--cl-brand-tint);
	}
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.error {
		color: var(--cl-slop);
	}
</style>
