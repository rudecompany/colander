<!--
@component The sign-in section of the account page: the account's passkeys, adding and removing
them, and Sign out everywhere (docs/contracts.md 6.6). Adding or removing asks the person to
confirm it is them (lib/api.ts step-up). Someone who lost their passkey can still remove it with an
email code; that waits 72 hours. Reviewer accounts get their first passkey through an invite.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plus from '@lucide/svelte/icons/plus';
	import LogOut from '@lucide/svelte/icons/log-out';
	import type { Account, HeldRequest, Passkey } from '@colander/shared/api';
	import { fmtDate } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { refreshAccount, session } from '#lib/session.svelte.ts';
	import { createCredential, PasskeyCancelled, passkeysSupported } from '#lib/webauthn.ts';
	import Loading from './Loading.svelte';
	import Notice from './Notice.svelte';

	let { account }: { account: Account } = $props();

	let list = $state<Passkey[] | null>(null);
	let current = $state<string | null>(null);
	let name = $state('');
	let adding = $state(false);
	let notice = $state<{ tone: 'success' | 'error'; text: string } | null>(null);
	/** A removal the server refused for want of a passkey: it can wait 72 hours instead. */
	let blocked = $state<Passkey | null>(null);
	let supported = $state(true);

	const reviewer = $derived(account.role !== 'member');
	const waiting = $derived((account.requests ?? []).filter((r: HeldRequest) => r.kind === 'remove_passkey' && !r.done_at));

	onMount(() => {
		supported = passkeysSupported();
		refresh();
	});

	async function refresh() {
		try {
			const res = await api<{ passkeys: Passkey[]; current: string | null }>('/v1/account/passkeys');
			list = res.passkeys;
			current = res.current;
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (adding) return;
		adding = true;
		notice = null;
		try {
			const { options } = await api<{ options: Record<string, unknown> }>('/v1/account/passkeys/options', { method: 'POST' });
			const credential = await createCredential(options);
			await api('/v1/account/passkeys', { method: 'POST', body: { credential, name: name.trim() } });
			name = '';
			notice = { tone: 'success', text: 'Passkey added. You can now sign in with it here and on your other devices that sync it.' };
			await refresh();
			await refreshAccount();
		} catch (e) {
			notice = {
				tone: 'error',
				text:
					e instanceof PasskeyCancelled
						? 'No passkey was created.'
						: e instanceof ApiError && e.code === 'invite_required'
							? 'Reviewer accounts add their first passkey with an invite from an admin.'
							: errorText(e)
			};
		}
		adding = false;
	}

	async function remove(p: Passkey) {
		notice = null;
		blocked = null;
		try {
			await api(`/v1/account/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
			notice = { tone: 'success', text: `${p.name ?? 'That passkey'} no longer signs in to your account.` };
			await refresh();
			await refreshAccount();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'passkey_required') blocked = p;
			else notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function removeLater(p: Passkey) {
		try {
			await api('/v1/account/requests', { method: 'POST', body: { kind: 'remove_passkey', passkey_id: p.id } });
			blocked = null;
			notice = { tone: 'success', text: 'We will remove it in 72 hours and emailed you a link to cancel. Signing in with a passkey also cancels it.' };
			await refreshAccount();
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function everywhere() {
		notice = null;
		try {
			await api('/v1/auth/logout', { method: 'POST', body: { everywhere: true } });
			session.account = null;
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}
</script>

<section class="uin-card uin-card-lg uin-card-pad section-card" class:tall={!reviewer} aria-labelledby="signin-title">
	<h2 class="cl-title" id="signin-title">Sign-in</h2>
	<p class="cl-body cl-muted">
		{account.session?.method === 'passkey' ? 'You signed in with a passkey.' : 'You signed in with an email code.'}
		{reviewer ? 'Reviewing needs a passkey sign-in from the last 12 hours.' : 'A passkey signs you in with one touch, and no code to wait for.'}
	</p>

	{#if list === null}
		<Loading label="Loading your passkeys" />
	{:else if list.length === 0}
		<p class="cl-body">No passkeys yet.</p>
	{:else}
		<ul class="keys">
			{#each list as p (p.id)}
				<li>
					<KeyRound size={16} aria-hidden="true" />
					<div class="key">
						<span class="name">{p.name ?? 'Passkey'}{p.id === current ? ' (this sign-in)' : ''}</span>
						<span class="cl-caption cl-muted">
							Added {fmtDate(p.created_at)}{p.last_used_at ? `, last used ${fmtDate(p.last_used_at)}` : ''}{p.synced ? ', synced' : ''}
						</span>
					</div>
					<Button variant="quiet" size="md" onclick={() => remove(p)} aria-label="Remove {p.name ?? 'passkey'}">Remove</Button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if waiting.length}
		<p class="cl-caption cl-muted">A passkey removal is waiting. You can cancel it under Your data.</p>
	{/if}
	{#if blocked}
		<Notice title="This needs your passkey">
			<p>Without it, we remove the passkey after 72 hours and email you a link to cancel, in case it was not you.</p>
		</Notice>
		<div class="row"><Button variant="secondary" size="xl" onclick={() => removeLater(blocked!)}>Remove it in 72 hours</Button></div>
	{/if}

	{#if !supported}
		<p class="cl-caption cl-muted">This browser cannot create passkeys. Email codes keep working.</p>
	{:else if reviewer && (account.passkey_count ?? 0) === 0}
		<p class="cl-caption cl-muted">Reviewer accounts add their first passkey with an invite link from an admin.</p>
	{:else}
		<form class="add" onsubmit={add}>
			<div class="field">
				<label class="field-label" for="passkey-name">Name for the new passkey</label>
				<Input id="passkey-name" size="lg" maxlength={60} placeholder="Work laptop" bind:value={name} />
			</div>
			<div><Button type="submit" variant="secondary" size="xl" aria-disabled={adding || undefined}><Plus size={16} aria-hidden="true" />{adding ? 'Waiting for your device' : 'Add a passkey'}</Button></div>
		</form>
	{/if}

	{#if notice}<Notice tone={notice.tone} title={notice.text} />{/if}

	<div class="everywhere">
		<Button variant="quiet" size="xl" onclick={everywhere}><LogOut size={16} aria-hidden="true" />Sign out everywhere</Button>
		<p class="cl-caption cl-muted">
			Ends every session and disconnects the side panel. Right after a passkey sign-in, it also removes every other passkey, so one you
			do not recognize cannot sign in again.
		</p>
	</div>
</section>

<style>
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
	.keys {
		display: grid;
		gap: var(--cl-s2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.keys li {
		display: flex;
		align-items: center;
		gap: var(--cl-s3);
		padding: var(--cl-s2) 0;
		border-bottom: 1px solid var(--cl-border);
	}
	.key {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.name {
		font: var(--cl-body);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.add {
		display: grid;
		gap: var(--cl-s3);
		max-width: 420px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
	}
	.everywhere {
		display: grid;
		justify-items: start;
		gap: var(--cl-s1);
		padding-top: var(--cl-s3);
		border-top: 1px solid var(--cl-border);
	}
	/* The text lines up with the caption; the 16px is the xl button's side padding. */
	.everywhere > :global(.uin-btn) {
		margin-inline-start: -16px;
	}
	/* In the account page's two columns a member's sign-in card sits beside Profile and Your data;
	   a reviewer's page has the Review card, which fills that row already. */
	@media (min-width: 1024px) {
		.tall {
			grid-row: span 2;
		}
	}
</style>
