<script lang="ts">
	import { onMount } from 'svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { PerforatedDisc } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import { api, errorText } from '#lib/api.ts';
	import { fmtMonthShort } from '@colander/shared';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { PageHeader } from '@colander/shared';

	type Supporter = { name: string; since: string };
	let supporters = $state<Supporter[] | null>(null);
	let error = $state('');

	async function load() {
		error = '';
		try {
			supporters = (await api<{ supporters: Supporter[] }>('/v1/supporters')).supporters;
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(load);
</script>

<svelte:head>
	<title>Supporters · Colander</title>
	<meta name="description" content="People who support Colander and chose to be credited." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Supporters"
		title="Thank you."
		title2="Colander runs on people like these."
		lede="These people support Colander and chose to be credited. Their support pays for review, upkeep and the servers that sign the lists, and it never changes a verdict."
	/>
</div>

<div class="cl-container page-body body">
	{#if error}
		<div class="error-box">
			<Notice tone="error" title="The list could not load"><p>{error}</p></Notice>
			<Button variant="secondary" size="xl" onclick={load}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
		</div>
	{:else if supporters === null}
		<Loading />
	{:else if supporters.length === 0}
		<div class="empty">
			<PerforatedDisc size={160} mark={64} />
			<p class="cl-title">No credited supporters yet.</p>
			<ArrowLink href="/support">Support our work</ArrowLink>
		</div>
	{:else}
		<ul class="names">
			{#each supporters as s, i (s.name + i)}
				<li><span class="name">{s.name}</span><span class="cl-figure since">Since {fmtMonthShort(s.since)}</span></li>
			{/each}
		</ul>
		<div class="cta uin-card uin-card-lg uin-card-pad">
			<div>
				<p class="cl-title">Add your name</p>
				<p class="cl-muted">Give once or monthly. Credit is optional, and amounts are never published.</p>
			</div>
			<Button variant="primary" size="xl" href="/support"><Heart size={16} aria-hidden="true" />Support our work</Button>
		</div>
	{/if}
</div>

<style>
	.body {
		display: grid;
		gap: 48px;
	}
	.names {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0 24px;
		list-style: none;
	}
	.names li {
		display: grid;
		gap: 4px;
		padding: 16px 0;
		border-bottom: 1px solid var(--cl-border);
	}
	.name {
		font: var(--cl-title);
		overflow-wrap: anywhere;
	}
	.since {
		color: var(--cl-text-muted);
	}
	.empty {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding-block: 48px;
		text-align: center;
	}
	.cta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.error-box {
		display: grid;
		justify-items: start;
		gap: 12px;
		max-width: 560px;
	}
	@media (max-width: 1023px) {
		.names {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 639px) {
		.names {
			grid-template-columns: 1fr;
		}
	}
</style>
