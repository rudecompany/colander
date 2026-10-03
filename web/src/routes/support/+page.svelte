<script lang="ts">
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Code from '@lucide/svelte/icons/code';
	import Heart from '@lucide/svelte/icons/heart';
	import List from '@lucide/svelte/icons/list';
	import Scale from '@lucide/svelte/icons/scale';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import { onMount } from 'svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { fmtMoney } from '@colander/shared';
	import Notice from '#lib/components/Notice.svelte';
	import { PageHeader } from '@colander/shared';


	let recurring = $state<'once' | 'monthly'>('monthly');
	let preset = $state<'300' | '500' | '1000' | 'other'>('500');
	let other = $state('');
	let creditName = $state('');
	let working = $state(false);
	let problem = $state<{ title: string; body: string } | null>(null);
	let cancelled = $state(false);

	onMount(() => (cancelled = new URLSearchParams(location.search).has('cancelled')));

	const cents = $derived(preset === 'other' ? Math.round(Number(other.replace(/[$,\s]/g, '')) * 100) : Number(preset));
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

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Support our work"
		title="Colander runs on support"
		title2="from people like you."
		lede="Blocking stays free for everyone. Gifts pay for the people who review reports and appeals, the upkeep that keeps four platforms working, and the servers that sign the lists."
	/>
</div>

<div class="cl-container page-body layout">
	<form class="uin-card uin-card-lg uin-card-pad give" onsubmit={donate} novalidate>
		<fieldset>
			<legend class="field-label">How often</legend>
			<SegmentedControl
				ariaLabel="How often"
				size="lg"
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
			<SegmentedControl
				ariaLabel="Amount"
				size="lg"
				value={preset}
				onChange={(v) => (preset = v)}
				options={[
					{ value: '300', label: '$3' },
					{ value: '500', label: '$5' },
					{ value: '1000', label: '$10' },
					{ value: 'other', label: 'Other' }
				]}
			/>
			{#if preset === 'other'}
				<div class="field other">
					<label class="field-label" for="other-amount">Amount in US dollars</label>
					<Input id="other-amount" size="lg" inputmode="decimal" placeholder="25" bind:value={other} aria-describedby="other-hint" />
					<p class="field-hint" id="other-hint">From $1 to $1,000.</p>
				</div>
			{/if}
		</fieldset>

		<div class="field">
			<label class="field-label" for="credit-name">Name for the supporters page <span class="cl-muted">(optional)</span></label>
			<Input id="credit-name" size="lg" maxlength={80} autocomplete="nickname" bind:value={creditName} aria-describedby="credit-hint" />
			<p class="field-hint" id="credit-hint">Leave it empty to give without credit. We never publish amounts.</p>
		</div>

		{#if problem}
			<Notice title={problem.title}><p>{problem.body}</p></Notice>
		{:else if cancelled}
			<Notice title="Payment closed before it finished"><p>Nothing was charged. Thank you for thinking of us.</p></Notice>
		{/if}

		<Button type="submit" variant="primary" size="xxl" block disabled={working}>
			<Heart size={16} aria-hidden="true" />
			{working ? 'Opening checkout' : valid ? `Give ${fmtMoney(cents)}${recurring === 'monthly' ? ' a month' : ''}` : 'Continue to payment'}
		</Button>
		<p class="cl-caption cl-muted">Checkout runs on our payment provider's page, which handles your payment details. We never see them.</p>
	</form>

	<div class="about">
		<section aria-labelledby="where-title">
			<h2 class="cl-title" id="where-title">Where the money goes</h2>
			<ul class="where">
				<li>
					<Scale size={16} aria-hidden="true" />
					<span><strong>Review time.</strong> Staff time to decide reports and appeals, with a goal of a median appeal within 7 days.</span>
				</li>
				<li>
					<List size={16} aria-hidden="true" />
					<span><strong>List hosting and signing.</strong> Signing and serving the lists, and running the review service.</span>
				</li>
				<li>
					<Code size={16} aria-hidden="true" />
					<span><strong>Development.</strong> Platforms change their pages often, and keeping four of them working is steady work.</span>
				</li>
			</ul>
			<ArrowLink href="/transparency">Every funding source is published on the transparency page</ArrowLink>
		</section>

		<section aria-labelledby="rules-title">
			<h2 class="cl-title" id="rules-title">What giving never does</h2>
			<p class="cl-muted">
				Giving never changes tag weight, review priority or any verdict. No creator, platform or advertiser can pay to leave a list. Support
				links never appear on source or appeal pages, so no creator is asked for money while their case is open.
			</p>
		</section>
	</div>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px 48px;
		align-items: start;
	}
	.give {
		display: grid;
		gap: 24px;
	}
	fieldset {
		display: grid;
		gap: 8px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 8px;
		padding: 0;
	}
	fieldset > :global(.uin-seg) {
		width: 100%;
	}
	.other {
		margin-top: 8px;
	}
	.about {
		display: grid;
		gap: 48px;
		padding-top: 8px;
	}
	.about section {
		display: grid;
		justify-items: start;
		gap: 16px;
	}
	.where {
		display: grid;
		gap: 16px;
		list-style: none;
	}
	.where li {
		display: grid;
		grid-template-columns: 16px 1fr;
		gap: 12px;
		font: var(--cl-body-lg);
	}
	.where :global(svg) {
		margin-top: 4px;
	}
	.where strong {
		font-weight: 600;
	}
	@media (max-width: 1023px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
