<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Account } from '@colander/shared/api';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { safeNext } from '@colander/shared';
	import { session } from '#lib/session.svelte.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import AuthCard from '#lib/components/AuthCard.svelte';

	let error = $state('');

	onMount(async () => {
		const q = new URLSearchParams(location.search);
		const token = q.get('token');
		if (!token) {
			error = 'This sign-in link is incomplete. Open the link from your email again, or ask for a new one.';
			return;
		}
		try {
			const res = await api<{ account: Account }>('/v1/auth/verify', { method: 'POST', body: { token } });
			session.account = res.account;
			session.status = 'ready';
			await goto(safeNext(q.get('next')), { replace: true });
		} catch (e) {
			error =
				e instanceof ApiError && e.status >= 400 && e.status < 500
					? 'This sign-in link has expired or was already used. Links work once, for 20 minutes. Ask for a new one below.'
					: errorText(e);
		}
	});
</script>

<svelte:head>
	<title>Signing in · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthCard title={error ? 'That link did not work' : 'Signing you in'}>
	{#if error}
		<Notice tone="error" title="Not signed in"><p>{error}</p></Notice>
		<Button variant="primary" size="xl" block href="/account">Get a new sign-in link</Button>
	{:else}
		<Loading label="Checking your sign-in link" />
	{/if}
</AuthCard>
