<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import type { Account, Plan } from '@colander/shared/api';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import LogOut from '@lucide/svelte/icons/log-out';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { fmtDate } from '@colander/shared';
	import { loadAccount, refreshAccount, session } from '#lib/session.svelte.ts';
	import AccountData from '#lib/components/AccountData.svelte';
	import AccountSecurity from '#lib/components/AccountSecurity.svelte';
	import ConnectBrowser from '#lib/components/ConnectBrowser.svelte';
	import SignIn from '#lib/components/SignIn.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { PageHeader, PLAN_COPY, PriceCard } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import { adminOrigin } from '#lib/site.ts';

	let displayName = $state('');
	let nameStatus = $state<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' });
	let billing = $state<{ kind: 'idle' | 'working' } | { kind: 'error'; message: string } | { kind: 'done'; message: string }>({ kind: 'idle' });
	let reviewer = $state<{ kind: 'idle' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' });
	/** Counts disconnects: each one starts the side panel's code box over, so it never still says Connected. */
	let disconnects = $state(0);
	let disconnectedNote = $state<HTMLElement>();

	const account = $derived(session.account);

	onMount(async () => {
		const a = await loadAccount();
		displayName = a?.display_name ?? '';
	});

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
			const res = await api<{ account: Account }>('/v1/billing/cancel', { method: 'POST', body: { refund } });
			session.account = res.account;
			// A plain cancel shows its result in the plan line itself; a refund also gets a confirmation.
			billing = refund ? { kind: 'done', message: 'Plus has ended and your last charge is being refunded.' } : { kind: 'idle' };
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

	async function disconnectReviewer() {
		try {
			await api('/v1/account/reviewer-token', { method: 'DELETE' });
			disconnects++;
			reviewer = { kind: 'done', message: 'Disconnected. The side panel can no longer review until you connect it again.' };
			await refreshAccount();
			// Disconnect went away with the connection: focus moves to what replaced it.
			await tick();
			disconnectedNote?.focus();
		} catch (e) {
			reviewer = { kind: 'error', message: errorText(e) };
		}
	}

	/** A new connection replaces what Disconnect said. */
	function reviewerConnected() {
		reviewer = { kind: 'idle' };
		void refreshAccount();
	}

	const PLAN_STATUS: Record<Plan['status'], string> = {
		active: 'Active',
		trialing: 'Trial',
		past_due: 'Payment due',
		canceled: 'Ended'
	};

	const ROLE_WORD = { member: 'Member', curator: 'Curator', staff: 'Staff', admin: 'Admin' } as const;
	const staff = $derived(account?.role === 'staff' || account?.role === 'admin');
	const livePlan = $derived(account?.plan && account.plan.status !== 'canceled' ? account.plan : null);
</script>

<svelte:head>
	<title>Account · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if session.status === 'idle' || session.status === 'loading'}
	<AuthCard title="Your account"><Loading label="Checking whether you are signed in" /></AuthCard>
{:else if !account}
	<AuthCard
		title="Sign in"
		lede="Colander needs no account to block, tag, report or appeal. Sign in to manage Plus, connect a browser to your plan, or review."
	>
		{#if session.status === 'error'}
			<Notice tone="error" title="We could not check your session"><p>Colander may be busy. Try again in a moment.</p></Notice>
		{/if}
		<SignIn next="/account" block />
	</AuthCard>
{:else}
	<div class="cl-container page-top">
		<PageHeader eyebrow="Account" title={account.display_name ? `Hello, ${account.display_name}` : 'Your account'}>
			<div class="whoami">
				<p class="cl-body cl-muted">Signed in as <strong>{account.email}</strong>{account.role !== 'member' ? ` · ${ROLE_WORD[account.role]}` : ''}</p>
				<Button variant="quiet" size="xl" onclick={signOut}><LogOut size={16} aria-hidden="true" />Sign out</Button>
			</div>
		</PageHeader>
	</div>

	<div class="cl-container page-body grid">
		<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="plan-title">
			<div class="section-top">
				<h2 class="cl-title" id="plan-title">Plan</h2>
				{#if account.plan}<span class="uin-badge uin-badge-lg">{PLAN_STATUS[account.plan.status]}</span>{/if}
			</div>
			{#if !account.plan || account.plan.status === 'canceled'}
				<p class="cl-body-lg"><strong>Free.</strong> Blocking, tagging, reporting and appeals on every platform, for good.</p>
				<PriceCard plan="plus" size="app" headingLevel={3} cta={{ label: 'See Plus', href: '/plans' }} />
			{:else}
				{@const plan = account.plan}
				<p class="cl-body-lg"><strong>Plus.</strong> {PLAN_COPY.plus.billed[plan.interval]}.</p>
				<p class="cl-body" aria-live="polite">
					{#if plan.cancel_at_period_end}
						Cancelled. Plus stays on until {fmtDate(plan.current_period_end)}, and you will not be charged again.
					{:else if plan.status === 'trialing'}
						Your trial runs until {fmtDate(plan.current_period_end)}. No card is needed for the trial.
					{:else if plan.status === 'past_due'}
						Your last payment did not go through. Plus stays on for 3 days of grace while the payment is retried.
					{:else}
						Renews on {fmtDate(plan.current_period_end)}.
					{/if}
				</p>

				<!-- One click cancels. The same button then offers the refund; aria-disabled (not disabled) keeps keyboard focus on it. -->
				{#if !plan.cancel_at_period_end || plan.refundable}
					<div class="row">
						<Button
							variant="secondary"
							size="xl"
							aria-disabled={billing.kind === 'working'}
							onclick={() => billing.kind !== 'working' && cancelPlan(plan.cancel_at_period_end)}
						>
							{plan.cancel_at_period_end ? 'End now and refund' : 'Cancel Plus'}
						</Button>
					</div>
					{#if plan.cancel_at_period_end}
						<p class="cl-caption cl-muted">
							Your last charge was less than 30 days ago, so you can still get it back. Plus then ends at once, and the charge is
							refunded the way you paid.
						</p>
					{/if}
				{/if}
			{/if}
			{#if billing.kind === 'error'}<Notice tone="error" title="Nothing was changed"><p>{billing.message}</p></Notice>{/if}
			{#if billing.kind === 'done'}<Notice tone="success" title={billing.message} />{/if}
		</section>

		<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="connect-title">
			<h2 class="cl-title" id="connect-title">Connect a browser</h2>
			{#if livePlan}
				<p class="cl-body cl-muted">
					Colander checks your plan on each device with a signed token. A code connects one browser, in any browser and on any
					computer, and nothing else about your account goes with it.
				</p>
				<ConnectBrowser kind="plan" />
			{:else}
				<p class="cl-body cl-muted">Once you have Plus, connect each browser you use here with a code.</p>
			{/if}
		</section>

		{#if account.role !== 'member'}
			<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="review-title">
				<h2 class="cl-title" id="review-title">Review</h2>
				<p class="cl-body cl-muted">
					You are {account.role === 'curator' ? 'a curator' : account.role === 'admin' ? 'an admin' : 'a staff member'}. In the review console,
					with a passkey sign-in from the last 12 hours, and in the side panel, you decide items and sources that are not large.
					{staff ? 'Large sources, appeals, the seed lists behind a lead, and people are in the admin console.' : 'Large sources and appeals need staff.'}
				</p>
				<div class="row">
					<Button variant="primary" size="xl" href="/console"><ListChecks size={16} aria-hidden="true" />Open the review console</Button>
					{#if staff}
						<Button variant="secondary" size="xl" href="{adminOrigin(page.url)}/admin"><ShieldCheck size={16} aria-hidden="true" />Open the admin console</Button>
					{/if}
				</div>
				<h3 class="sub">Review in the extension</h3>
				<p class="cl-body cl-muted">
					Connect Colander's side panel with a code, and review from the platforms as you browse. A code needs a passkey sign-in from
					the last 10 minutes, and the connection lasts 7 days.
				</p>
				{#key disconnects}<ConnectBrowser kind="reviewer" onconnected={reviewerConnected} />{/key}
				{#if account.reviewer_token}
					<div class="row connection">
						<p class="cl-caption cl-muted">The side panel is connected until {fmtDate(account.reviewer_token.expires_at)}.</p>
						<Button variant="quiet" size="md" onclick={disconnectReviewer}>Disconnect</Button>
					</div>
				{/if}
				{#if reviewer.kind === 'done'}<div class="note" tabindex="-1" bind:this={disconnectedNote}><Notice tone="success" title={reviewer.message} /></div>{/if}
				{#if reviewer.kind === 'error'}<Notice tone="error" title="Still connected"><p>{reviewer.message}</p></Notice>{/if}
			</section>
		{/if}

		<AccountSecurity {account} />

		<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="profile-title">
			<h2 class="cl-title" id="profile-title">Profile</h2>
			<form class="name-form" onsubmit={saveName}>
				<div class="field">
					<label class="field-label" for="display-name">Display name</label>
					<Input id="display-name" size="lg" maxlength={60} autocomplete="nickname" bind:value={displayName} aria-describedby="display-name-hint" />
					<p class="field-hint" id="display-name-hint">
						Shown in the decision log when you review. Donors choose their own name for the supporters page when they give.
					</p>
				</div>
				<div class="row">
					<Button type="submit" variant="secondary" size="xl" disabled={nameStatus.kind === 'saving'}>Save name</Button>
					<span class="cl-body cl-muted" aria-live="polite">{nameStatus.kind === 'saved' ? 'Saved.' : ''}</span>
				</div>
				{#if nameStatus.kind === 'error'}<p class="field-error" role="alert">{nameStatus.message}</p>{/if}
			</form>
			<dl class="kv">
				<dt>Email</dt><dd>{account.email}</dd>
				<dt>Member since</dt><dd>{fmtDate(account.created_at)}</dd>
			</dl>
		</section>

		<AccountData {account} />
	</div>
{/if}

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
		align-items: start;
	}
	@media (max-width: 1023px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.whoami {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cl-s2) var(--cl-s4);
	}
	.whoami {
		margin-top: 16px;
	}
	/* On a phone, Sign out takes its own line; its text lines up with the line above, not its padding. */
	@media (max-width: 639px) {
		.whoami {
			flex-direction: column;
			align-items: flex-start;
		}
		.whoami :global(.uin-btn-ghost) {
			margin-left: calc(-1 * var(--cl-s4));
		}
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
	/* On a phone, Disconnect takes its own line; its text lines up with the caption, not its padding. */
	@media (max-width: 639px) {
		.connection {
			flex-direction: column;
			align-items: flex-start;
			gap: 0;
		}
		.connection :global(.uin-btn-ghost) {
			margin-left: -12px;
		}
	}
	/* Focus lands here only from script, after Disconnect went away. */
	.note:focus {
		outline: none;
	}
	.sub {
		margin-top: var(--cl-s2);
		font: var(--cl-body-lg);
		font-weight: 600;
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
