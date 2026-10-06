<!--
@component The gate in front of review on getcolander.com (docs/contracts.md 6.7): curators,
staff and admins who signed in with a passkey in the last 12 hours, with curator authority at most.
An email code alone gives member rights, so it asks for one touch of the passkey first. Staff see
a note that their full authority is in the admin console. The review console and the calibration
set both sit behind it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Account } from '@colander/shared/api';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Lock from '@lucide/svelte/icons/lock';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import SignIn from '#lib/components/SignIn.svelte';
	import { adminOrigin } from '#lib/site.ts';
	import { errorText } from '#lib/api.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import { PasskeyCancelled, passkeySignIn, passkeysSupported } from '#lib/webauthn.ts';

	let {
		title,
		signInTitle,
		signInLede,
		next,
		staffNote,
		children
	}: {
		/** the page's name, on the cards before review opens */
		title: string;
		signInTitle: string;
		signInLede: string;
		/** where sign-in returns to */
		next: string;
		/** what staff do in the admin console instead, as the subject of "... are in the admin console" */
		staffNote: string;
		children: Snippet<[Account]>;
	} = $props();

	const TWELVE_HOURS = 12 * 3_600_000;
	const account = $derived(session.account);
	const reviewer = $derived(!!account && account.role !== 'member');
	const staff = $derived(account?.role === 'staff' || account?.role === 'admin');
	/** Review needs a passkey sign-in from the last 12 hours. */
	const fresh = $derived(
		account?.session?.method === 'passkey' && Date.now() - Date.parse(account.session.authenticated_at) < TWELVE_HOURS
	);

	let busy = $state(false);
	let error = $state('');

	onMount(loadAccount);

	async function confirm() {
		busy = true;
		error = '';
		try {
			session.account = await passkeySignIn();
		} catch (e) {
			error = e instanceof PasskeyCancelled ? 'No passkey was used. Try again when you are ready.' : errorText(e);
		}
		busy = false;
	}
</script>

{#if session.status === 'idle' || session.status === 'loading'}
	<AuthCard eyebrow="Review console" {title}><Loading label="Checking your sign-in" /></AuthCard>
{:else if !account}
	<AuthCard eyebrow="Review console" title={signInTitle} lede={signInLede}>
		<SignIn {next} block />
	</AuthCard>
{:else if !reviewer}
	<AuthCard eyebrow="Review console" {title}>
		<div class="gate">
			<h2 class="cl-title icon-line"><Lock size={16} aria-hidden="true" />For curators and staff</h2>
			<p class="cl-muted">
				Your account is a member account. Curators are invited from the community of frequent, accurate taggers. Every decision is public in
				the <a href="/log">decision log</a>.
			</p>
		</div>
	</AuthCard>
{:else if !fresh}
	<AuthCard
		eyebrow="Review console"
		title="Confirm with your passkey"
		lede="Reviewing needs a passkey sign-in from the last 12 hours. An email code alone gives member rights only."
	>
		{#if (account.passkey_count ?? 0) === 0}
			<Notice title="Your account has no passkey yet">
				<p>Reviewers add their passkey with an invite link from an admin. Ask the person who made you a reviewer for one.</p>
			</Notice>
		{:else if !passkeysSupported()}
			<Notice title="This browser cannot use passkeys">
				<p>Open the console in a browser where your passkey works.</p>
			</Notice>
		{:else}
			<Button variant="primary" size="xl" block onclick={confirm} aria-disabled={busy || undefined}>
				<KeyRound size={16} aria-hidden="true" />{busy ? 'Waiting for your passkey' : 'Use my passkey'}
			</Button>
		{/if}
		{#if error}<p class="field-error" role="alert">{error}</p>{/if}
		{#if staff}
			<Button variant="quiet" size="xl" href="{adminOrigin(page.url)}/admin"><ShieldCheck size={16} aria-hidden="true" />Open the admin console</Button>
		{/if}
	</AuthCard>
{:else}
	{#if staff}
		<div class="cl-container staff-note">
			<Notice title="You review as a curator here">
				<p>{staffNote} are in the <a href="{adminOrigin(page.url)}/admin">admin console</a>, which signs you in through your staff identity.</p>
			</Notice>
		</div>
	{/if}
	{@render children(account)}
{/if}

<style>
	.gate {
		display: grid;
		gap: 12px;
	}
	.staff-note {
		padding-top: 24px;
	}
</style>
