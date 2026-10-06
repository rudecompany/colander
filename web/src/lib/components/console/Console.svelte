<!--
@component The review console (docs/contracts.md 6.7): the queue on the left, evidence in the
middle, the decision on the right, with J, K and Enter. The page around it decides who may use it
and with what authority: curator authority on getcolander.com (/console), the account's full role
on the admin host (/admin).
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { PLATFORMS, PLATFORM_NAME, type Platform } from '@colander/shared';
	import type { ItemSummary, QueueItem, ReviewSourceResponse, Role } from '@colander/shared/api';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Tabs from '@colander/shared/components/ui/tabs/tabs.svelte';
	import Kbd from '@colander/shared/components/ui/kbd/kbd.svelte';
	import '@colander/shared/components/ui/dialog/dialog.css';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { PerforatedDisc, PlatformTag, fmtAgo } from '@colander/shared';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import { api, errorText } from '#lib/api.ts';
	import { fmtDateTime } from '@colander/shared';
	import DecisionForm, { type Target } from '#lib/components/console/DecisionForm.svelte';
	import Evidence from '#lib/components/console/Evidence.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { VerdictChip } from '@colander/shared';

	let { authority, name, calibrationHref }: { authority: Role; name: string | null; calibrationHref?: string } = $props();
	/** What the evidence and decision forms check: admins decide as staff. */
	const role = $derived<Role>(authority === 'curator' ? 'curator' : 'staff');

	type Kind = 'all' | 'reports' | 'appeals' | 'escalations';
	const KIND_WORD: Record<QueueItem['kind'], string> = { report: 'Report', appeal: 'Appeal', escalation: 'Escalation' };

	let kind = $state<Kind>('all');
	let platform = $state<Platform | ''>('');
	let queue = $state<QueueItem[]>([]);
	let cursor = $state<string | null>(null);
	// Escalations load apart: the server's kind=all carries only the seed leads a report, a slop tag
	// or a calibrated list backs, so thousands of leads cannot bury the reports, while
	// kind=escalations carries every lead, after the other escalations (contracts 6.7).
	let escalations = $state<QueueItem[]>([]);
	let escalationsCursor = $state<string | null>(null);
	let queueStatus = $state<'loading' | 'ready' | 'more' | 'error'>('loading');
	let queueError = $state('');
	let active = $state(0);
	let openId = $state<string | null>(null);
	let detail = $state<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; data: ReviewSourceResponse } | { kind: 'error'; message: string }>({ kind: 'idle' });
	let target = $state<Target>({ kind: 'source' });
	let flash = $state('');
	let buttons: HTMLButtonElement[] = $state([]);

	const KIND_OF: Record<Kind, QueueItem['kind'] | null> = { all: null, reports: 'report', appeals: 'appeal', escalations: null };
	const listOf = (k: Kind) => (k === 'escalations' ? escalations : queue);
	const count = (k: Kind) => listOf(k).filter((q) => !KIND_OF[k] || q.kind === KIND_OF[k]).length;
	const shown = $derived(listOf(kind).filter((q) => (!platform || q.platform === platform) && (!KIND_OF[kind] || q.kind === KIND_OF[kind])));
	const openItem = $derived(queue.find((q) => q.id === openId) ?? escalations.find((q) => q.id === openId) ?? null);
	const nextCursor = $derived(kind === 'escalations' ? escalationsCursor : cursor);

	onMount(() => loadQueue(false));

	const queuePage = (k: 'all' | 'escalations', after: string | null) => {
		const q = new URLSearchParams({ kind: k });
		if (after) q.set('cursor', after);
		return api<{ items: QueueItem[]; next_cursor: string | null }>(`/v1/review/queue?${q}`);
	};

	async function loadQueue(more: boolean) {
		queueStatus = more ? 'more' : 'loading';
		queueError = '';
		try {
			if (more && kind === 'escalations') {
				const res = await queuePage('escalations', escalationsCursor);
				escalations = [...escalations, ...res.items];
				escalationsCursor = res.next_cursor;
			} else if (more) {
				const res = await queuePage('all', cursor);
				queue = [...queue, ...res.items];
				cursor = res.next_cursor;
			} else {
				const [all, esc] = await Promise.all([queuePage('all', null), queuePage('escalations', null)]);
				queue = all.items;
				cursor = all.next_cursor;
				escalations = esc.items;
				escalationsCursor = esc.next_cursor;
				active = 0;
			}
			queueStatus = 'ready';
		} catch (e) {
			queueError = errorText(e);
			queueStatus = 'error';
		}
	}

	async function open(item: QueueItem) {
		openId = item.id;
		target = { kind: 'source' };
		flash = '';
		await loadDetail(item.platform, item.source_id);
	}

	async function loadDetail(p: Platform, sourceId: string) {
		detail = { kind: 'loading' };
		try {
			detail = { kind: 'ok', data: await api<ReviewSourceResponse>(`/v1/review/sources/${p}/${encodeURIComponent(sourceId)}`) };
		} catch (e) {
			detail = { kind: 'error', message: errorText(e) };
		}
	}

	async function changed(message: string) {
		flash = message;
		target = { kind: 'source' };
		if (openItem) await loadDetail(openItem.platform, openItem.source_id);
		loadQueue(false);
	}

	function decideItem(it: ItemSummary) {
		target = { kind: 'item', itemId: it.id, verdict: it.verdict, signals: it.signals };
		document.getElementById('decision-title')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	async function move(delta: number) {
		if (!shown.length) return;
		active = Math.min(shown.length - 1, Math.max(0, active + delta));
		await tick();
		buttons[active]?.focus();
	}

	function onKey(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const el = e.target as HTMLElement;
		if (el.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
		if (e.key === 'j') {
			e.preventDefault();
			move(1);
		} else if (e.key === 'k') {
			e.preventDefault();
			move(-1);
		} else if (e.key === 'Enter' && !el.closest('button, a') && shown[active]) {
			e.preventDefault();
			open(shown[active]);
		}
	}

	const age = (iso: string) => fmtAgo(iso);
	const AUTHORITY_WORD: Record<Role, string> = { member: 'Member', curator: 'Curator', staff: 'Staff', admin: 'Admin' };
</script>

<svelte:window onkeydown={onKey} />

<div class="cl-container console-wrap">
	<header class="bar">
		<h1 class="cl-title">Review queue</h1>
		<span class="uin-badge uin-badge-lg">{AUTHORITY_WORD[authority]}{name ? `, ${name}` : ''}</span>
		<p class="keys cl-caption cl-muted" aria-hidden="true"><Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>Enter</Kbd> open</p>
		{#if calibrationHref}<ArrowLink href={calibrationHref} size="sm">Calibration set</ArrowLink>{/if}
		<p class="sr-only">Keyboard: J and K move through the queue, Enter opens the highlighted item.</p>
	</header>

	<div class="console" class:opened={detail.kind === 'ok'}>
		<aside class="queue" aria-labelledby="queue-title">
			<h2 class="sr-only" id="queue-title">Queue</h2>
			<Tabs
				direction="horizontal"
				ariaLabel="Queue kind"
				bind:value={kind}
				onChange={() => (active = 0)}
				tabs={[
					{ value: 'all', label: 'All', count: count('all') },
					{ value: 'reports', label: 'Reports', count: count('reports') },
					{ value: 'appeals', label: 'Appeals', count: count('appeals') },
					{ value: 'escalations', label: 'Escalated', count: count('escalations') }
				]}
			/>
			<div class="field">
				<label class="sr-only" for="queue-platform">Platform</label>
				<NativeSelect
					id="queue-platform"
					size="md"
					value={platform}
					onchange={(e) => {
						platform = e.currentTarget.value as Platform | '';
						active = 0;
					}}
					options={[{ value: '', label: 'All platforms' }, ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))]}
				/>
			</div>

			{#if queueStatus === 'loading'}
				<Loading />
			{:else if queueStatus === 'error'}
				<Notice tone="error" title="The queue could not load"><p>{queueError}</p></Notice>
				<Button variant="secondary" size="md" onclick={() => loadQueue(false)}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
			{:else if shown.length === 0}
				<div class="queue-empty"><PerforatedDisc size={64} /><p>The queue is empty.</p></div>
			{:else}
				<ol class="queue-list">
					{#each shown as q, i (q.id)}
						<li>
							<button
								type="button"
								class="q"
								class:active={i === active}
								aria-current={q.id === openId ? 'true' : undefined}
								bind:this={buttons[i]}
								onfocus={() => (active = i)}
								onclick={() => open(q)}
							>
								<span class="q-top">
									<PlatformTag platform={q.platform} />
									<span class="q-kind">{q.lead ? 'Seed lead' : KIND_WORD[q.kind]}</span>
									{#if q.report_count > 0}<span class="q-meta">{q.report_count} {q.report_count === 1 ? 'report' : 'reports'}</span>{/if}
									{#if q.large}<span class="uin-badge uin-badge-md">Large source</span>{/if}
									<span class="cl-figure q-age">{age(q.created_at)}</span>
								</span>
								<span class="q-line">
									<span class="q-name">{q.source_name ?? q.source_id}</span>
									<VerdictChip verdict={q.verdict} size="sm" />
								</span>
								<span class="sr-only">{q.summary}</span>
							</button>
						</li>
					{/each}
				</ol>
				{#if nextCursor}
					<Button variant="secondary" size="md" block onclick={() => loadQueue(true)} loading={queueStatus === 'more'}>Load more</Button>
				{/if}
			{/if}
		</aside>

		{#if detail.kind === 'ok'}
			<section class="detail" aria-label="Evidence">
				{#if flash}<Notice tone="success" title={flash} />{/if}
				<Evidence data={detail.data} queueItem={openItem} {role} onDecideItem={decideItem} onChanged={changed} />
			</section>
			<aside class="decide uin-card uin-card-md uin-card-pad" aria-label="Decision">
				<DecisionForm
					data={detail.data}
					{target}
					{role}
					displayName={name}
					onDone={changed}
					onSourceTarget={() => (target = { kind: 'source' })}
				/>
			</aside>
		{:else}
			<section class="detail span" aria-label="Evidence and decision">
				{#if flash}<Notice tone="success" title={flash} />{/if}
				{#if detail.kind === 'idle'}
					<div class="detail-empty">
						<PerforatedDisc size={160} mark={64} />
						<p class="cl-title">Choose an item from the queue</p>
						<p class="cl-muted">Use J and K to move, and Enter to open. The evidence and the decision form appear here.</p>
					</div>
				{:else if detail.kind === 'loading'}
					<Loading />
				{:else}
					<Notice tone="error" title="The evidence could not load"><p>{detail.message}</p></Notice>
				{/if}
			</section>
		{/if}
	</div>
	{#if openItem}<p class="sr-only" aria-live="polite">Opened {openItem.source_name ?? openItem.source_id}, created {fmtDateTime(openItem.created_at)}</p>{/if}
</div>

<style>
	.console-wrap {
		padding-block: 24px 64px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding-bottom: 16px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--cl-border);
	}
	.keys {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-left: auto;
	}
	.console {
		display: grid;
		grid-template-columns: 360px minmax(0, 1fr) 360px;
		gap: 24px;
		align-items: start;
	}
	.span {
		grid-column: 2 / -1;
	}
	.queue {
		position: sticky;
		top: 88px;
		display: grid;
		gap: 12px;
		max-height: calc(100vh - 112px);
		overflow-y: auto;
		padding: 2px;
	}
	.queue-list {
		display: grid;
		list-style: none;
		border-top: 1px solid var(--cl-border);
	}
	.q {
		display: grid;
		align-content: center;
		gap: 6px;
		width: 100%;
		min-height: 64px;
		padding: 8px 8px;
		border: 0;
		border-bottom: 1px solid var(--cl-border);
		border-radius: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		font: var(--cl-body);
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.q:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	.q.active {
		box-shadow: inset 2px 0 0 var(--cl-text);
	}
	.q[aria-current='true'] {
		background: var(--cl-brand-tint);
		box-shadow: inset 2px 0 0 var(--cl-brand);
	}
	.q-top,
	.q-line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	/* A busy row (kind, report count, Large source, date) wraps whole words instead of breaking "4 reports". */
	.q-top {
		flex-wrap: wrap;
		row-gap: 4px;
	}
	.q-kind {
		font: var(--cl-chip);
	}
	.q-meta {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
		white-space: nowrap;
	}
	.q-age {
		margin-left: auto;
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
	.q-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font: var(--cl-body-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.queue-empty {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding: 32px 0;
		color: var(--cl-text-muted);
	}
	.detail {
		display: grid;
		gap: 16px;
		min-width: 0;
	}
	.detail-empty {
		display: grid;
		justify-items: center;
		gap: 12px;
		min-height: 420px;
		align-content: center;
		padding: 32px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		text-align: center;
	}
	.detail-empty p:last-child {
		max-width: 340px;
	}
	.decide {
		position: sticky;
		top: 88px;
		max-height: calc(100vh - 112px);
		overflow-y: auto;
	}
	@media (max-width: 1199px) {
		.console {
			grid-template-columns: 360px minmax(0, 1fr);
		}
		.span {
			grid-column: 2;
		}
		.decide {
			grid-column: 2;
			position: static;
			max-height: none;
		}
	}
	@media (max-width: 799px) {
		.keys {
			display: none;
		}
		.console {
			grid-template-columns: minmax(0, 1fr);
		}
		.span,
		.decide {
			grid-column: 1;
		}
		.queue {
			position: static;
			max-height: none;
		}
	}
</style>
