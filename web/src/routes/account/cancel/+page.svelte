<!--
The cancel link from a held-request email (docs/contracts.md 6.6): a deletion, an export, a
passkey removal or an email change that waits because it was confirmed with a code only. The
secret is in the fragment, so it reaches no server log; nothing happens until the person chooses
Cancel, so a mail scanner that opens the link cancels nothing.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { api, errorText } from '#lib/api.ts';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import Notice from '#lib/components/Notice.svelte';

	const KIND: Record<string, string> = {
		delete: 'deleting the account',
		export: 'preparing a copy of your data',
		remove_passkey: 'removing a passkey',
		email_change: 'moving the account to another address'
	};

	let secret = $state('');
	let status = $state<'idle' | 'working' | 'done'>('idle');
	let cancelled = $state('');
	let error = $state('');

	onMount(() => {
		secret = location.hash.slice(1);
		if (location.hash) history.replaceState(history.state, '', location.pathname);
	});

	async function cancel() {
		status = 'working';
		error = '';
		try {
			cancelled = (await api<{ cancelled: string }>('/v1/auth/cancel', { method: 'POST', body: { secret }, stepUp: false })).cancelled;
			status = 'done';
		} catch (e) {
			error = errorText(e);
			status = 'idle';
		}
	}
</script>

<svelte:head>
	<title>Cancel a request · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if status === 'done'}
	<AuthCard title="Cancelled" lede="We stopped {KIND[cancelled] ?? 'the request'}. Nothing changed on your account.">
		<p class="cl-body cl-muted">If you did not ask for it, sign in, then choose Sign out everywhere on your account page.</p>
		<Button variant="secondary" size="xl" block href="/account">Open your account</Button>
	</AuthCard>
{:else if !secret}
	<AuthCard title="This link is incomplete">
		<Notice title="Open the whole link"><p>Use the full link from the email, including everything after the # sign.</p></Notice>
	</AuthCard>
{:else}
	<AuthCard title="Cancel a waiting request?" lede="Your account asked for a change that waits a few days, because it was confirmed with an email code only.">
		<Button variant="primary" size="xl" block onclick={cancel} aria-disabled={status !== 'idle' || undefined}>
			{status === 'working' ? 'Cancelling' : 'Cancel the request'}
		</Button>
		{#if error}<Notice tone="error" title="Nothing was cancelled"><p>{error}</p></Notice>{/if}
	</AuthCard>
{/if}
