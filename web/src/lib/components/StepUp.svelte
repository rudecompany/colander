<!--
@component The step-up dialog, which the layout loads and mounts on first use. When the server answers 403
passkey_required or recent_auth_required, lib/api.ts opens it; the person confirms with their
passkey, or with a code we email them when the account has no passkey, and the request runs once
more. Closing it gives up and the page shows the server's message.
-->
<script lang="ts">
	import '@colander/shared/components/ui/dialog/dialog.css';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import type { Account } from '@colander/shared/api';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { api, errorText, type StepUpReason } from '#lib/api.ts';
	import { session } from '#lib/session.svelte.ts';
	import { PasskeyCancelled, passkeySignIn, passkeysSupported } from '#lib/webauthn.ts';
	import CodeForm from './CodeForm.svelte';
	import Notice from './Notice.svelte';

	let open = $state(false);
	let reason = $state<StepUpReason>('recent_auth_required');
	let step = $state<'choose' | 'code'>('choose');
	let busy = $state(false);
	let error = $state('');
	let settle: ((ok: boolean) => void) | undefined;

	const account = $derived(session.account);
	/** A passkey is the way whenever the account holds one; otherwise an emailed code. */
	const usePasskey = $derived(reason === 'passkey_required' || (account?.passkey_count ?? 0) > 0);

	/** Opens the dialog; resolves true once the person confirmed, false when they gave up. */
	export function ask(r: StepUpReason): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			settle?.(false);
			reason = r;
			step = 'choose';
			error = '';
			settle = resolve;
			open = true;
		});
	}

	function finish(ok: boolean, signedIn?: Account) {
		if (signedIn) session.account = signedIn;
		const s = settle;
		settle = undefined;
		open = false;
		s?.(ok);
	}

	async function passkey() {
		busy = true;
		error = '';
		try {
			finish(true, await passkeySignIn());
		} catch (e) {
			error = e instanceof PasskeyCancelled ? 'No passkey was used. Try again when you are ready.' : errorText(e);
		}
		busy = false;
	}

	async function sendCode() {
		await api('/v1/auth/code', { method: 'POST', body: { email: account?.email ?? '', next: location.pathname }, stepUp: false });
	}

	async function code() {
		busy = true;
		error = '';
		try {
			await sendCode();
			step = 'code';
		} catch (e) {
			error = errorText(e);
		}
		busy = false;
	}
</script>

<Dialog
	bind:open
	onOpenChange={(v) => !v && finish(false)}
	title="Confirm it is you"
	description={usePasskey
		? 'Use the passkey on this account. We ask again for anything sensitive after 10 minutes, and reviewers sign in with a passkey every 12 hours.'
		: 'We ask again for anything sensitive after 10 minutes. We will email you a code.'}
	size="md"
>
	<div class="step-up">
		{#if usePasskey}
			{#if passkeysSupported()}
				<Button variant="primary" size="xl" block onclick={passkey} aria-disabled={busy || undefined}>
					<KeyRound size={16} aria-hidden="true" />{busy ? 'Waiting for your passkey' : 'Use my passkey'}
				</Button>
			{:else}
				<Notice title="This browser cannot use passkeys">
					<p>Open this page in a browser where your passkey works, or on the device that holds it.</p>
				</Notice>
			{/if}
			<p class="cl-caption cl-muted">
				Lost your passkey? Deleting the account, downloading your data and removing a passkey still work with an email code; they
				wait 72 hours, and we email you a link to cancel them.
			</p>
		{:else if step === 'code'}
			<CodeForm id="step-up-code" email={account?.email ?? ''} block submitLabel="Confirm" onsignedin={(a) => finish(true, a)} onresend={sendCode} />
		{:else}
			<Button variant="primary" size="xl" block onclick={code} aria-disabled={busy || undefined}>{busy ? 'Sending' : 'Email me a code'}</Button>
		{/if}
		{#if error}<p class="field-error" role="alert">{error}</p>{/if}
	</div>
</Dialog>

<style>
	.step-up {
		display: grid;
		gap: var(--cl-s3);
	}
</style>
