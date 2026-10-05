<!-- @component Data: export everything Colander keeps on this device, or delete it after a confirm. -->
<script lang="ts">
	import { PageHeader } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import Download from '@lucide/svelte/icons/download';
	import * as db from '../../lib/db';
	import { send } from '../../ui/store.svelte';
	import { browser } from 'wxt/browser';

	let confirming = $state(false);
	let deleting = $state(false);
	let note = $state('');

	async function exportAll() {
		const local = await browser.storage.local.get(null);
		delete local.listIndex; // the list itself is public and large; its version is in status
		const data = {
			colander: 'local-data',
			exported_at: new Date().toISOString(),
			storage: local,
			activity: await db.all('activity'),
			queued_tags: await db.all('tags')
		};
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
		a.download = `colander-data-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function erase() {
		deleting = true;
		await send({ type: 'delete-data' });
		deleting = false;
		confirming = false;
		note = 'Deleted. Colander made a new install ID and will download the list again. Switch platforms back on in Platforms.';
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Data" lede="Everything below lives on this device. Export it to keep a copy, or delete it." />

<div class="cards">
	<Card title="Export" headingLevel={2}>
		<p class="muted">Settings, My list, your tags, reports, daily counts and the activity log, as one JSON file.</p>
		<div class="btns"><Button variant="secondary" onclick={exportAll}><Download size={16} aria-hidden="true" />Export everything</Button></div>
	</Card>
	<Card title="Delete local data" headingLevel={2}>
		<p class="muted">This deletes settings, My list, tags waiting to send, reports, counts, the activity log, the downloaded list and the install ID. Tags already sent stay in the shared pool without your install ID attached.</p>
		<div class="btns"><Button variant="secondary" onclick={() => (confirming = true)}>Delete local data</Button></div>
		{#if note}<p class="note" role="status">{note}</p>{/if}
	</Card>
</div>

<Dialog bind:open={confirming} title="Delete everything Colander keeps on this device?" description="You can switch platforms back on afterwards. Tags already sent stay in the shared pool, without your install ID." size="sm">
	<p class="muted">Settings, My list, waiting tags, reports, counts, the activity log, the list and the install ID.</p>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (confirming = false)}>Cancel</Button>
		<Button variant="primary" onclick={erase} loading={deleting}>Delete</Button>
	{/snippet}
</Dialog>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.muted {
		color: var(--cl-text-muted);
	}
	.btns {
		margin-top: 16px;
	}
	.note {
		margin-top: 12px;
	}
</style>
