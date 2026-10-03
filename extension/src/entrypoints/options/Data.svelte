<!-- @component Data: export everything Colander keeps on this device, or delete it. -->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Download from '@lucide/svelte/icons/download';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import * as db from '../../lib/db';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { send } from '../../ui/store.svelte';

	let confirming = $state(false);
	let note = $state('');

	async function exportAll() {
		const local = await chrome.storage.local.get(null);
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
		await send({ type: 'delete-data' });
		confirming = false;
		note = 'Deleted. Colander made a new install ID and will download the list again. Switch platforms back on in Platforms.';
	}
</script>

<Section id="data" title="Data" description="Everything below lives on this device. Export it to keep a copy, or delete it.">
	<Card title="Export">
		<p class="muted">Settings, My list, your tags, reports, daily counts and the activity log, as one JSON file.</p>
		<div><Button variant="outline" onclick={exportAll}><Download size={16} strokeWidth={1.75} />Export everything</Button></div>
	</Card>
	<Card title="Delete local data">
		<p class="muted">Removes settings, My list, tags waiting to send, reports, counts, the activity log, the downloaded list and the install ID. Tags already sent stay in the shared pool without your install ID attached.</p>
		{#if confirming}
			<div class="confirm" role="group" aria-label="Confirm delete">
				<p>Delete everything Colander keeps on this device?</p>
				<div class="btns">
					<Button variant="outline" onclick={() => (confirming = false)}>Cancel</Button>
					<Button variant="primary" class="danger" onclick={erase}><Trash2 size={16} strokeWidth={1.75} />Delete</Button>
				</div>
			</div>
		{:else}
			<div><Button variant="outline" onclick={() => (confirming = true)}><Trash2 size={16} strokeWidth={1.75} />Delete local data</Button></div>
		{/if}
		{#if note}<p role="status">{note}</p>{/if}
	</Card>
</Section>

<style>
	.confirm {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 12px 12px 16px;
		border-radius: var(--cl-r-chip);
		background: var(--cl-slop-tint);
	}
	.btns {
		display: flex;
		gap: 8px;
	}
	:global(.uin-btn-primary.danger) {
		background: var(--cl-slop);
		color: #ffffff;
	}
	:global(:root[data-theme='dark'] .uin-btn-primary.danger) {
		color: #15171a;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light']) .uin-btn-primary.danger) {
			color: #15171a;
		}
	}
</style>
