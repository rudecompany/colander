<!-- @component Lists: the signed core list and My list (blocks and allows), with import and export. -->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { PLATFORM_NAME, type Platform } from '@colander/shared/verdicts';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Download from '@lucide/svelte/icons/download';
	import Upload from '@lucide/svelte/icons/upload';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { itemFromUrl, parseTargetKey, sourceFromUrl, targetKey } from '@colander/shared/ids';
	import { ORIGINS } from '../../lib/platforms';
	import { DEFAULT_STATUS, K, withDefaults, type MyListEntry, type Settings, type Status } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { ago, fmtDate, fmtNum, send, stored } from '../../ui/store.svelte';

	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	let syncing = $state(false);
	let link = $state('');
	let linkError = $state('');
	let importNote = $state('');

	async function syncNow() {
		syncing = true;
		await send({ type: 'sync-now' }).catch(() => undefined);
		syncing = false;
	}

	function describe(key: string, name?: string) {
		const t = parseTargetKey(key);
		if (!t) return { title: name ?? key, sub: '' };
		return { title: name || t.id, sub: `${PLATFORM_NAME[t.platform]} ${t.type === 'source' ? 'source' : 'item'} · ${t.id}` };
	}

	function parseLink(text: string): { key: string } | null {
		let url: URL;
		try {
			url = new URL(text.trim());
		} catch {
			return null;
		}
		const platform = (Object.keys(ORIGINS) as Platform[]).find((p) => ORIGINS[p].some((o) => o.split('/')[2] === url.hostname));
		if (!platform) return null;
		const source = sourceFromUrl(platform, url.href);
		const item = itemFromUrl(platform, url.href);
		// A link to a video or post blocks that item; a link to a channel, profile or page blocks the source.
		if (item) return { key: targetKey(platform, 'item', item) };
		if (source) return { key: targetKey(platform, 'source', source) };
		return null;
	}

	async function add(list: 'blocks' | 'allows') {
		linkError = '';
		const parsed = parseLink(link);
		if (!parsed) {
			linkError = 'Paste a link to a channel, profile, page, video or post on YouTube, TikTok, Instagram or Facebook.';
			return;
		}
		await send({ type: list === 'blocks' ? 'block' : 'allow', key: parsed.key });
		link = '';
	}

	function exportList() {
		const data = { colander: 'my-list', version: 1, allows: settings.allows, blocks: settings.blocks };
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
		a.download = 'colander-my-list.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	async function importList(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		(e.currentTarget as HTMLInputElement).value = '';
		if (!file) return;
		importNote = '';
		try {
			const data = JSON.parse(await file.text()) as { colander?: string; allows?: MyListEntry[]; blocks?: MyListEntry[] };
			if (data.colander !== 'my-list') throw new Error();
			const clean = (l: MyListEntry[] | undefined) =>
				(l ?? []).filter((e) => e && typeof e.key === 'string' && parseTargetKey(e.key)).map((e) => ({ key: e.key, name: typeof e.name === 'string' ? e.name.slice(0, 120) : undefined, at: Number(e.at) || Date.now() }));
			const merge = (a: MyListEntry[], b: MyListEntry[]) => [...new Map([...a, ...b].map((e) => [e.key, e])).values()];
			const allows = clean(data.allows), blocks = clean(data.blocks);
			await send({ type: 'settings', patch: { allows: merge(settings.allows, allows), blocks: merge(settings.blocks, blocks) } });
			importNote = `Imported ${allows.length} allows and ${blocks.length} blocks.`;
		} catch {
			importNote = 'That file is not a Colander My list export.';
		}
	}
</script>

<Section id="lists" title="Lists" description="Colander matches pages against lists on this device. Nothing about what you watch is sent to check them.">
	<Card title="Core list">
		{#snippet aside()}
			<Button variant="outline" onclick={syncNow} aria-busy={syncing}><RefreshCw size={16} strokeWidth={1.75} />{syncing ? 'Syncing' : 'Sync now'}</Button>
		{/snippet}
		<p class="muted">The shared, signed list every install uses. It updates every hour, and blocking keeps working offline from the last copy.</p>
		<dl class="facts">
			<div><dt>Version</dt><dd class="cl-num">{status.value.listSequence ? String(status.value.listSequence) : 'Not downloaded yet'}</dd></div>
			<div><dt>Entries</dt><dd class="cl-num">{fmtNum(status.value.listCount)}</dd></div>
			<div><dt>Published</dt><dd>{status.value.listCreated ? fmtDate(status.value.listCreated * 1000) : 'Not yet'}</dd></div>
			<div><dt>Last sync</dt><dd>{ago(status.value.lastSyncAt)}</dd></div>
		</dl>
		{#if status.value.lastError}
			<p class="warn" role="status">The last update failed: {status.value.lastError}. Colander keeps using the last good copy.</p>
		{/if}
	</Card>

	<Card title="My list">
		{#snippet aside()}
			<Button variant="outline" onclick={exportList}><Download size={16} strokeWidth={1.75} />Export</Button>
			<label class="uin-btn uin-btn-outline uin-btn-md file">
				<Upload size={16} strokeWidth={1.75} />Import
				<input type="file" accept="application/json,.json" class="sr-only" onchange={importList} />
			</label>
		{/snippet}
		<p class="muted">Your own blocks and allows. They apply only for you, and Always allow overrides every list.</p>
		<form class="add" onsubmit={(e) => (e.preventDefault(), add('blocks'))}>
			<label for="add-link" class="sr-only">Link to a channel, profile, page, video or post</label>
			<Input id="add-link" bind:value={link} placeholder="Paste a link to a channel, profile, page, video or post" aria-invalid={!!linkError} aria-describedby={linkError ? 'add-error' : undefined} />
			<Button variant="outline" type="submit">Block</Button>
			<Button variant="outline" onclick={() => add('allows')}>Allow</Button>
		</form>
		{#if linkError}<p id="add-error" class="warn" role="alert">{linkError}</p>{/if}
		{#if importNote}<p class="muted" role="status">{importNote}</p>{/if}

		{#each [{ id: 'blocks', label: 'Blocks', items: settings.blocks, empty: 'No blocks yet.' }, { id: 'allows', label: 'Allows', items: settings.allows, empty: 'No allows yet. Use Always allow on any hidden item.' }] as group (group.id)}
			<h4 class="group">{group.label} <span class="muted cl-num">{group.items.length}</span></h4>
			{#if group.items.length === 0}
				<p class="muted t-caption">{group.empty}</p>
			{:else}
				<ul class="entries">
					{#each [...group.items].sort((a, b) => b.at - a.at) as e (e.key)}
						{@const d = describe(e.key, e.name)}
						<li>
							<div class="who"><span class="name">{d.title}</span><span class="t-caption muted">{d.sub}</span></div>
							<Button variant="ghost" class="quiet-muted" aria-label="Remove {d.title}" onclick={() => send({ type: 'unlist', list: group.id as 'blocks' | 'allows', key: e.key })}>
								<Trash2 size={16} strokeWidth={1.75} />Remove
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		{/each}
	</Card>
</Section>

<style>
	.facts {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 16px;
		padding: 12px 0 4px;
		border-top: 1px solid var(--cl-border);
	}
	.facts div {
		display: flex;
		flex-direction: column;
	}
	dt {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	dd {
		font-weight: 600;
	}
	.warn {
		color: var(--cl-slop);
	}
	.file {
		cursor: pointer;
	}
	.file:focus-within {
		box-shadow: var(--uin-focus-ring);
	}
	.add {
		display: flex;
		gap: 8px;
	}
	.group {
		display: flex;
		gap: 8px;
		margin-top: 8px;
		font-weight: 600;
	}
	.entries {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
	}
	.entries li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 8px 8px 12px;
	}
	.entries li + li {
		border-top: 1px solid var(--cl-border);
	}
	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
