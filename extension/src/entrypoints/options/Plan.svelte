<!-- @component Plan: Free or Plus, the 14-day trial with no card, Get Plus, and Support our work. -->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import Check from '@lucide/svelte/icons/check';
	import { SITE } from '../../lib/env';
	import { K, type Entitlement } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { fmtDate, send, stored } from '../../ui/store.svelte';

	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const e = $derived(entitlement.value);
	const plus = $derived(!!e?.plus && e.exp * 1000 > Date.now());
	let busy = $state(false);
	let error = $state('');

	async function trial() {
		busy = true;
		error = '';
		const r = await send<{ ok: boolean; error?: string }>({ type: 'start-trial' }).catch(() => ({ ok: false, error: 'Could not reach Colander.' }));
		busy = false;
		if (!r.ok) error = r.error ?? 'The trial could not start.';
	}
	const FREE = ['Blocking on all four platforms', 'All four strictness levels', 'Tagging, reporting and appeals', 'My list blocks and allows'];
	const PLUS = ['Sync across browsers', 'Strictness per platform and per topic', 'Keyword and hashtag rules', 'A weekly summary'];
</script>

<Section id="plan" title="Plan" description="Blocking is free for good. Plus buys convenience and control, never influence over a verdict.">
	<Card title={plus ? (e?.trial ? 'Plus trial' : 'Plus') : 'Free'}>
		{#snippet aside()}
			{#if plus}<span class="uin-badge uin-badge-md uin-badge-accent">Active</span>{/if}
		{/snippet}
		{#if plus && e}
			<p>{e.trial ? 'Your trial ends on' : 'Plus is active until'} <strong>{fmtDate(e.exp * 1000)}</strong>.{#if !e.trial} Connected through your account on the website.{/if}</p>
			<div class="btns">
				{#if e.trial}<Button variant="primary" onclick={() => chrome.tabs.create({ url: `${SITE}/plans` })}>Get Plus</Button>{/if}
				<Button variant="outline" onclick={() => chrome.tabs.create({ url: `${SITE}/account` })}>Manage on the website</Button>
			</div>
		{:else}
			<p>Everything that blocks slop is included, and always will be.</p>
			<div class="btns">
				<Button variant="primary" onclick={trial} aria-busy={busy}>Start 14-day trial, no card</Button>
				<Button variant="outline" onclick={() => chrome.tabs.create({ url: `${SITE}/plans` })}>Get Plus</Button>
			</div>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<p class="t-caption muted">Plus is $3 a month or $30 a year. Bought on the website, it connects here on its own.</p>
		{/if}
		<div class="compare">
			<div>
				<h4>Free</h4>
				<ul>{#each FREE as f (f)}<li><Check size={16} strokeWidth={1.75} />{f}</li>{/each}</ul>
			</div>
			<div>
				<h4>Plus adds</h4>
				<ul>{#each PLUS as f (f)}<li><Check size={16} strokeWidth={1.75} />{f}</li>{/each}</ul>
			</div>
		</div>
	</Card>
	<Card title="Support our work" tone="raised">
		<p>Colander is funded by people who use it, never by ads or data. A gift of any size keeps the review team going.</p>
		<div class="btns"><Button variant="outline" onclick={() => chrome.tabs.create({ url: `${SITE}/support` })}><Heart size={16} strokeWidth={1.75} />Support our work</Button></div>
	</Card>
</Section>

<style>
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.error {
		color: var(--cl-slop);
	}
	.compare {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 24px;
		padding-top: 12px;
		border-top: 1px solid var(--cl-border);
	}
	h4 {
		margin-bottom: 8px;
		font-weight: 600;
	}
	.compare ul {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.compare li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.compare :global(svg) {
		color: var(--cl-clear);
	}
</style>
