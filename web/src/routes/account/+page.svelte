<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import type { Account, Plan } from '@colander/shared/api';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { detectExtension, sendToExtension, type ExtensionState } from '#lib/extension.ts';
	import { fmtDate } from '#lib/format.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import EmailSignIn from '#lib/components/EmailSignIn.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

	let ext = $state<ExtensionState>({ kind: 'checking' });
	let displayName = $state('');
	let nameStatus = $state<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' });
	let confirm = $state<null | 'cancel' | 'refund'>(null);
	let billing = $state<{ kind: 'idle' | 'working' } | { kind: 'error'; message: string } | { kind: 'done'; message: string }>({ kind: 'idle' });
	let connect = $state<{ kind: 'idle' | 'working' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' });
	let reviewer = $state<{ kind: 'idle' | 'working' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' });

	const account = $derived(session.account);

	onMount(async () => {
		const a = await loadAccount();
		displayName = a?.display_name ?? '';
		ext = await detectExtension();
	});

	async function checkExtension() {
		ext = { kind: 'checking' };
		ext = await detectExtension();
	}

	async function saveName(event: SubmitEvent) {
		event.preventDefault();
		nameStatus = { kind: 'saving' };
		try {
			const res = await api<{ account: Account }>('/v1/account', { method: 'PATCH', body: { display_name: displayName.trim() } });
			session.account = res.account;
			nameStatus = { kind: 'saved' };
		} catch (e) {
			nameStatus = { kind: 'error', message: errorText(e) };
		}
	}

	async function signOut() {
		try {
			await api('/v1/auth/logout', { method: 'POST' });
		} finally {
			session.account = null;
		}
	}

	async function cancelPlan(refund: boolean) {
		billing = { kind: 'working' };
		try {
			await api('/v1/billing/cancel', { method: 'POST', body: { refund } });
			await loadAccount();
			confirm = null;
			billing = {
				kind: 'done',
				message: refund ? 'Plus has ended and your last charge is being refunded.' : 'Cancelled. Plus stays on until the end of the period you paid for.'
			};
		} catch (e) {
			billing = {
				kind: 'error',
				message:
					e instanceof ApiError && e.code === 'billing_unavailable'
						? 'Billing is not available right now, so nothing was changed. Please try again later.'
						: errorText(e)
			};
		}
	}

	async function connectBrowser() {
		connect = { kind: 'working' };
		try {
			const { token } = await api<{ token: string }>('/v1/entitlement', { method: 'POST' });
			await sendToExtension({ type: 'colander:plan-token', token });
			connect = { kind: 'done', message: 'Connected. Plus features are on in this browser.' };
		} catch (e) {
			connect = {
				kind: 'error',
				message:
					e instanceof ApiError
						? e.code === 'no_plan'
							? 'There is no active plan on this account to connect.'
							: e.message
						: 'Colander did not answer. Make sure it is installed and turned on in this browser, then try again.'
			};
		}
	}

	async function connectReviewer() {
		reviewer = { kind: 'working' };
		try {
			const { token } = await api<{ token: string }>('/v1/account/reviewer-token', { method: 'POST' });
			await sendToExtension({ type: 'colander:reviewer-token', token });
			reviewer = { kind: 'done', message: 'Connected. The side panel can now open the review queue. Any earlier token stopped working.' };
		} catch (e) {
			reviewer = {
				kind: 'error',
				message: e instanceof ApiError ? e.message : 'Colander did not answer. Make sure it is installed in this browser, then try again.'
			};
		}
	}

	const PLAN_STATUS: Record<Plan['status'], string> = {
		active: 'Active',
		trialing: 'Trial',
		past_due: 'Payment due',
		canceled: 'Ended'
	};

	const ROLE_WORD = { member: 'Member', curator: 'Curator', staff: 'Staff' } as const;
	const livePlan = $derived(account?.plan && account.plan.status !== 'canceled' ? account.plan : null);
</script>

<svelte:head>
	<title>Account · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if session.status === 'idle' || session.status === 'loading'}
	<PageHead eyebrow="Account" title="Your account" narrow />
	<div class="wrap wrap-narrow"><Loading label="Checking whether you are signed in" /></div>
{:else if !account}
	<PageHead
		eyebrow="Account"
		title="Sign in"
		lede="Colander needs no account to block, tag, report or appeal. Sign in to manage Plus, connect a browser to your plan, or review."
		narrow
	/>
	<div class="wrap wrap-narrow page">
		{#if session.status === 'error'}
			<Notice tone="error" title="We could not check your session"><p>Colander may be busy. Try again in a moment.</p></Notice>
		{/if}
		<div class="card signin-card">
			<EmailSignIn next="/account" />
		</div>
	</div>
{:else}
	<PageHead eyebrow="Account" title={account.display_name ? `Hello, ${account.display_name}` : 'Your account'} narrow>
		<div class="whoami">
			<p class="t-body muted">Signed in as <strong>{account.email}</strong>{account.role !== 'member' ? ` · ${ROLE_WORD[account.role]}` : ''}</p>
			<button type="button" class="uin-btn uin-btn-ghost uin-btn-md" onclick={signOut}>
				<LogOut size={16} strokeWidth={1.75} aria-hidden="true" /> Sign out
			</button>
		</div>
	</PageHead>

	<div class="wrap wrap-narrow page">
		<section class="card section-card" aria-labelledby="plan-title">
			<div class="section-top">
				<h2 class="t-title" id="plan-title">Plan</h2>
				{#if account.plan}<span class="tag">{PLAN_STATUS[account.plan.status]}</span>{/if}
			</div>
			{#if !account.plan || account.plan.status === 'canceled'}
				<p class="t-body-lg"><strong>Free.</strong> Blocking, tagging, reporting and appeals on every platform, for good.</p>
				<p class="t-body muted">Plus adds sync across browsers, strictness per platform and topic, keyword and hashtag rules, and a weekly summary.</p>
				<p><a class="uin-btn uin-btn-primary uin-btn-md" href="/plans">See Plus</a></p>
			{:else}
				{@const plan = account.plan}
				<p class="t-body-lg"><strong>Plus</strong>, billed {plan.interval === 'year' ? 'yearly at $30' : 'monthly at $3'}.</p>
				<p class="t-body">
					{#if plan.status === 'trialing'}
						Your trial runs until {fmtDate(plan.current_period_end)}. No card is needed for the trial.
					{:else if plan.cancel_at_period_end}
						Cancelled. Plus stays on until {fmtDate(plan.current_period_end)}, and you will not be charged again.
					{:else if plan.status === 'past_due'}
						Your last payment did not go through. Plus stays on for 3 days of grace while the payment is retried.
					{:else}
						Renews on {fmtDate(plan.current_period_end)}.
					{/if}
				</p>

				{#if !plan.cancel_at_period_end}
					{#if confirm === null}
						<div class="row">
							<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={() => (confirm = 'cancel')}>Cancel</button>
							{#if plan.refundable}
								<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={() => (confirm = 'refund')}>Cancel and refund</button>
							{/if}
						</div>
					{:else}
						<div class="confirm" role="group" aria-labelledby="confirm-text">
							<p id="confirm-text" class="t-body">
								{confirm === 'refund'
									? 'Plus ends now and your last charge is refunded to the card you paid with.'
									: `Plus stays on until ${fmtDate(plan.current_period_end)}, and you will not be charged again.`}
							</p>
							<div class="row">
								<button type="button" class="uin-btn uin-btn-primary uin-btn-md" disabled={billing.kind === 'working'} onclick={() => cancelPlan(confirm === 'refund')}>
									{confirm === 'refund' ? 'Cancel and refund' : 'Cancel Plus'}
								</button>
								<button type="button" class="uin-btn uin-btn-ghost uin-btn-md" onclick={() => (confirm = null)}>Keep Plus</button>
							</div>
						</div>
					{/if}
				{/if}
			{/if}
			{#if billing.kind === 'error'}<Notice tone="error" title="Nothing was changed"><p>{billing.message}</p></Notice>{/if}
			{#if billing.kind === 'done'}<Notice tone="success" title={billing.message} />{/if}
		</section>

		<section class="card section-card" aria-labelledby="connect-title">
			<h2 class="t-title" id="connect-title">Connect this browser</h2>
			<p class="t-body muted">Sends a signed plan token to the extension, so Plus works here. Nothing else about your account is shared with it.</p>
			{#if ext.kind === 'checking'}
				<Loading label="Looking for Colander in this browser" />
			{:else if ext.kind === 'not_chrome'}
				<Notice title="This browser is not Chrome">
					<p>Colander runs in Chrome on desktop. Open this page in Chrome, with Colander installed, to connect it.</p>
				</Notice>
			{:else if ext.kind === 'missing'}
				<Notice title="Colander is not installed in this browser">
					<p>Add it from the Chrome Web Store, then come back to this page.</p>
				</Notice>
				<div class="row">
					<a class="uin-btn uin-btn-primary uin-btn-md" href={PUBLIC_STORE_URL}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add to Chrome</a>
					<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={checkExtension}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Check again</button>
				</div>
			{:else}
				<p class="t-body">Colander {ext.version} is installed here.</p>
				{#if livePlan}
					<div class="row">
						<button type="button" class="uin-btn uin-btn-primary uin-btn-md" onclick={connectBrowser} disabled={connect.kind === 'working'}>
							<Plug size={16} strokeWidth={1.75} aria-hidden="true" /> {connect.kind === 'working' ? 'Connecting' : 'Connect this browser'}
						</button>
					</div>
				{:else}
					<p class="t-body muted">Once you have Plus, connect this browser here.</p>
				{/if}
			{/if}
			{#if connect.kind === 'done'}<Notice tone="success" title={connect.message} />{/if}
			{#if connect.kind === 'error'}<Notice tone="error" title="Not connected"><p>{connect.message}</p></Notice>{/if}
		</section>

		{#if account.role !== 'member'}
			<section class="card section-card" aria-labelledby="review-title">
				<h2 class="t-title" id="review-title">Review</h2>
				<p class="t-body muted">
					You are a {account.role === 'staff' ? 'staff member' : 'curator'}.
					{account.role === 'staff'
						? 'You can decide any source and resolve appeals.'
						: 'You can decide items and sources that are not large. Large sources and appeals need staff.'}
				</p>
				<div class="row">
					<a class="uin-btn uin-btn-primary uin-btn-md" href="/console"><ListChecks size={16} strokeWidth={1.75} aria-hidden="true" /> Open the review console</a>
					{#if ext.kind === 'installed'}
						<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={connectReviewer} disabled={reviewer.kind === 'working'}>
							<Plug size={16} strokeWidth={1.75} aria-hidden="true" /> Connect the review side panel
						</button>
					{/if}
				</div>
				{#if ext.kind !== 'installed' && ext.kind !== 'checking'}
					<p class="t-caption muted">To use the side panel, open this page in Chrome with Colander installed.</p>
				{/if}
				{#if reviewer.kind === 'done'}<Notice tone="success" title={reviewer.message} />{/if}
				{#if reviewer.kind === 'error'}<Notice tone="error" title="Not connected"><p>{reviewer.message}</p></Notice>{/if}
			</section>
		{/if}

		<section class="card section-card" aria-labelledby="profile-title">
			<h2 class="t-title" id="profile-title">Profile</h2>
			<form class="name-form" onsubmit={saveName}>
				<div class="field">
					<label class="field-label" for="display-name">Display name</label>
					<Input id="display-name" maxlength={60} autocomplete="nickname" bind:value={displayName} aria-describedby="display-name-hint" />
					<p class="field-hint" id="display-name-hint">
						Shown in the decision log when you review, and on the supporters page only if you ask for credit.
					</p>
				</div>
				<div class="row">
					<button type="submit" class="uin-btn uin-btn-outline uin-btn-md" disabled={nameStatus.kind === 'saving'}>Save name</button>
					<span class="t-body muted" aria-live="polite">{nameStatus.kind === 'saved' ? 'Saved.' : ''}</span>
				</div>
				{#if nameStatus.kind === 'error'}<p class="field-error" role="alert">{nameStatus.message}</p>{/if}
			</form>
			<dl class="kv">
				<dt>Email</dt><dd>{account.email}</dd>
				<dt>Member since</dt><dd>{fmtDate(account.created_at)}</dd>
			</dl>
		</section>
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: var(--cl-s4);
		padding-top: var(--cl-s6);
	}
	.signin-card {
		max-width: 520px;
	}
	.whoami {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cl-s2) var(--cl-s4);
	}
	.whoami .uin-btn {
		margin-left: -10px;
	}
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
	.section-top {
		display: flex;
		align-items: center;
		gap: var(--cl-s3);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--cl-s2);
	}
	.confirm {
		display: grid;
		gap: var(--cl-s3);
		padding: var(--cl-s4);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
		border: 1px solid var(--cl-border);
	}
	.name-form {
		display: grid;
		gap: var(--cl-s3);
		max-width: 420px;
	}
	.kv {
		margin-top: var(--cl-s2);
		padding-top: var(--cl-s4);
		border-top: 1px solid var(--cl-border);
	}
</style>
