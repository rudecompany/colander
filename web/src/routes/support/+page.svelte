<script lang="ts">
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import Heart from '@lucide/svelte/icons/heart';
	import { onMount } from 'svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { fmtMoney } from '#lib/format.ts';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

	const SUGGESTED = [300, 500, 1000];

	let recurring = $state<'once' | 'monthly'>('monthly');
	let preset = $state<number | 'other'>(500);
	let other = $state('');
	let creditName = $state('');
	let working = $state(false);
	let problem = $state<{ title: string; body: string } | null>(null);
	let cancelled = $state(false);

	onMount(() => (cancelled = new URLSearchParams(location.search).has('cancelled')));

	const cents = $derived(preset === 'other' ? Math.round(Number(other.replace(/[$,\s]/g, '')) * 100) : preset);
	const valid = $derived(Number.isFinite(cents) && cents >= 100 && cents <= 100000);

	async function donate(event: SubmitEvent) {
		event.preventDefault();
		problem = null;
		if (!valid) {
			problem = { title: 'Choose an amount', body: 'Any amount from $1 to $1,000 works.' };
			return;
		}
		working = true;
		try {
			const { url } = await api<{ url: string }>('/v1/billing/donate', {
				method: 'POST',
				body: { amount_cents: cents, recurring: recurring === 'monthly', ...(creditName.trim() ? { credit_name: creditName.trim() } : {}) }
			});
			window.location.href = url;
		} catch (e) {
			working = false;
			problem =
				e instanceof ApiError && e.code === 'billing_unavailable'
					? { title: 'Donations are not open yet', body: 'Payments are switched off right now, so nothing was charged. Please come back soon.' }
					: { title: 'Payment could not start', body: errorText(e) };
		}
	}
</script>

<svelte:head>
	<title>Support our work · Colander</title>
	<meta name="description" content="Support our work, once or monthly, and keep Colander's free list reviewed and fair." />
</svelte:head>

<PageHead
	eyebrow="Support our work"
	title="Colander runs on support from people like you"
	lede="Blocking stays free for everyone. Donations pay for the people who review reports and appeals, the upkeep that keeps four platforms working, and the servers that sign the lists."
/>

<div class="wrap page">
	<form class="card give" onsubmit={donate} novalidate>
		<fieldset>
			<legend class="field-label">How often</legend>
			<SegmentedControl
				ariaLabel="How often"
				value={recurring}
				onChange={(v) => (recurring = v)}
				options={[
					{ value: 'monthly', label: 'Monthly' },
					{ value: 'once', label: 'Once' }
				]}
			/>
		</fieldset>

		<fieldset>
			<legend class="field-label">Amount</legend>
			<div class="amounts">
				{#each [...SUGGESTED, 'other' as const] as a (a)}
					<label class="amount" class:on={preset === a}>
						<input type="radio" name="amount" value={a} bind:group={preset} />
						<span class="cl-num">{a === 'other' ? 'Other' : fmtMoney(a)}</span>
					</label>
				{/each}
			</div>
			{#if preset === 'other'}
				<div class="field other">
					<label class="field-label" for="other-amount">Amount in US dollars</label>
					<Input id="other-amount" inputmode="decimal" placeholder="25" bind:value={other} aria-describedby="other-hint" />
					<p class="field-hint" id="other-hint">From $1 to $1,000.</p>
				</div>
			{/if}
		</fieldset>

		<div class="field">
			<label class="field-label" for="credit-name">Name for the supporters page <span class="muted">(optional)</span></label>
			<Input id="credit-name" maxlength={80} autocomplete="nickname" bind:value={creditName} aria-describedby="credit-hint" />
			<p class="field-hint" id="credit-hint">Leave it empty to give without credit. We never publish amounts.</p>
		</div>

		{#if problem}
			<Notice title={problem.title}><p>{problem.body}</p></Notice>
		{:else if cancelled}
			<Notice title="Payment closed before it finished"><p>Nothing was charged. Thank you for thinking of us.</p></Notice>
		{/if}

		<button type="submit" class="uin-btn uin-btn-primary btn-lg submit" disabled={working}>
			<Heart size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>
				{working
					? 'Opening checkout'
					: valid
						? `Give ${fmtMoney(cents)}${recurring === 'monthly' ? ' a month' : ''}`
						: 'Continue to payment'}
			</span>
		</button>
		<p class="t-caption muted">Checkout runs on our payment provider's page, which handles your payment details. We never see them.</p>
	</form>

	<div class="about">
		<section aria-labelledby="where-title">
			<h2 class="t-title" id="where-title">Where the money goes</h2>
			<ul class="where">
				<li><strong>Review.</strong> Staff time to decide reports and appeals, with a goal of a median appeal within 7 days.</li>
				<li><strong>Upkeep.</strong> Platforms change their pages often. Keeping four adapters working is steady work.</li>
				<li><strong>Infrastructure.</strong> Signing and serving the lists, and running the review service.</li>
			</ul>
			<p class="t-body muted">
				A yearly report publishes income by source and spending by category, on the <a href="/transparency">transparency page</a>.
			</p>
		</section>

		<section aria-labelledby="rules-title">
			<h2 class="t-title" id="rules-title">What giving never does</h2>
			<p class="t-body muted">
				Donating never changes tag weight, review priority or any verdict. No creator, platform or advertiser can pay to
				leave a list. Support links never appear on source or appeal pages, so no creator is asked for money while their
				case is open.
			</p>
		</section>

		<section aria-labelledby="other-title">
			<h2 class="t-title" id="other-title">Other ways to give</h2>
			<p class="t-body muted">
				Once the code is published, two more routes open. GitHub Sponsors takes no fee on sponsorships from personal
				accounts. Open Collective shows a public budget, and its open-source fiscal host takes about 10%. We will link both
				here when they are ready.
			</p>
		</section>
	</div>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 480px) minmax(0, 1fr);
		gap: 64px;
		align-items: start;
		padding-top: var(--cl-s6);
	}
	.give {
		display: grid;
		gap: var(--cl-s5);
	}
	fieldset {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--cl-s2);
		min-width: 0;
	}
	legend {
		padding: 0;
		margin-bottom: var(--cl-s2);
	}
	fieldset > :global(.uin-seg) {
		justify-self: start;
	}
	.amounts {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--cl-s2);
	}
	.amount {
		position: relative;
		display: grid;
		place-items: center;
		height: 48px;
		border-radius: var(--cl-r-chip);
		border: 1px solid var(--w-control-border);
		background: var(--cl-surface);
		font: 700 16px/24px var(--cl-font);
		cursor: pointer;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.amount input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.amount:has(input:focus-visible) {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	.amount:hover {
		background: var(--w-ink-soft);
	}
	.amount.on {
		background: var(--cl-brand);
		border-color: var(--cl-brand);
		color: var(--cl-brand-fg);
	}
	.other {
		margin-top: var(--cl-s2);
	}
	.submit {
		width: 100%;
	}
	.about {
		display: grid;
		gap: var(--cl-s6);
	}
	.about section {
		display: grid;
		gap: var(--cl-s3);
	}
	.where {
		list-style: none;
		display: grid;
		gap: var(--cl-s3);
		font: var(--cl-body-lg);
	}
	.where li {
		padding-left: var(--cl-s4);
		border-left: 2px solid var(--cl-border);
	}
	.where strong {
		font-weight: 600;
	}
	@media (max-width: 900px) {
		.page {
			grid-template-columns: 1fr;
			gap: var(--cl-s6);
		}
	}
	@media (max-width: 420px) {
		.amounts {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
