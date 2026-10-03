<script lang="ts">
	import { onMount } from 'svelte';
	import type { Account } from '@colander/shared/api';
	import { detectExtension, type ExtensionState } from '#lib/extension.ts';
	import { fmtDate } from '#lib/format.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import ConnectBrowser from '#lib/components/ConnectBrowser.svelte';
	import EmailSignIn from '#lib/components/EmailSignIn.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

	// Stripe sends people here as soon as they pay; the webhook that turns Plus on can take a few
	// seconds more, so the page checks the account until the plan shows up.
	const POLL_MS = 2000;
	const GIVE_UP_MS = 60_000;

	let ext = $state<ExtensionState>({ kind: 'checking' });
	let phase = $state<'confirming' | 'ready' | 'slow' | 'signed_out'>('confirming');

	const plan = $derived(session.account?.plan && session.account.plan.status !== 'canceled' ? session.account.plan : null);
	const live = (a: Account | null) => !!a?.plan && a.plan.status !== 'canceled';

	onMount(() => {
		let stopped = false;
		detectExtension().then((state) => (ext = state));
		(async () => {
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
		})();
		return () => (stopped = true);
	});

	async function checkExtension() {
		ext = { kind: 'checking' };
		ext = await detectExtension();
	}
</script>

<svelte:head>
	<title>Welcome to Plus · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<PageHead
	eyebrow="Plus"
	title={phase === 'ready' ? 'Thank you, Plus is on' : 'Thank you for getting Plus'}
	lede="Your support pays for review and upkeep, so the free list keeps getting better for everyone."
	narrow
/>

<div class="wrap wrap-narrow page">
	{#if phase === 'confirming'}
		<Loading label="Confirming your payment" />
	{:else if phase === 'signed_out'}
		<Notice title="Sign in to finish">
			<p>Your payment went through. Sign in with the email you used at checkout to connect Plus to this browser.</p>
		</Notice>
		<div class="card signin-card"><EmailSignIn next="/plans/welcome" /></div>
	{:else if phase === 'slow'}
		<Notice title="Your payment is still being confirmed">
			<p>This can take a minute. Nothing more is needed from you. Check your <a href="/account">account page</a> shortly to connect this browser.</p>
		</Notice>
	{:else if plan}
		<section class="card section-card" aria-labelledby="plan-title">
			<h2 class="t-title" id="plan-title">Your plan</h2>
			<p class="t-body-lg"><strong>Plus</strong>, billed {plan.interval === 'year' ? 'yearly at $30' : 'monthly at $3'}.</p>
			<p class="t-body">Renews on {fmtDate(plan.current_period_end)}. You can cancel any time in one click on your <a href="/account">account page</a>.</p>
		</section>

		<section class="card section-card" aria-labelledby="connect-title">
			<h2 class="t-title" id="connect-title">Connect this browser</h2>
			<p class="t-body muted">
				Colander checks your plan on your device with a signed token. Connect each browser you use once, here or from your
				account page, and Plus features turn on there.
			</p>
			<ConnectBrowser {ext} canConnect onrecheck={checkExtension} />
			<p class="t-caption muted">On another computer, sign in on the account page there and choose Connect this browser.</p>
		</section>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--cl-s4);
		padding-top: var(--cl-s6);
		justify-items: stretch;
	}
	.page > :global(.loading) {
		justify-self: start;
	}
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
	.signin-card {
		max-width: 520px;
	}
</style>
