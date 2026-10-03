<script lang="ts">
	import { onMount } from 'svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ColanderMark } from '@colander/shared';
	import { api, errorText } from '#lib/api.ts';
	import { fmtMonth } from '#lib/format.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

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

<PageHead
	eyebrow="Supporters"
	title="Thank you"
	lede="These people support Colander and chose to be credited. Their support pays for review, upkeep and the servers that sign the lists, and it never changes a verdict."
/>

<div class="wrap page">
	{#if error}
		<div class="error-box">
			<Notice tone="error" title="The list could not load"><p>{error}</p></Notice>
			<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={load}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Try again</button>
		</div>
	{:else if supporters === null}
		<Loading label="Loading supporters" />
	{:else if supporters.length === 0}
		<div class="empty cl-dots">
			<div class="empty-inner">
				<ColanderMark size={40} />
				<p class="t-title">No credited supporters yet</p>
				<p class="t-body muted">The first names appear here once donations open.</p>
			</div>
		</div>
	{:else}
		<ul class="names">
			{#each supporters as s, i (s.name + i)}
				<li><span class="name">{s.name}</span><span class="since">Since {fmtMonth(s.since)}</span></li>
			{/each}
		</ul>
	{/if}

	<div class="cta card-raised">
		<div>
			<p class="t-title">Add your name</p>
			<p class="t-body muted">Give once or monthly. Credit is optional, and amounts are never published.</p>
		</div>
		<a class="uin-btn uin-btn-primary btn-lg" href="/support"><Heart size={16} strokeWidth={1.75} aria-hidden="true" /> Support our work</a>
	</div>
</div>

<style>
	.page {
		display: grid;
		gap: var(--cl-s6);
		padding-top: var(--cl-s6);
	}
	.names {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0 var(--cl-s5);
	}
	.names li {
		display: grid;
		gap: 2px;
		padding: var(--cl-s4) 0;
		border-bottom: 1px solid var(--cl-border);
	}
	.name {
		font: var(--cl-title);
		overflow-wrap: anywhere;
	}
	.since {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.empty {
		display: grid;
		place-items: center;
		min-height: 280px;
		border-radius: var(--cl-r-card);
	}
	.empty-inner {
		display: grid;
		justify-items: center;
		gap: var(--cl-s2);
		padding: var(--cl-s5) var(--cl-s6);
		background: var(--cl-paper);
		border-radius: var(--cl-r-card);
		text-align: center;
	}
	.cta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--cl-s4);
	}
	.error-box {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
		max-width: 560px;
	}
</style>
