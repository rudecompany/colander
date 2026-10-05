<!--
A passkey invite (docs/contracts.md 6.6): the link an admin sends a new reviewer, with the secret in
the fragment so it never reaches a server log. It works only together with an email sign-in to the
same account, once, within 24 hours; then the passkey it adds signs this browser in for review.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import type { Account } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import SignIn from '#lib/components/SignIn.svelte';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import { createCredential, PasskeyCancelled, passkeysSupported } from '#lib/webauthn.ts';

	let invite = $state('');
	let name = $state('');
	let status = $state<'idle' | 'working' | 'done'>('idle');
	let error = $state('');
	let supported = $state(true);

	onMount(() => {
		invite = new URLSearchParams(location.hash.slice(1)).get('invite') ?? '';
		// The secret stays out of the address bar and history once it is read.
		if (location.hash) history.replaceState(history.state, '', location.pathname);
		supported = passkeysSupported();
		loadAccount();
	});

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (status !== 'idle') return;
		status = 'working';
		error = '';
		try {
			const { options } = await api<{ options: Record<string, unknown> }>('/v1/auth/invite/options', { method: 'POST', body: { invite } });
			const credential = await createCredential(options);
			const res = await api<{ account: Account }>('/v1/auth/invite/verify', { method: 'POST', body: { invite, credential, name: name.trim() } });
			session.account = res.account;
			status = 'done';
			return;
		} catch (e) {
			error =
				e instanceof PasskeyCancelled
					? 'No passkey was created. Try again when you are ready.'
					: e instanceof ApiError && e.code === 'invite_invalid'
						? 'This invite does not work for this account: it expired, was used, or was sent for another address. Ask the admin for a new one.'
						: errorText(e);
		}
		status = 'idle';
	}
</script>

<svelte:head>
	<title>Reviewer invite · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if session.status === 'idle' || session.status === 'loading'}
	<AuthCard title="Reviewer invite"><Loading label="Checking whether you are signed in" /></AuthCard>
{:else if !invite && status !== 'done'}
	<AuthCard title="This invite link is incomplete">
		<Notice title="Open the whole link"><p>Copy the full link the admin sent you, including everything after the # sign.</p></Notice>
	</AuthCard>
{:else if !session.account}
	<AuthCard title="Add your reviewer passkey" lede="First sign in with the email address the invite was made for. Then you add a passkey on this device.">
		<SignIn next="/account/invite" block />
	</AuthCard>
{:else if status === 'done'}
	<AuthCard title="Your passkey is ready" lede="You signed in with it. Review sign-ins last 12 hours; after that, one touch of the passkey opens the console again.">
		<Button variant="primary" size="xl" block href="/console"><ListChecks size={16} aria-hidden="true" />Open the review console</Button>
	</AuthCard>
{:else}
	<AuthCard title="Add your reviewer passkey" lede="Signed in as {session.account.email}. Reviewing needs a passkey; this invite adds one, once.">
		{#if supported}
			<form class="add" onsubmit={add}>
				<div class="field">
					<label class="field-label" for="invite-name">Name for this passkey</label>
					<Input id="invite-name" size="lg" maxlength={60} placeholder="Work laptop" bind:value={name} />
				</div>
				<Button type="submit" variant="primary" size="xl" block aria-disabled={status !== 'idle' || undefined}>
					<KeyRound size={16} aria-hidden="true" />{status === 'working' ? 'Waiting for your device' : 'Add my passkey'}
				</Button>
			</form>
		{:else}
			<Notice title="This browser cannot create passkeys"><p>Open the invite link in a browser that supports passkeys.</p></Notice>
		{/if}
		{#if error}<Notice tone="error" title="No passkey added"><p>{error}</p></Notice>{/if}
	</AuthCard>
{/if}

<style>
	.add {
		display: grid;
		gap: var(--cl-s4);
	}
</style>
