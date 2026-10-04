<!-- @component Lists: the signed core list and My list (blocks and allows), with import and export. -->
<script lang="ts">
	import { PageHeader, PlatformTag } from '@colander/shared';
	import { fmtAgo, fmtListVersion, fmtNum, fmtShortDate } from '@colander/shared/format';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import type { Platform } from '@colander/shared/verdicts';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Download from '@lucide/svelte/icons/download';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Upload from '@lucide/svelte/icons/upload';
	import { itemFromUrl, parseTargetKey, sourceFromUrl, targetKey } from '@colander/shared/ids';
	import { ORIGINS } from '../../lib/platforms';
	import { DEFAULT_STATUS, K, withDefaults, type MyListEntry, type Settings, type Status } from '../../lib/settings';
	import { send, stored } from '../../ui/store.svelte';

	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	let syncing = $state(false);
	let link = $state('');
	let which = $state<'blocks' | 'allows'>('blocks');
	let linkError = $state('');
	let importNote = $state('');

	const entries = $derived(
		[...settings.blocks.map((e) => ({ ...e, list: 'blocks' as const })), ...settings.allows.map((e) => ({ ...e, list: 'allows' as const }))].sort((a, b) => b.at - a.at)
	);

	async function syncNow() {
		syncing = true;
		await send({ type: 'sync-now' }).catch(() => undefined);
		syncing = false;
	}

	function parseLink(text: string): string | null {
		let url: URL;
		try {
			url = new URL(text.trim());
		} catch {
			return null;
		}
		const platform = (Object.keys(ORIGINS) as Platform[]).find((p) => ORIGINS[p].some((o) => o.split('/')[2] === url.hostname));
		if (!platform) return null;
		// A link to a video or post lists that item; a link to a channel, profile or page lists the source.
		const item = itemFromUrl(platform, url.href);
		if (item) return targetKey(platform, 'item', item);
		const source = sourceFromUrl(platform, url.href);
		return source ? targetKey(platform, 'source', source) : null;
	}

	async function add(e: Event) {
		e.preventDefault();
		linkError = '';
		const key = parseLink(link);
		if (!key) {
			linkError = 'Paste a link to a channel, profile, page, video or post on YouTube, TikTok, Instagram or Facebook.';
			return;
		}
		await send({ type: which === 'blocks' ? 'block' : 'allow', key });
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
				(l ?? [])
					.filter((x) => x && typeof x.key === 'string' && parseTargetKey(x.key))
					.map((x) => ({ key: x.key, name: typeof x.name === 'string' ? x.name.slice(0, 120) : undefined, at: Number(x.at) || Date.now() }));
			const merge = (a: MyListEntry[], b: MyListEntry[]) => [...new Map([...a, ...b].map((x) => [x.key, x])).values()];
			const allows = clean(data.allows);
			const blocks = clean(data.blocks);
			await send({ type: 'settings', patch: { allows: merge(settings.allows, allows), blocks: merge(settings.blocks, blocks) } });
			importNote = `Imported ${allows.length} allows and ${blocks.length} blocks.`;
		} catch {
			importNote = 'That file is not a Colander My list export.';
		}
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Lists" lede="Colander matches pages against lists on this device. Nothing about what you watch is sent to check them." />

<div class="cards">
	<Card title="Core list" headingLevel={2}>
		<p class="muted">The shared, signed list every install uses. It updates every hour, and blocking keeps working offline from the last copy.</p>
		<dl class="facts">
			<div><dt>Version</dt><dd class="cl-figure">{status.value.listSequence ? fmtListVersion(status.value.listSequence) : 'Not downloaded yet'}</dd></div>
			<div><dt>Entries</dt><dd class="cl-num">{fmtNum(status.value.listCount)}</dd></div>
			<div><dt>Published</dt><dd>{status.value.listCreated ? fmtShortDate(status.value.listCreated * 1000) : 'Not yet'}</dd></div>
			<div>
				<dt>Last sync</dt>
				<dd class="sync">
					<span>{status.value.lastSyncAt ? fmtAgo(status.value.lastSyncAt) : 'Never'}</span>
					<Button variant="quiet" onclick={syncNow} loading={syncing}><RefreshCw size={16} aria-hidden="true" />Sync now</Button>
				</dd>
			</div>
		</dl>
		{#if status.value.lastError}
			<p class="note" role="status"><CircleAlert size={16} aria-hidden="true" />The last update failed: {status.value.lastError}. Colander keeps using the last good copy.</p>
		{/if}
	</Card>

	<Card title="My list" headingLevel={2}>
		{#snippet aside()}
			<Button variant="secondary" onclick={exportList}><Download size={16} aria-hidden="true" />Export</Button>
			<label class="uin-btn uin-btn-outline uin-btn-md file">
				<Upload size={16} aria-hidden="true" />Import
				<input type="file" accept="application/json,.json" class="cl-sr-only" onchange={importList} />
			</label>
		{/snippet}
		<p class="muted">Your own blocks and allows. They apply only for you, and Always allow overrides every list.</p>
		<form class="add" onsubmit={add}>
			<label for="add-link" class="label">Link to a channel, profile, page, video or post</label>
			<div class="row">
				<Input id="add-link" class="grow" bind:value={link} placeholder="https://www.youtube.com/@channel" aria-invalid={!!linkError} aria-describedby={linkError ? 'add-error' : undefined} />
				<SegmentedControl options={[{ value: 'blocks', label: 'Block' }, { value: 'allows', label: 'Allow' }]} bind:value={which} ariaLabel="Block or allow" />
				<Button variant="primary" type="submit">Add</Button>
			</div>
			{#if linkError}<p id="add-error" class="note" role="alert"><CircleAlert size={16} aria-hidden="true" />{linkError}</p>{/if}
		</form>
		{#if importNote}<p class="muted" role="status">{importNote}</p>{/if}

		{#if entries.length === 0}
			<p class="empty"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>No blocks or allows yet. Use Always allow on any hidden item.</p>
		{:else}
			<ul class="entries">
				{#each entries as e (e.key)}
					{@const t = parseTargetKey(e.key)}
					<li>
						{#if t}<PlatformTag platform={t.platform} />{/if}
						<span class="name" title={t?.id}>{e.name || t?.id || e.key}</span>
						<span class="uin-badge uin-badge-md">{e.list === 'blocks' ? 'Block' : 'Allow'}</span>
						<Button variant="quiet" aria-label="Remove {e.name || t?.id || e.key}" onclick={() => send({ type: 'unlist', list: e.list, key: e.key })}>Remove</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</div>

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
	/* 4 across, 2 or 3 on a narrow screen, so Sync now stays inside the card. */
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
		gap: 16px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--cl-border);
	}
	.facts div {
		display: grid;
		align-content: start;
		gap: 4px;
	}
	dt {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	dd {
		font: var(--cl-body-strong);
	}
	.sync {
		display: grid;
		justify-items: start;
	}
	.sync :global(.uin-btn) {
		margin-left: -12px;
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-top: 12px;
	}
	.note :global(svg) {
		margin-top: 2px;
	}
	.file {
		cursor: pointer;
	}
	.file:focus-within {
		box-shadow: var(--uin-focus-ring);
	}
	.add {
		display: grid;
		gap: 8px;
		margin-top: 16px;
	}
	.label {
		font: var(--cl-body-strong);
	}
	.row {
		display: flex;
		gap: 8px;
	}
	.row :global(.grow) {
		flex: 1;
		min-width: 0;
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 16px;
		color: var(--cl-text-muted);
	}
	.entries {
		margin-top: 16px;
		border-top: 1px solid var(--cl-border);
	}
	.entries li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		border-bottom: 1px solid var(--cl-border);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font: var(--cl-body-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
