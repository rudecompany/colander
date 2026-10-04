<!--
@component Sign in by emailed link (POST /v1/auth/email). No passwords. Focus follows the form:
once the link is sent, focus moves to the "Check your inbox" notice, which is read out; "Use a
different address" brings focus back to the email field. The button stays focusable while sending.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import Mail from '@lucide/svelte/icons/mail';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { api, errorText } from '#lib/api.ts';
	import Notice from './Notice.svelte';

	// `block` stretches the button to the field's width, for narrow cards where every other button is full width.
	let {
		next = '/account',
		submitLabel = 'Email me a sign-in link',
		block = false
	}: { next?: string; submitLabel?: string; block?: boolean } = $props();

	let email = $state('');
	let status = $state<'idle' | 'sending' | 'sent'>('idle');
	let error = $state('');

	let sentBox = $state<HTMLElement>();
	let field = $state<HTMLElement>();

	async function show(next: 'idle' | 'sent') {
		status = next;
		await tick();
		(next === 'sent' ? sentBox : field?.querySelector('input'))?.focus();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (status === 'sending') return;
		error = '';
		if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
			error = 'Enter an email address, like name@example.com.';
			return;
		}
		status = 'sending';
		try {
			await api('/v1/auth/email', { method: 'POST', body: { email: email.trim(), next } });
			await show('sent');
		} catch (e) {
			error = errorText(e);
			status = 'idle';
		}
	}
</script>

{#if status === 'sent'}
	<div class="sent">
		<div class="sent-note" tabindex="-1" bind:this={sentBox}>
			<Notice tone="success" title="Check your inbox">
				<p>We sent a sign-in link to {email.trim()}. It works once and expires after 20 minutes.</p>
			</Notice>
		</div>
		<Button variant="quiet" size="xl" onclick={() => show('idle')}>Use a different address</Button>
	</div>
{:else}
	<form class="signin" onsubmit={submit} novalidate>
		<div class="field" bind:this={field}>
			<label class="field-label" for="signin-email">Email</label>
			<Input
				size="lg"
				id="signin-email"
				type="email"
				autocomplete="email"
				placeholder="name@example.com"
				required
				bind:value={email}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'signin-error' : 'signin-hint'}
			/>
			{#if error}
				<p class="field-error" id="signin-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>
			{:else}
				<p class="field-hint" id="signin-hint">No password. We email you a link that signs you in.</p>
			{/if}
		</div>
		<div>
			<Button type="submit" variant="primary" size="xl" {block} aria-disabled={status === 'sending' || undefined}>
				<Mail size={16} aria-hidden="true" />
				<span>{status === 'sending' ? 'Sending' : submitLabel}</span>
			</Button>
		</div>
	</form>
{/if}

<style>
	.signin,
	.sent {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--cl-s4);
		justify-items: stretch;
	}
	.sent {
		justify-items: start;
	}
	.sent-note,
	.sent :global(.notice) {
		width: 100%;
	}
	.sent-note:focus {
		outline: none;
		box-shadow: none;
	}
</style>
