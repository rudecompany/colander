<!--
@component The second step of an email sign-in: the 6-digit code from the email. One field with
one-time-code autofill and a numeric keypad; spaces and dashes in a pasted code are ignored. Focus
starts in the field. A wrong code keeps the field and says so; a code that is used up or paused
offers a new one.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import type { Account } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';

	let {
		email,
		id = 'code',
		block = false,
		submitLabel = 'Sign in',
		onsignedin,
		onresend,
		onback
	}: {
		email: string;
		id?: string;
		block?: boolean;
		submitLabel?: string;
		onsignedin: (account: Account) => void;
		onresend: () => Promise<void>;
		onback?: () => void;
	} = $props();

	let code = $state('');
	let status = $state<'idle' | 'checking' | 'resending'>('idle');
	let error = $state('');
	let resent = $state(false);
	let field = $state<HTMLElement>();

	onMount(() => field?.querySelector('input')?.focus());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (status !== 'idle') return;
		const digits = code.replace(/[\s-]/g, '');
		error = '';
		if (!/^\d{6}$/.test(digits)) {
			error = 'Enter the 6 digits from the email.';
			return;
		}
		status = 'checking';
		try {
			const res = await api<{ account: Account }>('/v1/auth/code/verify', { method: 'POST', body: { code: digits }, stepUp: false });
			onsignedin(res.account);
		} catch (e) {
			error = e instanceof ApiError && e.code === 'code_expired' ? 'This code no longer works. Send a new one and use the newest email.' : errorText(e);
			status = 'idle';
		}
	}

	async function resend() {
		if (status !== 'idle') return;
		status = 'resending';
		error = '';
		try {
			await onresend();
			code = '';
			resent = true;
			field?.querySelector('input')?.focus();
		} catch (e) {
			error = errorText(e);
		}
		status = 'idle';
	}
</script>

<form class="code-form" onsubmit={submit} novalidate>
	<p class="cl-body" aria-live="polite">
		{resent ? 'We sent a new code to' : 'We emailed a 6-digit code to'} <strong>{email}</strong>. It works once, for 10 minutes.
	</p>
	<div class="field" bind:this={field}>
		<label class="field-label" for={id}>Code</label>
		<Input
			size="lg"
			{id}
			inputClass="code"
			type="text"
			inputmode="numeric"
			autocomplete="one-time-code"
			spellcheck={false}
			maxlength={9}
			placeholder="000000"
			bind:value={code}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? `${id}-error` : `${id}-hint`}
		/>
		{#if error}
			<p class="field-error" id="{id}-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>
		{:else}
			<p class="field-hint" id="{id}-hint">Check your spam folder if it has not arrived within a minute.</p>
		{/if}
	</div>
	<Button type="submit" variant="primary" size="xl" {block} aria-disabled={status !== 'idle' || undefined}>
		{status === 'checking' ? 'Checking' : submitLabel}
	</Button>
	<div class="links">
		<Button variant="quiet" size="lg" onclick={resend} aria-disabled={status !== 'idle' || undefined}>
			{status === 'resending' ? 'Sending' : 'Send a new code'}
		</Button>
		{#if onback}<Button variant="quiet" size="lg" onclick={onback}>Use a different address</Button>{/if}
	</div>
</form>

<style>
	.code-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--cl-s4);
	}
	.code-form :global(.code) {
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.2em;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
		margin-top: calc(-1 * var(--cl-s2));
	}
	strong {
		overflow-wrap: anywhere;
	}
</style>
