<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { PLATFORMS, PLATFORM_NAME, type Platform } from '@colander/shared';
	import type { ItemSummary, QueueItem, ReviewSourceResponse } from '@colander/shared/api';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Kbd from '@colander/shared/components/ui/kbd/kbd.svelte';
	import '@colander/shared/components/ui/dialog/dialog.css';
	import Lock from '@lucide/svelte/icons/lock';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ColanderMark } from '@colander/shared';
	import { api, errorText } from '#lib/api.ts';
	import { fmtDateTime } from '#lib/format.ts';
	import { loadAccount, session } from '#lib/session.svelte.ts';
	import DecisionForm, { type Target } from '#lib/components/console/DecisionForm.svelte';
	import Evidence from '#lib/components/console/Evidence.svelte';
	import EmailSignIn from '#lib/components/EmailSignIn.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import VerdictOrNone from '#lib/components/VerdictOrNone.svelte';

	type Kind = 'all' | 'reports' | 'appeals' | 'escalations';
	const KIND_WORD: Record<QueueItem['kind'], string> = { report: 'Report', appeal: 'Appeal', escalation: 'Escalation' };

	let kind = $state<Kind>('all');
	let platform = $state<Platform | ''>('');
	let queue = $state<QueueItem[]>([]);
	let cursor = $state<string | null>(null);
	let queueStatus = $state<'loading' | 'ready' | 'more' | 'error'>('loading');
	let queueError = $state('');
	let active = $state(0);
	let openId = $state<string | null>(null);
	let detail = $state<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; data: ReviewSourceResponse } | { kind: 'error'; message: string }>({ kind: 'idle' });
	let target = $state<Target>({ kind: 'source' });
	let flash = $state('');
	let buttons: HTMLButtonElement[] = $state([]);

	const account = $derived(session.account);
	const canReview = $derived(account?.role === 'curator' || account?.role === 'staff');
	const shown = $derived(platform ? queue.filter((q) => q.platform === platform) : queue);
	const openItem = $derived(queue.find((q) => q.id === openId) ?? null);

	onMount(async () => {
		const a = await loadAccount();
		if (a && (a.role === 'curator' || a.role === 'staff')) loadQueue(false);
	});

	async function loadQueue(more: boolean) {
		queueStatus = more ? 'more' : 'loading';
		queueError = '';
		try {
			const q = new URLSearchParams({ kind });
			if (more && cursor) q.set('cursor', cursor);
			const res = await api<{ items: QueueItem[]; next_cursor: string | null }>(`/v1/review/queue?${q}`);
			queue = more ? [...queue, ...res.items] : res.items;
			cursor = res.next_cursor;
			if (!more) active = 0;
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
		if (e.metaKey || e.ctrlKey || e.altKey || !canReview) return;
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

	const age = (iso: string) => {
		const h = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
		return h < 1 ? 'Just now' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
	};
</script>

<svelte:window onkeydown={onKey} />

<svelte:head>
	<title>Review console · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap wrap-wide console-wrap">
	<header class="bar">
		<div class="bar-title">
			<h1 class="t-title">Review console</h1>
			{#if account && canReview}
				<span class="tag">{account.role === 'staff' ? 'Staff' : 'Curator'}{account.display_name ? `, ${account.display_name}` : ''}</span>
			{/if}
		</div>
		{#if canReview}
			<p class="keys t-caption muted" aria-hidden="true"><Kbd>J</Kbd><Kbd>K</Kbd> move <Kbd>Enter</Kbd> open</p>
			<p class="sr-only">Keyboard: J and K move through the queue, Enter opens the highlighted item.</p>
		{/if}
	</header>

	{#if session.status === 'idle' || session.status === 'loading'}
		<Loading label="Checking your sign-in" />
	{:else if !account}
		<div class="gate card">
			<h2 class="t-title">Sign in to review</h2>
			<p class="t-body muted">The console is for curators and staff. Every decision you make here is published in the decision log.</p>
			<EmailSignIn next="/console" />
		</div>
	{:else if !canReview}
		<div class="gate card">
			<h2 class="t-title icon-line"><Lock size={16} strokeWidth={1.75} aria-hidden="true" /> For curators and staff</h2>
			<p class="t-body muted">
				Your account is a member account. Curators are invited from the community of frequent, accurate taggers. Every
				decision is public in the <a href="/log">decision log</a>.
			</p>
		</div>
	{:else}
		<div class="console">
			<aside class="queue" aria-labelledby="queue-title">
				<h2 class="sr-only" id="queue-title">Queue</h2>
				<SegmentedControl
					ariaLabel="Queue kind"
					size="sm"
					value={kind}
					onChange={(v) => {
						kind = v;
						loadQueue(false);
					}}
					options={[
						{ value: 'all', label: 'All' },
						{ value: 'reports', label: 'Reports' },
						{ value: 'appeals', label: 'Appeals' },
						{ value: 'escalations', label: 'Escalations' }
					]}
				/>
				<div class="field">
					<label class="sr-only" for="queue-platform">Platform</label>
					<NativeSelect
						id="queue-platform"
						size="sm"
						value={platform}
						onchange={(e) => {
							platform = e.currentTarget.value as Platform | '';
							active = 0;
						}}
						options={[{ value: '', label: 'All platforms' }, ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))]}
					/>
				</div>

				{#if queueStatus === 'loading'}
					<Loading label="Loading the queue" />
				{:else if queueStatus === 'error'}
					<Notice tone="error" title="The queue could not load"><p>{queueError}</p></Notice>
					<button type="button" class="uin-btn uin-btn-outline uin-btn-sm" onclick={() => loadQueue(false)}><RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" /> Try again</button>
				{:else if shown.length === 0}
					<div class="queue-empty cl-dots"><p>The queue is empty.</p></div>
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
										<span class="q-kind">{KIND_WORD[q.kind]}</span>
										<span class="q-meta">{PLATFORM_NAME[q.platform]} · {age(q.created_at)}</span>
									</span>
									<span class="q-name">{q.source_name ?? q.source_id}</span>
									<span class="q-summary">{q.summary}</span>
									<span class="q-chips">
										<VerdictOrNone verdict={q.verdict} />
										{#if q.computed_verdict !== q.verdict}<span class="arrow" aria-label="scoring says">to</span><VerdictOrNone verdict={q.computed_verdict} />{/if}
										{#if q.large}<span class="q-flag"><Lock size={12} strokeWidth={1.75} aria-hidden="true" /> Large</span>{/if}
									</span>
								</button>
							</li>
						{/each}
					</ol>
					{#if cursor}
						<button type="button" class="uin-btn uin-btn-outline uin-btn-sm more" onclick={() => loadQueue(true)} disabled={queueStatus === 'more'}>Load more</button>
					{/if}
				{/if}
			</aside>

			<section class="detail" aria-label="Evidence and decision">
				{#if flash}<div class="flash"><Notice tone="success" title={flash} /></div>{/if}
				{#if detail.kind === 'idle'}
					<div class="detail-empty cl-dots">
						<div>
							<ColanderMark size={36} />
							<p class="t-title">Choose an item from the queue</p>
							<p class="t-body muted">Use J and K to move, and Enter to open. The evidence and the decision form appear here.</p>
						</div>
					</div>
				{:else if detail.kind === 'loading'}
					<Loading label="Loading the evidence" />
				{:else if detail.kind === 'error'}
					<Notice tone="error" title="The evidence could not load"><p>{detail.message}</p></Notice>
				{:else}
					<div class="detail-grid">
						<Evidence data={detail.data} queueItem={openItem} role={account.role} onDecideItem={decideItem} onChanged={changed} />
						<div class="decide card">
							<DecisionForm
								data={detail.data}
								{target}
								role={account.role}
								displayName={account.display_name}
								onDone={changed}
								onSourceTarget={() => (target = { kind: 'source' })}
							/>
						</div>
					</div>
				{/if}
			</section>
		</div>
		{#if openItem}<p class="sr-only" aria-live="polite">Opened {openItem.source_name ?? openItem.source_id}, created {fmtDateTime(openItem.created_at)}</p>{/if}
	{/if}
</div>

<style>
	.console-wrap {
		padding-top: var(--cl-s5);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--cl-s2) var(--cl-s4);
		padding-bottom: var(--cl-s4);
		margin-bottom: var(--cl-s5);
		border-bottom: 1px solid var(--cl-border);
	}
	.bar-title {
		display: flex;
		align-items: center;
		gap: var(--cl-s3);
	}
	.keys {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.gate {
		display: grid;
		gap: var(--cl-s3);
		max-width: 520px;
	}
	.console {
		display: grid;
		grid-template-columns: 320px minmax(0, 1fr);
		gap: var(--cl-s5);
		align-items: start;
	}
	.queue {
		display: grid;
		gap: var(--cl-s3);
		position: sticky;
		top: 16px;
		max-height: calc(100vh - 32px);
		overflow-y: auto;
		padding: 2px;
	}
	.queue :global(.uin-seg) {
		width: 100%;
	}
	.queue :global(.uin-seg-btn) {
		flex: 1;
		justify-content: center;
		padding-inline: 4px;
	}
	.queue-list {
		list-style: none;
		display: grid;
		gap: 6px;
	}
	.q {
		width: 100%;
		display: grid;
		gap: 4px;
		text-align: left;
		padding: 10px 12px;
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
		background: var(--cl-surface);
		cursor: pointer;
		font: var(--cl-body);
		transition: border-color var(--cl-fast) var(--cl-ease);
	}
	.q:hover {
		border-color: var(--w-control-border);
	}
	.q.active {
		border-color: var(--cl-text);
	}
	.q[aria-current='true'] {
		border-color: var(--cl-brand);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	.q-top {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.q-kind {
		font: 600 12px/16px var(--cl-font);
	}
	.q-meta {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.q-name {
		font: 600 15px/22px var(--cl-font);
		overflow-wrap: anywhere;
	}
	.q-summary {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.q-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 2px;
	}
	.arrow {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.q-flag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-left: auto;
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}
	.more {
		justify-self: center;
	}
	.queue-empty {
		min-height: 160px;
		display: grid;
		place-items: center;
		border-radius: var(--cl-r-card);
	}
	.queue-empty p {
		background: var(--cl-paper);
		padding: 4px 10px;
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	.detail {
		min-width: 0;
		display: grid;
		gap: var(--cl-s3);
	}
	.detail-empty {
		min-height: 420px;
		display: grid;
		place-items: center;
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
	}
	.detail-empty > div {
		display: grid;
		justify-items: center;
		gap: var(--cl-s2);
		max-width: 340px;
		padding: var(--cl-s5);
		text-align: center;
		background: var(--cl-paper);
		border-radius: var(--cl-r-card);
	}
	.detail-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: var(--cl-s5);
		align-items: start;
	}
	.decide {
		position: sticky;
		top: 16px;
		max-height: calc(100vh - 32px);
		overflow-y: auto;
	}
	@media (max-width: 1180px) {
		.detail-grid {
			grid-template-columns: 1fr;
		}
		.decide {
			position: static;
			max-height: none;
		}
	}
	@media (max-width: 860px) {
		.keys {
			display: none;
		}
		.console {
			grid-template-columns: 1fr;
		}
		.queue {
			position: static;
			max-height: none;
		}
	}
</style>
