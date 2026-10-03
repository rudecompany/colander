<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Account } from '@colander/shared/api';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { safeNext } from '#lib/format.ts';
	import { session } from '#lib/session.svelte.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

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

<PageHead eyebrow="Account" title={error ? 'That link did not work' : 'Signing you in'} narrow />
<div class="wrap wrap-narrow page">
	{#if error}
		<Notice tone="error" title="Not signed in"><p>{error}</p></Notice>
		<p><a class="uin-btn uin-btn-primary uin-btn-md" href="/account">Get a new sign-in link</a></p>
	{:else}
		<Loading label="Checking your sign-in link" />
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: var(--cl-s4);
		justify-items: start;
		padding-top: var(--cl-s6);
	}
</style>
