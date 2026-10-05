<!--
@component Sign in without a password (docs/contracts.md 6.6): an email address, then the 6-digit
code we email, or a passkey. The email field offers saved passkeys in its autofill where the
browser supports it (conditional UI), and "Sign in with a passkey" opens the browser's prompt. With
a Turnstile site key the code request also passes a quick check. Focus follows the steps: the
code field after the email is sent, the email field again for another address.
-->
<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import Mail from '@lucide/svelte/icons/mail';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import type { Account } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { api, errorText } from '#lib/api.ts';
	import { session } from '#lib/session.svelte.ts';
	import { mountTurnstile, turnstileOn } from '#lib/turnstile.ts';
	import { conditionalSupported, PasskeyCancelled, passkeySignIn, passkeysSupported } from '#lib/webauthn.ts';
	import CodeForm from './CodeForm.svelte';

	// `block` stretches the buttons to the field's width, for narrow cards where every other button is full width.
	let {
		next = '/account',
		block = false,
		onsignedin
	}: { next?: string; block?: boolean; onsignedin?: (account: Account) => void } = $props();

	let email = $state('');
	let step = $state<'email' | 'code'>('email');
	let status = $state<'idle' | 'sending' | 'passkey'>('idle');
	let error = $state('');
	let field = $state<HTMLElement>();
	let challenge = $state<HTMLElement>();
	let token = $state('');
	let passkeys = $state(false);
	let widget: { reset(): void; remove(): void } | undefined;
	let conditional: AbortController | undefined;

	function done(account: Account) {
		conditional?.abort();
		session.account = account;
		session.status = 'ready';
		onsignedin?.(account);
	}

	onMount(async () => {
		passkeys = passkeysSupported();
		if (turnstileOn() && challenge) {
			try {
				widget = await mountTurnstile(challenge, (t) => (token = t));
			} catch (e) {
				error = errorText(e);
			}
		}
		if (passkeys && (await conditionalSupported())) startConditional();
	});

	onDestroy(() => {
		conditional?.abort();
		widget?.remove();
	});

	/**
	 * Offers saved passkeys in the email field's autofill until one is picked or the form moves on.
	 * It is a shortcut, so a failure here stays quiet: the button and the code still work.
	 */
	async function startConditional() {
		conditional?.abort();
		conditional = new AbortController();
		try {
			done(await passkeySignIn({ mediation: 'conditional', signal: conditional.signal }));
		} catch {
			// Picked nothing, aborted, or the challenge did not load.
		}
	}

	async function withPasskey() {
		if (status !== 'idle') return;
		conditional?.abort();
		status = 'passkey';
		error = '';
		try {
			done(await passkeySignIn());
		} catch (e) {
			error = e instanceof PasskeyCancelled ? 'No passkey was used. Try again, or sign in with an email code.' : errorText(e);
		}
		status = 'idle';
	}

	async function send() {
		await api('/v1/auth/code', { method: 'POST', body: { email: email.trim(), next, ...(turnstileOn() ? { turnstile: token } : {}) }, stepUp: false });
		widget?.reset();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (status !== 'idle') return;
		error = '';
		if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
			error = 'Enter an email address, like name@example.com.';
			return;
		}
		if (turnstileOn() && !token) {
			error = 'Wait a moment for the check below to finish, then try again.';
			return;
		}
		status = 'sending';
		try {
			await send();
			conditional?.abort();
			step = 'code';
		} catch (e) {
			error = errorText(e);
		}
		status = 'idle';
	}

	async function back() {
		step = 'email';
		await tick();
		field?.querySelector('input')?.focus();
		if (passkeys && (await conditionalSupported())) startConditional();
	}
</script>

{#if step === 'code'}
	<CodeForm email={email.trim()} {block} onsignedin={done} onresend={send} onback={back} />
{:else}
	<form class="signin" onsubmit={submit} novalidate>
		<div class="field" bind:this={field}>
			<label class="field-label" for="signin-email">Email</label>
			<Input
				size="lg"
				id="signin-email"
				type="email"
				autocomplete="username webauthn"
				placeholder="name@example.com"
				required
				bind:value={email}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'signin-error' : 'signin-hint'}
			/>
			{#if error}
				<p class="field-error" id="signin-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>
			{:else}
				<p class="field-hint" id="signin-hint">No password. We email you a 6-digit code.</p>
			{/if}
		</div>
		<div class="challenge" bind:this={challenge}></div>
		<div class="actions" class:block>
			<Button type="submit" variant="primary" size="xl" {block} aria-disabled={status !== 'idle' || undefined}>
				<Mail size={16} aria-hidden="true" />
				<span>{status === 'sending' ? 'Sending' : 'Email me a code'}</span>
			</Button>
			{#if passkeys}
				<Button variant="secondary" size="xl" {block} onclick={withPasskey} aria-disabled={status !== 'idle' || undefined}>
					<KeyRound size={16} aria-hidden="true" />
					<span>{status === 'passkey' ? 'Waiting for your passkey' : 'Sign in with a passkey'}</span>
				</Button>
			{/if}
		</div>
	</form>
{/if}

<style>
	.signin {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--cl-s4);
		justify-items: stretch;
	}
	.challenge:empty {
		display: none;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
	}
	.actions.block {
		display: grid;
	}
</style>
