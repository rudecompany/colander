<!--
@component Plan: Free with the Plus price card, or Plus with its renewal; Connect Plus with a code
from the website (contracts 7) until paid Plus is on; and Support our work.
-->
<script lang="ts">
	import { PageHeader, PriceCard } from '@colander/shared';
	import { PLAN_COPY } from '@colander/shared/copy';
	import { fmtDate } from '@colander/shared/format';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Heart from '@lucide/svelte/icons/heart';
	import { SITE } from '../../lib/env';
	import { isPlus, K, type Entitlement } from '../../lib/settings';
	import PairCode from '../../ui/PairCode.svelte';
	import { startTrial, stored } from '../../ui/store.svelte';

	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const e = $derived(entitlement.value);
	const plus = $derived(isPlus(e));
	let busy = $state(false);
	let error = $state('');

	async function trial() {
		busy = true;
		error = '';
		const r = await startTrial();
		busy = false;
		if (!r.ok) error = r.error ?? 'The trial could not start. Try again in a moment.';
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Plan" lede="Blocking is free for good. Plus adds control, never influence over a verdict." />

<div class="cards">
	{#if plus && e}
		<Card title={e.trial ? 'Plus trial, active' : 'Plus, active'} headingLevel={2}>
			<p>{e.trial ? 'Your trial ends on' : 'Plus renews on'} <strong>{fmtDate(e.exp * 1000)}</strong>.{#if !e.trial}{' '}It is connected through your account on the website.{/if}</p>
			<div class="btns">
				{#if e.trial}<Button variant="primary" href="{SITE}/plans" target="_blank" rel="noopener">Keep Plus after the trial</Button>{/if}
				<Button variant="secondary" href="{SITE}/account" target="_blank" rel="noopener">Manage on the website</Button>
			</div>
		</Card>
	{:else}
		<Card title="Current plan: Free" headingLevel={2}>
			<p>Everything that blocks slop is included, and always will be.</p>
		</Card>
		<PriceCard plan="plus" size="app" headingLevel={2} cta={{ onclick: trial }} />
		{#if busy}<p class="caption" role="status">Starting the trial</p>{/if}
		{#if error}<p class="err" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>{/if}
		<p class="caption">{PLAN_COPY.trust}</p>
	{/if}

	{#if !plus || e?.trial}
		<Card title="Connect Plus with a code" headingLevel={2}>
			<p class="muted">Have Plus on your account? Connect this browser with a code. Nothing else about your account comes with it.</p>
			<div class="pair">
				<PairCode id="plan-code" hint="On the Colander website, open your account and choose Show a code. It works once, for 10 minutes." />
			</div>
		</Card>
	{/if}

	<Card title="Support our work" headingLevel={2}>
		<p class="muted">Colander is funded by the people who use it, never by ads or data. A gift of any size keeps the review team going.</p>
		<div class="btns">
			<Button variant="quiet" href="{SITE}/support" target="_blank" rel="noopener"><Heart size={16} aria-hidden="true" />Support our work</Button>
		</div>
	</Card>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.pair {
		margin-top: 16px;
	}
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
	}
	.btns :global(.uin-btn-ghost) {
		margin-left: -12px;
	}
	.muted,
	.caption {
		color: var(--cl-text-muted);
	}
	.caption {
		margin-top: -12px;
		font: var(--cl-caption);
	}
	.err {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
</style>
