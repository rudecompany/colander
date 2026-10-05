<!--
@component Your data on the account page (docs/contracts.md 6.6 and 6.8): download everything
Colander keeps about the account as JSON, delete the account behind a confirmation, and see or
cancel what waits. Both ask the person to confirm it is them; an account with a passkey that is
only confirmed by email code can ask anyway, and the request waits 72 hours.
-->
<script lang="ts">
	import Download from '@lucide/svelte/icons/download';
	import type { Account, HeldRequest } from '@colander/shared/api';
	import { fmtDate } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { refreshAccount, session } from '#lib/session.svelte.ts';
	import Notice from './Notice.svelte';

	let { account }: { account: Account } = $props();

	let confirming = $state(false);
	let deleting = $state(false);
	let notice = $state<{ tone: 'success' | 'error'; text: string } | null>(null);
	/** What the server refused for want of a passkey: it can wait 72 hours instead. */
	let blocked = $state<'export' | 'delete' | null>(null);

	const KIND: Record<HeldRequest['kind'], string> = {
		delete: 'Delete the account',
		export: 'Download your data',
		remove_passkey: 'Remove a passkey',
		email_change: 'Move the account to another email address'
	};
	const requests = $derived(account.requests ?? []);
	/** Staff and admin accounts are never deleted: an admin lowers the role first (contracts 6.6). */
	const keeps = $derived(account.role === 'staff' || account.role === 'admin');

	async function download() {
		notice = null;
		blocked = null;
		try {
			const data = await api<unknown>('/v1/account/export');
			const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
			const a = Object.assign(document.createElement('a'), { href: url, download: 'colander-account.json' });
			a.click();
			URL.revokeObjectURL(url);
			notice = { tone: 'success', text: 'Your data is downloading as colander-account.json.' };
		} catch (e) {
			if (e instanceof ApiError && e.code === 'passkey_required') blocked = 'export';
			else notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function remove() {
		deleting = true;
		notice = null;
		try {
			await api('/v1/account', { method: 'DELETE' });
			confirming = false;
			session.account = null;
		} catch (e) {
			confirming = false;
			if (e instanceof ApiError && e.code === 'passkey_required') blocked = 'delete';
			else notice = { tone: 'error', text: errorText(e) };
		}
		deleting = false;
	}

	async function later(kind: 'export' | 'delete') {
		try {
			await api('/v1/account/requests', { method: 'POST', body: { kind } });
			blocked = null;
			notice = { tone: 'success', text: 'We emailed you a link to cancel it. Signing in with your passkey also cancels it.' };
			await refreshAccount();
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function cancel(r: HeldRequest) {
		try {
			await api(`/v1/account/requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
			await refreshAccount();
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}
</script>

<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="data-title">
	<h2 class="cl-title" id="data-title">Your data</h2>
	<p class="cl-body cl-muted">
		Your account holds your email, display name, sign-ins, passkeys, plan and synced settings. Read how long we keep each in the
		<a href="/privacy">privacy notice</a>.
	</p>
	<div class="row">
		<Button variant="secondary" size="xl" onclick={download}><Download size={16} aria-hidden="true" />Download my data</Button>
		{#if !keeps}<Button variant="quiet" size="xl" onclick={() => (confirming = true)}>Delete account</Button>{/if}
	</div>
	{#if keeps}
		<p class="cl-caption cl-muted">Staff and admin accounts stay open until an admin lowers the role on the admin host. Then you can delete it here.</p>
	{/if}

	{#if blocked}
		<Notice title="This needs your passkey">
			<p>Without it, we can do this after 72 hours, and email you a link to cancel it in case it was not you.</p>
		</Notice>
		<div class="row">
			<Button variant="secondary" size="xl" onclick={() => later(blocked!)}>
				{blocked === 'delete' ? 'Delete it in 72 hours' : 'Prepare my data in 72 hours'}
			</Button>
		</div>
	{/if}

	{#if requests.length}
		<h3 class="cl-eyebrow">Waiting</h3>
		<ul class="waiting">
			{#each requests as r (r.id)}
				<li>
					<span>
						{KIND[r.kind]}:
						{r.done_at ? (r.kind === 'export' ? `ready to download until ${fmtDate(new Date(Date.parse(r.done_at) + 7 * 86_400_000).toISOString())}` : 'done') : `on ${fmtDate(r.due_at)}`}
					</span>
					{#if !r.done_at}<Button variant="quiet" size="md" onclick={() => cancel(r)}>Cancel</Button>{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if notice}<Notice tone={notice.tone} title={notice.text} />{/if}
</section>

<Dialog
	bind:open={confirming}
	title="Delete your Colander account?"
	description="This cannot be undone. Blocking, tagging, reporting and appeals keep working without an account."
	size="md"
>
	<ul class="effects cl-body">
		<li>We erase your email, display name, passkeys, sessions and synced settings.</li>
		<li>Our 400-day security record keeps what happened to the account under its ID only, never your email.</li>
		{#if account.plan && account.plan.status !== 'canceled'}
			<li>Plus ends now{account.plan.refundable ? ', and your last charge is refunded' : ''}.</li>
		{/if}
		{#if account.role !== 'member'}<li>Your decisions stay in the public decision log without your name.</li>{/if}
	</ul>
	{#snippet footer()}
		<button type="button" class="uin-btn uin-btn-ghost uin-btn-xl" onclick={() => (confirming = false)}>Keep my account</button>
		<button type="button" class="uin-btn uin-btn-primary uin-btn-xl" onclick={remove} disabled={deleting}>{deleting ? 'Deleting' : 'Delete my account'}</button>
	{/snippet}
</Dialog>

<style>
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
	}
	.waiting {
		display: grid;
		gap: var(--cl-s2);
		margin: 0;
		padding: 0;
		list-style: none;
		font: var(--cl-body);
	}
	.waiting li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--cl-s2);
	}
	.effects {
		display: grid;
		gap: var(--cl-s2);
		margin: 0;
		padding-left: 1.25em;
	}
</style>
