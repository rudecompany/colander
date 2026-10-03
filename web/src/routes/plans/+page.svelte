<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Check from '@lucide/svelte/icons/check';
	import Heart from '@lucide/svelte/icons/heart';
	import Plus from '@lucide/svelte/icons/plus';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import EmailSignIn from '#lib/components/EmailSignIn.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

	type Interval = 'year' | 'month';
	type Price = 'plus_yearly' | 'plus_monthly';

	let interval = $state<Interval>('year');
	let step = $state<'idle' | 'signin' | 'continue' | 'working'>('idle');
	let checkoutError = $state<{ title: string; body: string } | null>(null);
	let cancelled = $state(false);

	const price = $derived<Price>(interval === 'year' ? 'plus_yearly' : 'plus_monthly');
	const hasPlus = $derived(!!session.account?.plan && session.account.plan.status !== 'canceled');

	onMount(async () => {
		const q = new URLSearchParams(location.search);
		const wanted = q.get('checkout');
		cancelled = q.has('cancelled');
		if (wanted === 'plus_monthly') interval = 'month';
		const account = await loadAccount();
		if (account && (wanted === 'plus_yearly' || wanted === 'plus_monthly')) step = 'continue';
	});

	async function getPlus() {
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

	const free = [
		'Blocking on every supported platform with the core list',
		'All four strictness levels',
		'Tagging, reporting and appeals',
		'Personal block and allow lists',
		'Third-party lists, once they ship in 1.1'
	];
	const plus = [
		'Everything in Free',
		'Sync across browsers',
		'Strictness per platform and per topic',
		'Keyword and hashtag rules',
		'A weekly summary',
		'Early access to new platforms'
	];
	const family = ['Everything in Plus for up to 5 profiles', 'Child profiles with a PIN lock', 'A shared family list'];

	const rules = [
		'Free blocking is never reduced to push upgrades.',
		'Paying or donating never changes tag weight, review priority or any verdict.',
		'No creator, platform or advertiser can pay to leave a list or join an allowlist.',
		'No ads, no affiliate links, and no sale or sharing of user data.',
		'Every funding source is published.'
	];
</script>

<svelte:head>
	<title>Plans · Colander</title>
	<meta name="description" content="Blocking is free for good. Plus costs $3 a month or $30 a year, and paying never changes a verdict." />
</svelte:head>

<PageHead
	eyebrow="Plans"
	title="Blocking is free for good"
	lede="Paying buys convenience and control, never influence. Plus pays for review staff and upkeep, so the free list keeps getting better for everyone."
/>

<div class="wrap page">
	<div class="interval">
		<SegmentedControl
			ariaLabel="Billing interval"
			value={interval}
			onChange={(v) => (interval = v)}
			options={[
				{ value: 'year', label: 'Yearly' },
				{ value: 'month', label: 'Monthly' }
			]}
		/>
		<p class="t-body muted">{interval === 'year' ? 'Yearly saves $6, and less of it goes to card fees.' : 'Fixed card fees take a larger share of a monthly charge.'}</p>
	</div>

	<div class="plans">
		<article class="plan card">
			<h2 class="t-title">Free</h2>
			<p class="price"><span class="amount">$0</span></p>
			<p class="t-body muted">For everyone, with no account.</p>
			<ul class="features">
				{#each free as f (f)}<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>{f}</span></li>{/each}
			</ul>
			<a class="uin-btn uin-btn-outline btn-lg cta" href={PUBLIC_STORE_URL}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add to Chrome</a>
		</article>

		<article class="plan card featured" aria-labelledby="plus-title">
			<h2 class="t-title" id="plus-title">Plus</h2>
			<p class="price">
				{#if interval === 'year'}
					<span class="amount">$30</span> a year
				{:else}
					<span class="amount">$3</span> a month
				{/if}
			</p>
			<p class="t-body muted">{interval === 'year' ? 'Or $3 a month.' : 'Or $30 a year.'} Try it free for 14 days from the extension, with no card.</p>
			<ul class="features">
				{#each plus as f (f)}<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>{f}</span></li>{/each}
			</ul>
			<div class="cta-area">
				{#if hasPlus}
					<p class="t-body">You have Plus. <a href="/account">Manage it on your account page</a>.</p>
				{:else if step === 'signin'}
					<p class="t-body">Sign in to continue. We create your account with the first sign-in.</p>
					<EmailSignIn next="/plans?checkout={price}" submitLabel="Email me a link to continue" />
				{:else if step === 'continue'}
					<p class="t-body">You are signed in as {session.account?.email}.</p>
					<button type="button" class="uin-btn uin-btn-primary btn-lg cta" onclick={getPlus}>Continue to checkout <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
				{:else}
					<button type="button" class="uin-btn uin-btn-primary btn-lg cta" onclick={getPlus} disabled={step === 'working'}>
						{step === 'working' ? 'Opening checkout' : `Get Plus, ${interval === 'year' ? '$30 a year' : '$3 a month'}`}
					</button>
				{/if}
				{#if checkoutError}
					<Notice title={checkoutError.title}><p>{checkoutError.body}</p></Notice>
				{:else if cancelled && !hasPlus}
					<Notice title="Checkout closed before payment"><p>Nothing was charged. You can pick up where you left off whenever you like.</p></Notice>
				{/if}
			</div>
		</article>

		<article class="plan card muted-plan">
			<h2 class="t-title">Family <span class="soon">Coming in 1.1</span></h2>
			<p class="price">
				{#if interval === 'year'}
					<span class="amount">$60</span> a year
				{:else}
					<span class="amount">$6</span> a month
				{/if}
			</p>
			<p class="t-body muted">For guardians who want a locked strict profile for children.</p>
			<ul class="features">
				{#each family as f (f)}<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>{f}</span></li>{/each}
			</ul>
			<button type="button" class="uin-btn uin-btn-outline btn-lg cta" disabled>Not available yet</button>
		</article>

		<article class="plan card">
			<h2 class="t-title">Supporter</h2>
			<p class="price"><span class="amount">Any amount</span></p>
			<p class="t-body muted">Once or monthly. No extra features, just more review time and upkeep for everyone.</p>
			<ul class="features">
				<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>Optional credit on the supporters page</span></li>
				<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>Suggested $3, $5 or $10</span></li>
			</ul>
			<a class="uin-btn uin-btn-outline btn-lg cta" href="/support"><Heart size={16} strokeWidth={1.75} aria-hidden="true" /> Support our work</a>
		</article>
	</div>

	<div class="below">
		<section aria-labelledby="fees-title">
			<h2 class="t-title" id="fees-title">Why yearly is preselected</h2>
			<p class="t-body muted">
				Card payments carry a fixed fee per charge, so a fifth of a $3 monthly charge can go to fees. Checkout runs through
				a merchant of record, which handles sales tax and VAT in every country.
			</p>
			<div class="table-scroll">
				<table class="plain fees stack-sm">
					<thead>
						<tr>
							<th scope="col">Charge</th>
							<th scope="col">Card processor<span class="sub">About 2.9% + $0.30</span></th>
							<th scope="col">Merchant of record<span class="sub">About 5% + $0.50</span></th>
						</tr>
					</thead>
					<tbody>
						<tr><th scope="row">$3 monthly</th><td class="cl-num" data-label="Card processor">$0.39, or 13%</td><td class="cl-num" data-label="Merchant of record">$0.65, or 22%</td></tr>
						<tr><th scope="row">$30 yearly</th><td class="cl-num" data-label="Card processor">$1.17, or 3.9%</td><td class="cl-num" data-label="Merchant of record">$2.00, or 6.7%</td></tr>
						<tr><th scope="row">$60 yearly</th><td class="cl-num" data-label="Card processor">$2.04, or 3.4%</td><td class="cl-num" data-label="Merchant of record">$3.50, or 5.8%</td></tr>
					</tbody>
				</table>
			</div>
			<p class="t-caption muted">Rates as quoted in a 2026 payments guide. Vendors may differ.</p>
		</section>

		<section aria-labelledby="rules-title" id="independence">
			<h2 class="t-title" id="rules-title">Independence rules</h2>
			<ol class="rules">
				{#each rules as r, i (r)}<li><span class="n cl-num" aria-hidden="true">{i + 1}</span><span>{r}</span></li>{/each}
			</ol>
		</section>

		<section aria-labelledby="faq-title" class="faq">
			<h2 class="t-title" id="faq-title">Questions</h2>
			<dl>
				<div>
					<dt>Can I cancel?</dt>
					<dd>Yes, in one click on your account page. Plus stays on until the end of the period you paid for.</dd>
				</div>
				<div>
					<dt>Can I get a refund?</dt>
					<dd>Yes, for any charge in the last 30 days. Choose Cancel and refund on your account page.</dd>
				</div>
				<div>
					<dt>What happens to blocking if I stop paying?</dt>
					<dd>Nothing. Blocking, tagging, reporting and appeals stay free on every platform.</dd>
				</div>
				<div>
					<dt>How does the extension know I have Plus?</dt>
					<dd>It stores a signed plan token, checked on your device. Connect a browser from your account page.</dd>
				</div>
			</dl>
		</section>
	</div>
</div>

<style>
	.page {
		padding-top: var(--cl-s6);
	}
	.interval {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cl-s3) var(--cl-s4);
		margin-bottom: var(--cl-s5);
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--cl-s4);
		align-items: stretch;
	}
	.plan {
		display: flex;
		flex-direction: column;
		gap: var(--cl-s3);
	}
	.featured {
		border: 2px solid var(--cl-text);
		padding: calc(var(--cl-s5) - 1px);
	}
	.price {
		font: 400 16px/24px var(--cl-font);
		min-height: 40px;
	}
	.amount {
		font: var(--cl-display);
		margin-right: 4px;
	}
	.features {
		list-style: none;
		display: grid;
		gap: var(--cl-s2);
		font: var(--cl-body);
		padding-top: var(--cl-s3);
		border-top: 1px solid var(--cl-border);
		margin-bottom: var(--cl-s3);
	}
	.features li {
		display: flex;
		gap: 8px;
	}
	.features :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.cta,
	.cta-area {
		margin-top: auto;
	}
	.cta-area {
		display: grid;
		gap: var(--cl-s3);
	}
	.cta {
		width: 100%;
	}
	.muted-plan .price,
	.muted-plan .features {
		color: var(--cl-text-muted);
	}
	.soon {
		display: inline-block;
		vertical-align: middle;
		margin-left: 6px;
		padding: 1px 7px;
		border-radius: var(--cl-r-chip);
		border: 1px solid var(--w-control-border);
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}
	.below {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--cl-s6) 64px;
		margin-top: 64px;
	}
	.below section {
		display: grid;
		gap: var(--cl-s3);
		align-content: start;
	}
	.fees .sub {
		display: block;
		font-weight: 400;
	}
	@media (min-width: 1081px) {
		.plan > .t-body.muted {
			min-height: 60px;
		}
	}
	.fees th[scope='row'] {
		color: var(--cl-text);
		white-space: nowrap;
	}
	.rules {
		list-style: none;
		display: grid;
		gap: var(--cl-s3);
		font: var(--cl-body-lg);
	}
	.rules li {
		display: flex;
		gap: var(--cl-s3);
	}
	.n {
		flex: none;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 1.5px solid var(--cl-text);
		font: 700 12px/1 var(--cl-font);
	}
	.faq {
		grid-column: 1 / -1;
	}
	.faq dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--cl-s4) 64px;
	}
	.faq dt {
		font: 600 16px/24px var(--cl-font);
	}
	.faq dd {
		margin-top: 4px;
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	@media (max-width: 1080px) {
		.plans {
			grid-template-columns: 1fr 1fr;
		}
	}
	@media (max-width: 760px) {
		.below,
		.faq dl {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 600px) {
		.plans {
			grid-template-columns: 1fr;
		}
	}
</style>
