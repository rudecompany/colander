<!-- @component My reports: each report's status, updated from GET /v1/reports, and how many installs it protects. -->
<script lang="ts">
	import { VerdictChip } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import type { Report } from '@colander/shared/api';
	import { PLATFORM_NAME } from '@colander/shared/verdicts';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { SITE } from '../../lib/env';
	import { idSegment } from '../../lib/ids';
	import { K } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { fmtDate, fmtNum, send, stored } from '../../ui/store.svelte';

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
</script>

<Section id="reports" title="My reports" description="Sources you reported, and what reviewers decided. A verdict reaches every install with the next list update.">
	<Card>
		{#snippet aside()}
			<Button variant="outline" onclick={refresh} aria-busy={loading}><RefreshCw size={16} strokeWidth={1.75} />Refresh</Button>
		{/snippet}
		{#if offline}<p class="muted t-caption" role="status">Showing the last copy. Colander could not reach the server just now.</p>{/if}
		{#if reports.value.length === 0}
			<div class="empty">
				<div class="dots motif" aria-hidden="true"></div>
				<p>No reports yet.</p>
				<p class="muted t-caption">On a channel, profile or page, choose Report source.</p>
			</div>
		{:else}
			<ul class="list">
				{#each reports.value as r (r.id)}
					<li>
						<div class="who">
							<a href="{SITE}/s/{r.platform}/{idSegment(r.source_id)}" target="_blank" rel="noopener">{r.source_name || r.source_id}</a>
							<span class="t-caption muted">{PLATFORM_NAME[r.platform]} · reported {fmtDate(r.created_at)}</span>
						</div>
						<div class="status">
							{#if r.status === 'under_review'}
								<span class="uin-badge uin-badge-md uin-badge-neutral">Under review</span>
							{:else if r.status === 'dismissed'}
								<span class="uin-badge uin-badge-md uin-badge-neutral">Closed, no change</span>
							{:else}
								<VerdictChip verdict={r.status} />
							{/if}
							{#if r.protects > 0}<span class="t-caption muted">Protects <span class="cl-num">{fmtNum(r.protects)}</span> installs</span>{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>
</Section>

<style>
	.list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
	}
	.list li + li {
		border-top: 1px solid var(--cl-border);
	}
	.who,
	.status {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.status {
		align-items: flex-end;
	}
	.who a {
		font-weight: 600;
		text-decoration: none;
	}
	.who a:hover {
		text-decoration: underline;
	}
	.uin-badge-neutral {
		background: var(--cl-surface-raised);
		color: var(--cl-text);
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 24px 0;
		text-align: center;
	}
	.motif {
		width: 120px;
		height: 48px;
		margin-bottom: 8px;
	}
</style>
