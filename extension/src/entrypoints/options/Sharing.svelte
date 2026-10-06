<!--
@component Sharing, in the Firefox build only: Firefox asks before an add-on sends anything, so
tags and reports, and Plus and review, each wait for a yes (lib/consent.ts). The background opens
this section when a tag or report waits. Allowing tags and reports sends the tags that waited;
either can be turned off again here or in Firefox's add-ons manager.
-->
<script lang="ts">
	import { PageHeader } from '@colander/shared';
	import { plural } from '@colander/shared/format';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Check from '@lucide/svelte/icons/check';
	import { browser } from 'wxt/browser';
	import { allowed, ask, type DataKind } from '../../lib/consent';
	import * as db from '../../lib/db';

	const KINDS: { kind: DataKind; title: string; what: string; allow: string }[] = [
		{
			kind: 'websiteContent',
			title: 'Tags and reports',
			what: "Each tag and report you choose to send: the platform, the item or source ID, your answers and this install's random ID. Never the page address or what you watch.",
			allow: 'Allow tags and reports'
		},
		{
			kind: 'authenticationInfo',
			title: 'Plus and review',
			what: 'The plan or reviewer token Colander made for your account, when it checks your plan, syncs your settings or loads the review queue. Nothing else about your account.',
			allow: 'Allow Plus and review'
		}
	];

	let granted = $state<Partial<Record<DataKind, boolean>>>({});
	let waiting = $state(0);

	async function refresh() {
		for (const k of KINDS) granted[k.kind] = await allowed(k.kind);
		waiting = (await db.all('tags')).length;
	}

	$effect(() => {
		void refresh();
		browser.permissions.onAdded.addListener(refresh);
		browser.permissions.onRemoved.addListener(refresh);
		return () => {
			browser.permissions.onAdded.removeListener(refresh);
			browser.permissions.onRemoved.removeListener(refresh);
		};
	});

	async function allow(kind: DataKind) {
		// Straight from the click, as Firefox requires. The background sends waiting tags once it hears.
		if (await ask([kind])) await refresh();
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Sharing" lede="Firefox asks before Colander sends anything. Blocking works without either: the list and matching stay on this device." />

<div class="cards">
	{#each KINDS as k (k.kind)}
		<Card title={k.title} headingLevel={2}>
			<p class="muted">{k.what}</p>
			{#if k.kind === 'websiteContent' && waiting && !granted.websiteContent}
				<p class="wait" role="status">{plural(waiting, 'tag')} {waiting === 1 ? 'waits' : 'wait'} on this device, sent once you allow it.</p>
			{/if}
			<div class="row">
				{#if granted[k.kind] === undefined}
					<span class="muted">Checking</span>
				{:else if granted[k.kind]}
					<span class="on"><Check size={16} aria-hidden="true" />Allowed</span>
				{:else}
					<Button variant="primary" onclick={() => allow(k.kind)}>{k.allow}</Button>
				{/if}
			</div>
		</Card>
	{/each}
	<p class="caption">To turn either off, open Firefox's add-ons manager, choose Colander, then Permissions and data.</p>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.muted,
	.caption {
		color: var(--cl-text-muted);
	}
	.caption {
		font: var(--cl-caption);
	}
	.wait {
		margin-top: 12px;
	}
	.row {
		display: flex;
		align-items: center;
		min-height: 32px;
		margin-top: 16px;
	}
	.on {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--cl-body-strong);
	}
</style>
