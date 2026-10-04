<!--
@component The list and plan at a glance: "Core list v.412", when it last updated, Sync now, and
the plan line. Leads the options rail at 1200 px and up, except on Lists, whose Core list card
says the same.
-->
<script lang="ts">
	import { fmtAgo, fmtListVersion, fmtShortDate } from '@colander/shared/format';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { DEFAULT_STATUS, isPlus, K, type Entitlement, type Status } from '../lib/settings';
	import { send, stored } from './store.svelte';

	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const e = $derived(entitlement.value);
	let syncing = $state(false);

	const plan = $derived(
		!isPlus(e) ? 'Free' : e!.trial ? `Plus trial, ends ${fmtShortDate(e!.exp * 1000)}` : `Plus, renews ${fmtShortDate(e!.exp * 1000)}`
	);

	async function syncNow() {
		syncing = true;
		await send({ type: 'sync-now' }).catch(() => undefined);
		syncing = false;
	}
</script>

<Card class="list-status">
	<p class="cl-figure">Core list {status.value.listSequence ? fmtListVersion(status.value.listSequence) : 'not downloaded yet'}</p>
	<p class="ago">{status.value.lastSyncAt ? `Updated ${fmtAgo(status.value.lastSyncAt)}` : 'Not updated yet'}</p>
	<Button variant="secondary" onclick={syncNow} loading={syncing}><RefreshCw size={16} aria-hidden="true" />Sync now</Button>
	<p class="plan"><span class="k">Plan</span>{plan}</p>
</Card>

<style>
	:global(.list-status) {
		display: grid;
		justify-items: start;
		gap: 4px;
	}
	.ago {
		margin-bottom: 8px;
		color: var(--cl-text-muted);
	}
	.plan {
		display: grid;
		gap: 2px;
		width: 100%;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--cl-border);
		font: var(--cl-body-strong);
	}
	.k {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
</style>
