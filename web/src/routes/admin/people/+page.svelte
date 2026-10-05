<!--
People on the admin host (docs/contracts.md 6.9): find an account, set a role below your own,
issue a passkey invite, end every credential, or move a member who lost their mailbox to a new
address after matching a Stripe receipt. Each action is audited; the server checks the
permission table again.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import type { Person, Role } from '@colander/shared/api';
	import { CopyButton, fmtDate, PageHeader } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import { admin, may } from '#lib/admin.svelte.ts';
	import { api, errorText } from '#lib/api.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	const RANK: Record<Role, number> = { member: 0, curator: 1, staff: 2, admin: 3 };
	const ROLE_WORD: Record<Role, string> = { member: 'Member', curator: 'Curator', staff: 'Staff', admin: 'Admin' };

	let q = $state('');
	let people = $state<Person[] | null>(null);
	let notice = $state<{ tone: 'success' | 'error'; text: string } | null>(null);
	let invite = $state<{ email: string; url: string; expires: string } | null>(null);
	let grantEmail = $state('');
	let grantRole = $state<Role>('curator');
	let moving = $state<Person | null>(null);
	let move = $state({ email: '', session: '', amount: '', date: '' });

	const me = $derived(admin.me!);
	const mine = $derived(RANK[me.authority]);
	/** Roles below your own, never admin: admin comes only from the ops channel's bootstrap. */
	const grantable = $derived((['member', 'curator', 'staff'] as Role[]).filter((r) => RANK[r] < mine));
	const canInvite = (p: Person) => p.id !== me.account.id && RANK[p.role] >= 1 && (RANK[p.role] < 2 || me.authority === 'admin');

	onMount(() => search());

	async function search(event?: SubmitEvent) {
		event?.preventDefault();
		people = null;
		try {
			people = (await api<{ people: Person[] }>(`/v1/admin/people${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)).people;
		} catch (e) {
			people = [];
			notice = { tone: 'error', text: errorText(e) };
		}
	}

	async function act(work: () => Promise<string>) {
		notice = null;
		try {
			notice = { tone: 'success', text: await work() };
			await search();
		} catch (e) {
			notice = { tone: 'error', text: errorText(e) };
		}
	}

	const grant = (event: SubmitEvent) => {
		event.preventDefault();
		return act(async () => {
			const { person } = await api<{ person: Person }>('/v1/admin/people/role', { method: 'PUT', body: { email: grantEmail.trim(), role: grantRole } });
			grantEmail = '';
			return `${person.email} is now ${ROLE_WORD[person.role].toLowerCase()}.${RANK[person.role] >= 1 ? ' Issue an invite so they can add a passkey.' : ''}`;
		});
	};

	const issue = (p: Person) =>
		act(async () => {
			const res = await api<{ invite: string; url: string; expires_at: string }>(`/v1/admin/people/${encodeURIComponent(p.id)}/invite`, { method: 'POST' });
			invite = { email: p.email, url: res.url, expires: res.expires_at };
			return `Invite ready for ${p.email}. We emailed them a notice, not the link.`;
		});

	const revoke = (p: Person) =>
		act(async () => {
			await api(`/v1/admin/people/${encodeURIComponent(p.id)}/revoke`, { method: 'POST' });
			return `Every session, passkey and token of ${p.email} ended.`;
		});

	const moveEmail = (event: SubmitEvent) => {
		event.preventDefault();
		const p = moving!;
		return act(async () => {
			const res = await api<{ due_at: string }>(`/v1/admin/people/${encodeURIComponent(p.id)}/email`, {
				method: 'PUT',
				body: { email: move.email.trim(), checkout_session: move.session.trim(), amount_cents: Math.round(Number(move.amount) * 100), date: move.date }
			});
			moving = null;
			return `${p.email} moves to ${move.email.trim()} on ${fmtDate(res.due_at)}, unless the old address cancels it.`;
		});
	};
</script>

<svelte:head>
	<title>People · Admin console · Colander</title>
</svelte:head>

<div class="cl-container page-top">
	<PageHeader variant="app" eyebrow="Admin console" title="People" lede="Reviewers and accounts. Every change here is in the audit log." />
</div>

<div class="cl-container page-body people">
	<section class="uin-card uin-card-lg uin-card-pad card" aria-labelledby="grant-title">
		<h2 class="cl-title" id="grant-title">Set a role</h2>
		<form class="grant" onsubmit={grant}>
			<div class="field">
				<label class="field-label" for="grant-email">Email</label>
				<Input id="grant-email" size="lg" type="email" autocomplete="off" bind:value={grantEmail} required />
			</div>
			<div class="field">
				<label class="field-label" for="grant-role">Role</label>
				<NativeSelect
					id="grant-role"
					size="lg"
					value={grantRole}
					onchange={(e) => (grantRole = e.currentTarget.value as Role)}
					options={grantable.map((r) => ({ value: r, label: ROLE_WORD[r] }))}
				/>
			</div>
			<div class="end"><Button type="submit" variant="primary" size="xl">Save role</Button></div>
		</form>
		<p class="cl-caption cl-muted">
			A new reviewer's sessions and passkeys end when the role is raised; they add a passkey through an invite. Admin is granted only through
			the ops channel, once.
		</p>
	</section>

	{#if notice}<Notice tone={notice.tone} title={notice.text} />{/if}
	{#if invite}
		<section class="uin-card uin-card-lg uin-card-pad card" aria-labelledby="invite-title">
			<h2 class="cl-title" id="invite-title">Invite for {invite.email}</h2>
			<p class="cl-body cl-muted">
				Send this link through a channel you trust. It works once until {fmtDate(invite.expires)}, and only after they sign in with their
				email.
			</p>
			<p class="invite cl-figure">{invite.url}</p>
			<div class="end"><CopyButton text={invite.url} label="Copy the link" size="lg" /></div>
		</section>
	{/if}

	<section class="uin-card uin-card-lg uin-card-pad card" aria-labelledby="list-title">
		<h2 class="cl-title" id="list-title">{q.trim() ? 'Accounts' : 'Reviewers'}</h2>
		<form class="find" role="search" onsubmit={search}>
			<label class="cl-sr-only" for="people-q">Find an account by email</label>
			<Input id="people-q" size="lg" type="search" placeholder="Find by email" bind:value={q} />
			<Button type="submit" variant="secondary" size="xl"><Search size={16} aria-hidden="true" />Find</Button>
		</form>
		{#if people === null}
			<Loading />
		{:else if people.length === 0}
			<p class="cl-body cl-muted">No account matches.</p>
		{:else}
			<ul class="list">
				{#each people as p (p.id)}
					<li>
						<div class="who">
							<span class="email">{p.email}</span>
							<span class="cl-caption cl-muted">
								{ROLE_WORD[p.role]}{p.display_name ? `, ${p.display_name}` : ''} · {p.passkey_count === 1 ? '1 passkey' : `${p.passkey_count} passkeys`}{p.access_pinned
									? ' · bound to A3T Identity'
									: ''} · since {fmtDate(p.created_at)}
							</span>
						</div>
						<div class="actions">
							{#if canInvite(p)}<Button variant="secondary" size="md" onclick={() => issue(p)}>Invite</Button>{/if}
							{#if may('people.revoke') && p.id !== me.account.id && RANK[p.role] < mine}
								<Button variant="quiet" size="md" onclick={() => revoke(p)}>End every sign-in</Button>
							{/if}
							{#if may('people.email') && p.role === 'member'}
								<Button variant="quiet" size="md" onclick={() => ((moving = p), (move = { email: '', session: '', amount: '', date: '' }))}>Change email</Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<Dialog
	open={moving !== null}
	onOpenChange={(v) => !v && (moving = null)}
	title="Move {moving?.email} to a new address"
	description="Only for a member who lost their mailbox, after you matched their Stripe receipt. The move waits 7 days, and the old address gets a link to cancel it."
	size="md"
>
	<form id="move-form" class="move" onsubmit={moveEmail}>
		<div class="field">
			<label class="field-label" for="move-email">New email</label>
			<Input id="move-email" size="lg" type="email" bind:value={move.email} required />
		</div>
		<div class="field">
			<label class="field-label" for="move-session">Checkout Session ID from the receipt</label>
			<Input id="move-session" size="lg" placeholder="cs_live_..." bind:value={move.session} required />
		</div>
		<div class="field">
			<label class="field-label" for="move-amount">Amount charged, in dollars</label>
			<Input id="move-amount" size="lg" inputmode="decimal" bind:value={move.amount} required />
		</div>
		<div class="field">
			<label class="field-label" for="move-date">Charge date (UTC)</label>
			<Input id="move-date" size="lg" type="date" bind:value={move.date} required />
		</div>
	</form>
	{#snippet footer()}
		<button type="button" class="uin-btn uin-btn-ghost uin-btn-xl" onclick={() => (moving = null)}>Go back</button>
		<button type="submit" form="move-form" class="uin-btn uin-btn-primary uin-btn-xl">Move in 7 days</button>
	{/snippet}
</Dialog>

<style>
	.people {
		display: grid;
		gap: 24px;
		max-width: 960px;
	}
	.card {
		display: grid;
		gap: var(--cl-s3);
	}
	.grant {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) auto;
		align-items: end;
		gap: var(--cl-s3);
	}
	.find {
		display: flex;
		gap: var(--cl-s2);
	}
	.find :global(.uin-input) {
		flex: 1;
	}
	.list {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--cl-border);
	}
	.list li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--cl-s2) var(--cl-s4);
		padding: var(--cl-s3) 0;
		border-bottom: 1px solid var(--cl-border);
	}
	.who {
		display: grid;
		min-width: 0;
	}
	.email {
		font: var(--cl-body);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.actions,
	.end {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
	}
	.invite {
		padding: var(--cl-s3);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		overflow-wrap: anywhere;
	}
	.move {
		display: grid;
		gap: var(--cl-s3);
	}
	@media (max-width: 639px) {
		.grant {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
