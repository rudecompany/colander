<!--
The audit log on the admin host, for admins (docs/contracts.md 6.9): sign-ins, credential and role
changes, staff and ops actions and reads of personal data, newest first. Reading it is audited too.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { AuditEntry } from '@colander/shared/api';
	import { fmtDateTime, PageHeader } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import { may } from '#lib/admin.svelte.ts';
	import { api, errorText } from '#lib/api.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	let target = $state('');
	let entries = $state<AuditEntry[] | null>(null);
	let cursor = $state<string | null>(null);
	let error = $state('');

	onMount(() => {
		if (may('audit.read')) load(false);
	});

	async function load(more: boolean, event?: SubmitEvent) {
		event?.preventDefault();
		error = '';
		if (!more) entries = null;
		try {
			const q = new URLSearchParams();
			if (target.trim()) q.set('target', target.trim());
			if (more && cursor) q.set('before', cursor);
			const res = await api<{ entries: AuditEntry[]; next_cursor: string | null }>(`/v1/admin/audit${q.size ? `?${q}` : ''}`);
			entries = more ? [...(entries ?? []), ...res.entries] : res.entries;
			cursor = res.next_cursor;
		} catch (e) {
			entries = entries ?? [];
			error = errorText(e);
		}
	}

	const who = (e: AuditEntry) => e.actor_email ?? e.actor_sub ?? e.actor_id ?? (e.host === 'job' ? 'Colander' : 'the account itself');
	const change = (e: AuditEntry) => [e.before, e.after].filter(Boolean).join(' to ');
</script>

<svelte:head>
	<title>Audit log · Admin console · Colander</title>
</svelte:head>

<div class="cl-container page-top">
	<PageHeader variant="app" eyebrow="Admin console" title="Audit log" lede="Kept 400 days here, and copied every day to storage that cannot be changed." />
</div>

<div class="cl-container page-body audit">
	{#if !may('audit.read')}
		<Notice title="Only admins read the audit log" />
	{:else}
		<form class="find" role="search" onsubmit={(e) => load(false, e)}>
			<label class="cl-sr-only" for="audit-target">Filter by account ID</label>
			<Input id="audit-target" size="lg" placeholder="Account ID, like acc_..." bind:value={target} />
			<Button type="submit" variant="secondary" size="xl">Filter</Button>
		</form>
		{#if error}<Notice tone="error" title="The audit log could not load"><p>{error}</p></Notice>{/if}
		{#if entries === null}
			<Loading />
		{:else if entries.length === 0}
			<p class="cl-body cl-muted">Nothing recorded.</p>
		{:else}
			<div class="scroll">
				<table class="plain">
					<thead>
						<tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Who</th><th scope="col">Account</th><th scope="col">Detail</th></tr>
					</thead>
					<tbody>
						{#each entries as e (e.id)}
							<tr>
								<td class="cl-figure">{fmtDateTime(e.at)}</td>
								<td>{e.action.replaceAll('_', ' ')}</td>
								<td class="wrap">{who(e)} <span class="cl-muted">({e.host})</span></td>
								<td class="cl-figure wrap">{e.target ?? ''}</td>
								<td class="wrap">{[change(e), e.reason].filter(Boolean).join('; ')}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if cursor}<Button variant="secondary" size="lg" onclick={() => load(true)}>Load older</Button>{/if}
		{/if}
	{/if}
</div>

<style>
	.audit {
		display: grid;
		gap: 16px;
	}
	.find {
		display: flex;
		gap: var(--cl-s2);
		max-width: 560px;
	}
	.find :global(.uin-input) {
		flex: 1;
	}
	.scroll {
		overflow-x: auto;
	}
	.wrap {
		overflow-wrap: anywhere;
	}
</style>
