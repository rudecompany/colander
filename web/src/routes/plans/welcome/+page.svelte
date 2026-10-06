<script lang="ts">
	import { onMount } from 'svelte';
	import type { Account } from '@colander/shared/api';
	import { PLAN_COPY, fmtDate } from '@colander/shared';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import ConnectBrowser from '#lib/components/ConnectBrowser.svelte';
	import SignIn from '#lib/components/SignIn.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { PageHeader } from '@colander/shared';

	// Stripe sends people here as soon as they pay; the webhook that turns Plus on can take a few
	// seconds more, so the page checks the account until the plan shows up.
	const POLL_MS = 2000;
	const GIVE_UP_MS = 60_000;

	let phase = $state<'confirming' | 'ready' | 'slow' | 'signed_out'>('confirming');

	const plan = $derived(session.account?.plan && session.account.plan.status !== 'canceled' ? session.account.plan : null);
	const live = (a: Account | null) => !!a?.plan && a.plan.status !== 'canceled';

	let stopped = false;

	/** Checks the account until Plus shows up, the person turns out signed out, or a minute passes. */
	async function watch() {
		phase = 'confirming';
		const giveUp = Date.now() + GIVE_UP_MS;
		while (!stopped) {
			const account = await loadAccount();
			if (stopped) return;
			if (live(account)) {
				phase = 'ready';
				return;
			}
			if (!account && session.status === 'ready') {
				phase = 'signed_out';
				return;
			}
			if (Date.now() > giveUp) {
				phase = 'slow';
				return;
			}
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
	}

	onMount(() => {
		watch();
		return () => (stopped = true);
	});
</script>

<svelte:head>
	<title>Welcome to Plus · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<!-- Signed out, this is the same centered sign-in card as /account, /console and /auth. -->
{#if phase === 'signed_out'}
	<AuthCard
		eyebrow="Plus"
		title="Sign in to finish"
		lede="Your payment went through. Sign in with the email you used at checkout to connect Plus to your browsers."
	>
		<SignIn next="/plans/welcome" block onsignedin={watch} />
	</AuthCard>
{:else}
<div class="cl-container page-top">
	<PageHeader
		eyebrow="Plus"
		title={phase === 'ready' ? 'Thank you, Plus is on' : 'Thank you for getting Plus'}
		lede="Your support pays for review and upkeep, so the free list keeps getting better for everyone."
	/>
</div>

<div class="cl-container page-body col">
	{#if phase === 'confirming'}
		<Loading label="Confirming your payment" />
	{:else if phase === 'slow'}
		<Notice title="Your payment is still being confirmed">
			<p>This can take a minute. Nothing more is needed from you. Check your <a href="/account">account page</a> shortly to connect your browsers.</p>
		</Notice>
	{:else if plan}
		<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="plan-title">
			<h2 class="cl-title" id="plan-title">Your plan</h2>
			<p class="cl-body-lg"><strong>Plus.</strong> {PLAN_COPY.plus.billed[plan.interval]}.</p>
			<p class="cl-body">Renews on {fmtDate(plan.current_period_end)}. You can cancel any time in one click on your <a href="/account">account page</a>.</p>
		</section>

		<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="connect-title">
			<h2 class="cl-title" id="connect-title">Connect a browser</h2>
			<p class="cl-body cl-muted">
				Colander checks your plan on your device with a signed token. Connect each browser you use once with a code, here or from
				your account page, and Plus features turn on there.
			</p>
			<ConnectBrowser kind="plan" />
			<p class="cl-caption cl-muted">A code works in any browser, also on another computer: type it there in Colander's Options, under Plan.</p>
		</section>
	{/if}
</div>
{/if}

<style>
	.col {
		display: grid;
		gap: 24px;
		justify-items: stretch;
	}
	.col > :global(*) {
		max-width: 720px;
	}
	.col > :global(.loading) {
		justify-self: start;
	}
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
</style>
