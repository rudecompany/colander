<script lang="ts">
	import { onMount } from 'svelte';
	import { PageHeader, PLAN_COPY, PLAN_FEES, PriceCard } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Heart from '@lucide/svelte/icons/heart';
	import Minus from '@lucide/svelte/icons/minus';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import SignIn from '#lib/components/SignIn.svelte';
	import InstallButton from '#lib/components/InstallButton.svelte';
	import Notice from '#lib/components/Notice.svelte';

	type Interval = 'year' | 'month';
	type Price = 'plus_yearly' | 'plus_monthly';

	let interval = $state<Interval>('year');
	let step = $state<'idle' | 'signin' | 'continue' | 'working'>('idle');
	let checkoutError = $state<{ title: string; body: string } | null>(null);
	let cancelled = $state(false);
	/** Back from sign-in or a closed checkout: checkout is the one action, not the trial. */
	let resumed = $state(false);

	const price = $derived<Price>(interval === 'year' ? 'plus_yearly' : 'plus_monthly');
	const hasPlus = $derived(!!session.account?.plan && session.account.plan.status !== 'canceled');
	const ctaLabel = $derived(
		step === 'continue' ? 'Continue to checkout' : step === 'working' ? 'Opening checkout' : `Get Plus, ${interval === 'year' ? PLAN_COPY.plus.price : PLAN_COPY.plus.monthly}`
	);

	onMount(async () => {
		const q = new URLSearchParams(location.search);
		const wanted = q.get('checkout');
		cancelled = q.has('cancelled');
		if (wanted === 'plus_monthly') interval = 'month';
		const account = await loadAccount();
		if (account && (wanted === 'plus_yearly' || wanted === 'plus_monthly')) {
			step = 'continue';
			resumed = true;
		}
	});

	async function getPlus() {
		if (step === 'working') return;
		checkoutError = null;
		if (!session.account) {
			if (session.status !== 'ready') await loadAccount();
			if (!session.account) {
				step = 'signin';
				return;
			}
		}
		step = 'working';
		try {
			const { url } = await api<{ url: string }>('/v1/billing/checkout', { method: 'POST', body: { price } });
			window.location.href = url;
		} catch (e) {
			step = 'idle';
			if (e instanceof ApiError && e.code === 'billing_unavailable') {
				checkoutError = {
					title: 'Checkout is not open yet',
					body: 'Plus goes on sale with version 1.0. Blocking, tagging, reporting and appeals stay free in the meantime, and nothing was charged.'
				};
			} else if (e instanceof ApiError && e.status === 401) {
				session.account = null;
				step = 'signin';
			} else if (e instanceof ApiError && e.code === 'already_subscribed') {
				await loadAccount();
			} else {
				checkoutError = { title: 'Checkout could not start', body: errorText(e) };
			}
		}
	}

	const compare: [string, boolean, boolean][] = [
		['Blocking on all 4 platforms', true, true],
		['All 3 strictness levels', true, true],
		['Tagging, reports and appeals', true, true],
		['Your own block and allow lists', true, true],
		['Sync across browsers', false, true],
		['Strictness per platform and per topic', false, true],
		['Keyword and hashtag rules', false, true],
		['A weekly summary', false, true],
		['Early access to new platforms', false, true]
	];

	const faq = [
		['Can I cancel any time?', 'Yes, in one click on your account page. Plus stays on until the end of the period you paid for, and you are not charged again.'],
		['Can I get a refund?', 'Yes, for any charge in the last 30 days. Choose Cancel Plus, then End now and refund, on your account page.'],
		['What happens if a payment fails?', 'Our payment provider tries again over the next few days, and Plus keeps working for 3 days past your paid period while it does. Blocking never stops.'],
		['Does paying change verdicts?', 'No. Paying or giving never changes tag weight, review priority or any verdict, and the scoring code never reads plan or payment state.'],
		['What happens to blocking if I stop paying?', 'Nothing. Blocking, tagging, reporting and appeals stay free on every platform.']
	];
</script>

<svelte:head>
	<title>Plans · Colander</title>
	<meta name="description" content="Blocking is free for good. Plus costs {PLAN_COPY.plus.short}, and paying never changes a verdict." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Plans"
		title="Blocking is free for good."
		title2="Plus adds control, never influence."
		lede="Plus pays for review staff and upkeep, so the free list keeps getting better for everyone."
	/>
</div>

<div class="cl-container page-body">
	<div class="interval">
		<SegmentedControl
			ariaLabel="Billing period"
			size="lg"
			value={interval}
			onChange={(v) => (interval = v)}
			options={[
				{ value: 'year', label: 'Yearly' },
				{ value: 'month', label: 'Monthly' }
			]}
		/>
		<!-- The plain fact sits under the Yearly segment, and only while Yearly is chosen. -->
		<p class="saves" aria-hidden={interval !== 'year'}><span class:off={interval !== 'year'}>{PLAN_COPY.plus.saves}</span><span></span></p>
	</div>

	<div class="prices">
		<PriceCard plan="free" headingLevel={2}>
			{#snippet action()}<InstallButton variant="secondary" size="xl" />{/snippet}
		</PriceCard>
		<div class="plus-col">
			<!-- One CTA everywhere, "Start 14 days free"; buying outright is the secondary action under it. -->
			<PriceCard
				plan="plus"
				billing={interval}
				headingLevel={2}
				cta={hasPlus || step === 'signin' ? undefined : resumed ? { label: ctaLabel, onclick: getPlus } : { href: '#trial' }}
				cta2={hasPlus || step === 'signin' || resumed ? undefined : { label: ctaLabel, onclick: getPlus }}
			/>
			{#if hasPlus}
				<Notice title="You have Plus."><p><a href="/account">Manage it on your account page</a>.</p></Notice>
			{:else if step === 'signin'}
				<div class="uin-card uin-card-lg uin-card-pad signin">
					<p class="cl-body">Sign in to continue. We create your account with the first sign-in.</p>
					<SignIn next="/plans?checkout={price}" block onsignedin={() => ((step = 'continue'), (resumed = true))} />
				</div>
			{:else if step === 'continue'}
				<p class="cl-body cl-muted">You are signed in as {session.account?.email}.</p>
			{/if}
			{#if checkoutError}
				<Notice title={checkoutError.title}><p>{checkoutError.body}</p></Notice>
			{:else if cancelled && !hasPlus}
				<Notice title="Checkout closed before payment"><p>Nothing was charged. You can pick up where you left off whenever you like.</p></Notice>
			{/if}
		</div>
	</div>

	<section class="trial" id="trial" aria-labelledby="trial-title">
		<h2 class="cl-title" id="trial-title">{PLAN_COPY.plus.cta}</h2>
		<p class="cl-muted">
			The trial starts in the extension, with no account and no card: open Options and choose any Plus feature. When it ends, Plus turns off
			on its own and blocking carries on.
		</p>
		<span class="trial-btn"><InstallButton variant="secondary" size="xl" block={false} /></span>
	</section>

	<section class="supporter uin-card uin-card-lg uin-card-pad" aria-labelledby="supporter-title">
		<div>
			<h2 class="cl-title" id="supporter-title">{PLAN_COPY.supporter.name}</h2>
			<p class="cl-body-lg">{PLAN_COPY.supporter.line}</p>
			<p class="cl-muted">{PLAN_COPY.supporter.detail}</p>
		</div>
		<Button variant="secondary" size="xl" href="/support"><Heart size={16} aria-hidden="true" />{PLAN_COPY.supporter.cta}</Button>
	</section>

	<div class="family">
		<span class="fam-name">{PLAN_COPY.family.name}</span>
		<span class="cl-muted">Everything in Plus for up to 5 profiles, with child profiles behind a PIN.</span>
		<span class="uin-badge uin-badge-lg">{PLAN_COPY.family.line}</span>
	</div>

	<section class="block" aria-labelledby="compare-title">
		<h2 class="cl-title" id="compare-title">Free and Plus, side by side</h2>
		<div class="table-card">
			<table class="plain grid">
				<thead><tr><th scope="col">Feature</th><th scope="col">Free</th><th scope="col">Plus</th></tr></thead>
				<tbody>
					{#each compare as [name, free, plus] (name)}
						<tr>
							<th scope="row">{name}</th>
							{#each [free, plus] as yes, i (i)}
								<td data-label={i === 0 ? 'Free' : 'Plus'}>
									<span class="cell" class:no={!yes}>
										{#if yes}<Check size={16} aria-hidden="true" /><span class="word">Included</span>{:else}<Minus size={16} aria-hidden="true" /><span class="word">Not included</span>{/if}
									</span>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="trust">{PLAN_COPY.trust}</p>
	</section>

	<section class="block" aria-labelledby="fees-title">
		<h2 class="cl-title" id="fees-title">{PLAN_FEES.title}</h2>
		<details class="fees">
			<summary>Card fees, and why yearly is preselected<ChevronDown size={16} aria-hidden="true" /></summary>
			<p class="cl-muted">{PLAN_FEES.lead}</p>
			<table class="plain stack-sm">
				<thead>
					<tr>{#each PLAN_FEES.columns as c (c)}<th scope="col">{c}</th>{/each}</tr>
				</thead>
				<tbody>
					{#each PLAN_FEES.rows as [charge, card, mor] (charge)}
						<tr><th scope="row">{charge}</th><td data-label="Card processor">{card}</td><td data-label="Merchant of record">{mor}</td></tr>
					{/each}
				</tbody>
			</table>
			<p class="cl-caption cl-muted">Rates as quoted in a 2026 payments guide. Vendors may differ.</p>
		</details>
	</section>

	<section class="block" aria-labelledby="faq-title">
		<h2 class="cl-title" id="faq-title">Questions</h2>
		<div class="faq">
			{#each faq as [q, a] (q)}
				<details>
					<summary>{q}<ChevronDown size={16} aria-hidden="true" /></summary>
					<p>{a}</p>
				</details>
			{/each}
		</div>
	</section>
</div>

<style>
	.interval {
		display: inline-grid;
		gap: 6px;
		margin-bottom: 24px;
	}
	.saves {
		display: grid;
		grid-template-columns: 1fr 1fr;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
		text-align: center;
	}
	.saves .off {
		visibility: hidden;
	}
	/* Two 6-column cards, so every block on the page shares the container's right edge. The two
	   cards share the first row and match heights; what follows the Plus card (sign-in, notices) takes
	   rows of its own under it, so it never stretches the Free card. */
	.prices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px 24px;
		align-items: start;
	}
	.plus-col {
		display: contents;
	}
	.plus-col > :global(*) {
		grid-column: 2;
	}
	.prices :global(.price) {
		height: 100%;
	}
	.signin {
		display: grid;
		gap: 16px;
	}
	.trial {
		display: grid;
		justify-items: start;
		gap: 12px;
		max-width: 720px;
		margin-top: 48px;
	}
	.supporter {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 16px 24px;
		margin-top: 48px;
	}
	.supporter > div {
		display: grid;
		gap: 4px;
	}
	.family {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		margin-top: 16px;
		padding: 16px 24px;
		border: 1px dashed var(--cl-border-strong);
		border-radius: var(--cl-r-card);
		font: var(--cl-body);
	}
	.fam-name {
		font: var(--cl-body-strong);
	}
	.family .uin-badge {
		margin-left: auto;
	}
	.block {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
		margin-top: 64px;
	}
	.grid td {
		width: 22%;
	}
	.cell {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
	}
	.cell :global(svg) {
		flex: none;
	}
	.cell.no {
		color: var(--cl-text-muted);
		font-weight: 400;
	}
	.trust {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	details {
		border-top: 1px solid var(--cl-border);
	}
	.faq details:last-child,
	.fees {
		border-bottom: 1px solid var(--cl-border);
	}
	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 56px;
		padding-block: 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary :global(svg) {
		flex: none;
		transition: transform var(--cl-fast) var(--cl-ease);
	}
	details[open] summary :global(svg) {
		transform: rotate(180deg);
	}
	details > p,
	details > table {
		max-width: 68ch;
		margin-bottom: 16px;
	}
	.faq {
		max-width: 720px;
	}
	@media (max-width: 767px) {
		.prices {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 24px;
		}
		.plus-col > :global(*) {
			grid-column: 1;
		}
	}
	@media (max-width: 639px) {
		.family .uin-badge {
			margin-left: 0;
		}
		/* Phones: the feature full width, then Free and Plus as two compact cells; the words stay for screen readers. */
		.grid thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		.grid tr {
			display: grid;
			grid-template-columns: 1fr 1fr;
			column-gap: 16px;
			padding-block: 10px;
			border-bottom: 1px solid var(--cl-border);
		}
		.grid tr:last-child {
			border-bottom: 0;
		}
		.grid th,
		.grid td {
			display: block;
			width: auto;
			padding: 0;
			border: 0;
		}
		.grid th[scope='row'] {
			grid-column: 1 / -1;
			margin-bottom: 4px;
		}
		.grid td::before {
			content: attr(data-label);
			margin-right: 8px;
			color: var(--cl-text-muted);
			font-weight: 600;
		}
		.grid td {
			display: flex;
			align-items: center;
		}
		.grid .word {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
		}
	}
</style>
