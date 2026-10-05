<!--
@component My reports: each report's status from GET /v1/reports. A row opens to where it is in
review and how many installs its verdict protects.
-->
<script lang="ts">
	import { Lifecycle, PageHeader, PerforatedDisc, PlatformTag, VerdictChip, type LifecycleStep } from '@colander/shared';
	import { fmtNum, fmtShortDate, sourcePath } from '@colander/shared/format';
	import type { Report } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { SITE } from '../../lib/env';
	import { K } from '../../lib/settings';
	import { send, stored } from '../../ui/store.svelte';

	const reports = stored<Report[]>(K.reports, []);
	let loading = $state(false);
	let offline = $state(false);

	async function refresh() {
		loading = true;
		const r = await send<{ ok: boolean }>({ type: 'refresh-reports' }).catch(() => ({ ok: false }));
		offline = !r.ok;
		loading = false;
	}
	void refresh();

	function steps(r: Report): LifecycleStep[] {
		const decided = r.status !== 'under_review';
		return [
			{ label: 'Sent', state: 'done', detail: fmtShortDate(r.created_at) },
			{ label: 'Under review', state: decided ? 'done' : 'current' },
			{ label: 'Decision', state: decided ? 'done' : 'later', detail: decided ? fmtShortDate(r.updated_at) : undefined }
		];
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="My reports" lede="Sources you reported, and what reviewers decided. A verdict reaches every install with the next list update." />

<div class="cards">
	{#if offline}
		<p class="notice" role="status"><CircleAlert size={16} aria-hidden="true" />Showing the last copy. Colander could not reach the server just now.</p>
	{/if}
	<Card title="Your reports" headingLevel={2}>
		{#snippet aside()}
			<Button variant="quiet" onclick={refresh} loading={loading}><RefreshCw size={16} aria-hidden="true" />Refresh</Button>
		{/snippet}
		{#if reports.value.length === 0}
			<div class="empty">
				<PerforatedDisc size={64} />
				<div>
					<p class="strong">No reports yet.</p>
					<p class="muted">On a channel, profile or page, choose Report source.</p>
				</div>
			</div>
		{:else}
			<ul class="list">
				{#each reports.value as r (r.id)}
					<li>
						<details>
							<summary>
								<PlatformTag platform={r.platform} />
								<span class="name">{r.source_name || r.source_id}</span>
								<span class="status">
									{#if r.status === 'under_review'}
										<span class="uin-badge uin-badge-md">Under review</span>
									{:else if r.status === 'dismissed'}
										<span class="uin-badge uin-badge-md">Closed, no change</span>
									{:else}
										<VerdictChip verdict={r.status} size="sm" />
									{/if}
								</span>
								<span class="cl-figure date">{fmtShortDate(r.created_at)}</span>
								<ChevronDown size={16} aria-hidden="true" />
							</summary>
							<div class="more">
								<Lifecycle steps={steps(r)} direction="horizontal" label="Where this report is" />
								<p>{r.protects > 0 ? `Protects ${fmtNum(r.protects)} installs` : r.status === 'under_review' ? 'Reviewers have not decided yet.' : 'No installs changed.'}</p>
								<a class="cl-link" href="{SITE}{sourcePath(r.platform, r.source_id)}" target="_blank" rel="noopener">Source page<ArrowRight size={16} aria-hidden="true" /></a>
							</div>
						</details>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 8px 0;
	}
	.strong {
		font: var(--cl-body-strong);
	}
	.muted {
		color: var(--cl-text-muted);
	}
	.list {
		border-top: 1px solid var(--cl-border);
	}
	.list li {
		border-bottom: 1px solid var(--cl-border);
	}
	summary {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
		border-radius: var(--cl-r-chip);
	}
	summary :global(.lucide-chevron-down) {
		color: var(--cl-text-muted);
		transition: transform var(--cl-fast) var(--cl-ease);
	}
	details[open] summary :global(.lucide-chevron-down) {
		transform: rotate(180deg);
	}
	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font: var(--cl-body-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.date {
		color: var(--cl-text-muted);
	}
	.more {
		display: grid;
		justify-items: start;
		gap: 12px;
		padding: 4px 0 16px;
	}
	.more :global(.lc) {
		width: 100%;
		max-width: 480px;
	}
</style>
