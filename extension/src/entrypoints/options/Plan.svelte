<!--
@component Plan: Free with the Plus price card, or Plus and the account it comes from; Connect Plus
with a code from the website (contracts 7) until paid Plus is on; and Support our work. A code that
turns Plus on takes its card away, so focus moves to the Plus card and the change is announced.
-->
<script lang="ts">
	import { PageHeader, PriceCard } from '@colander/shared';
	import type { PairKind } from '@colander/shared/api';
	import { PLAN_COPY } from '@colander/shared/copy';
	import { fmtDate } from '@colander/shared/format';
	import { tick } from 'svelte';
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
	let announce = $state('');
	let paired = $state(false);

	function onpaired(kind: PairKind, done: string) {
		if (kind !== 'plan') return;
		announce = done;
		paired = true;
	}

	// Once the entitlement arrives the code card is gone: focus goes to the Plus card's heading.
	$effect(() => {
		if (!paired || !plus) return;
		paired = false;
		void tick().then(() => document.getElementById('plan-now')?.focus());
	});

	async function trial() {
		busy = true;
		error = '';
		const r = await startTrial();
		busy = false;
		if (!r.ok) error = r.error ?? 'The trial could not start. Try again in a moment.';
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Plan" lede="Blocking is free for good. Plus adds control, never influence over a verdict." />

<p class="cl-sr-only" role="status">{announce}</p>

<div class="cards">
	{#if plus && e}
		<Card title={e.trial ? 'Plus trial, active' : 'Plus, active'} titleId="plan-now" headingLevel={2}>
			{#if e.trial}
				<p>Your trial ends on <strong>{fmtDate(e.exp * 1000)}</strong>.</p>
			{:else}
				<!-- The token's end is the paid period plus a few days of grace, not a renewal date: the website has that. -->
				<p>Plus is on in this browser, connected to {#if e.account}the account <strong>{e.account}</strong>{:else}your account{/if}. Renewal and billing are on the website.</p>
			{/if}
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
				<PairCode id="plan-code" hint="On the Colander website, open your account and choose Show a code. It works once, for 10 minutes." {onpaired} />
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
	/* No last word alone on a line. */
	.cards p {
		text-wrap: pretty;
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
