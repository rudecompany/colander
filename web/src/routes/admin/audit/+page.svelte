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
	const what = (e: AuditEntry) => e.action.replaceAll('_', ' ');
	const detail = (e: AuditEntry) => [[e.before, e.after].filter(Boolean).join(' to '), e.reason].filter(Boolean).join('; ');
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
			<!-- A table where five columns fit; on a phone, one entry under the other. -->
			<div class="scroll wide">
				<table class="plain">
					<thead>
						<tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Who</th><th scope="col">Account</th><th scope="col">Detail</th></tr>
					</thead>
					<tbody>
						{#each entries as e (e.id)}
							<tr>
								<td class="cl-figure nowrap">{fmtDateTime(e.at)}</td>
								<td>{what(e)}</td>
								<td><span class="nowrap">{who(e)}</span> <span class="cl-muted nowrap">({e.host})</span></td>
								<td class="cl-figure nowrap">{e.target ?? ''}</td>
								<td class="detail">{detail(e)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<ol class="entries narrow">
				{#each entries as e (e.id)}
					<li>
						<p class="head"><span class="what">{what(e)}</span><span class="cl-caption cl-muted cl-figure">{fmtDateTime(e.at)}</span></p>
						<dl>
							<dt>Who</dt>
							<dd>{who(e)} <span class="cl-muted">({e.host})</span></dd>
							{#if e.target}<dt>Account</dt><dd class="cl-figure">{e.target}</dd>{/if}
							{#if detail(e)}<dt>Detail</dt><dd>{detail(e)}</dd>{/if}
						</dl>
					</li>
				{/each}
			</ol>
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
	/* Times, addresses and IDs stay whole; the table scrolls sideways before it splits them. */
	.nowrap {
		white-space: nowrap;
	}
	.detail {
		min-width: 16ch;
		overflow-wrap: break-word;
	}
	.entries {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--cl-border);
	}
	.entries li {
		display: grid;
		gap: var(--cl-s1);
		padding: var(--cl-s3) 0;
		border-bottom: 1px solid var(--cl-border);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 var(--cl-s3);
		margin: 0;
	}
	.what {
		font: var(--cl-body);
		font-weight: 600;
	}
	dl {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--cl-s1) var(--cl-s3);
		margin: 0;
		font: var(--cl-body);
	}
	dt {
		color: var(--cl-text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: break-word;
	}
	.narrow {
		display: none;
	}
	@media (max-width: 639px) {
		.wide {
			display: none;
		}
		.narrow {
			display: grid;
		}
	}
</style>
