<!--
@component The curator side panel: the review queue, the evidence for one source in one view
(layers, tags, reports, appeals, items, history) and the decision form. Uses a reviewer token
sent by the website's account page through externally_connectable, or pasted here.
-->
<script lang="ts">
	import { ColanderMark, VerdictChip } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import Checkbox from '@colander/shared/components/ui/checkbox/checkbox.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import type { DecisionInput, QueueItem, ReviewSourceResponse } from '@colander/shared/api';
	import {
		PLATFORM_NAME,
		SIGNAL_TEXT,
		SLOP_TYPES,
		SLOP_TYPE_WORD,
		TESTS,
		TEST_WORD,
		VERDICTS,
		VERDICT_WORD,
		type Signal,
		type SlopType,
		type Test,
		type Verdict
	} from '@colander/shared/verdicts';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Scale from '@lucide/svelte/icons/scale';
	import { SITE } from '../../lib/env';
	import { idSegment } from '../../lib/ids';
	import { K } from '../../lib/settings';
	import { ReviewError, review } from '../../ui/review';
	import { ago, fmtDate, stored } from '../../ui/store.svelte';

	const token = stored<string | undefined>(K.reviewerToken, undefined);
	let pasted = $state('');
	let kind = $state<'all' | 'reports' | 'appeals' | 'escalations'>('all');
	let items = $state<QueueItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let error = $state('');
	let unauthorized = $state(false);
	let open = $state<QueueItem | null>(null);
	let detail = $state<ReviewSourceResponse | null>(null);

	// Decision form
	let verdict = $state<Verdict | 'none'>('slop');
	let reason = $state('');
	let signals = $state<Signal[]>([]);
	let slopType = $state<SlopType | null>(null);
	let tests = $state<Test[]>([]);
	let large = $state(false);
	let formError = $state('');
	let saved = $state('');
	let saving = $state(false);

	function fail(e: unknown) {
		if (e instanceof ReviewError && e.status === 401) unauthorized = true;
		return e instanceof Error ? e.message : String(e);
	}

	async function loadQueue(more = false) {
		if (!token.value) return;
		loading = true;
		error = '';
		try {
			const r = await review.queue(token.value, kind, more ? cursor : null);
			items = more ? [...items, ...r.items] : r.items;
			cursor = r.next_cursor;
			unauthorized = false;
		} catch (e) {
			error = fail(e);
		}
		loading = false;
	}

	$effect(() => {
		if (token.ready && token.value) void loadQueue();
	});

	async function openItem(q: QueueItem) {
		open = q;
		detail = null;
		error = '';
		saved = '';
		formError = '';
		try {
			detail = await review.source(token.value!, q.platform, q.source_id);
			const s = detail.source;
			verdict = (q.computed_verdict ?? s.verdict ?? 'slop') as Verdict;
			signals = s.signals.filter((g) => RECORDABLE_SET.has(g));
			slopType = s.slop_type;
			tests = [...s.tests];
			large = s.large;
			reason = '';
		} catch (e) {
			error = fail(e);
		}
	}

	async function decide() {
		if (!open || !detail) return;
		formError = '';
		if (!reason.trim()) {
			formError = 'Write the reason. It is published in the decision log.';
			return;
		}
		saving = true;
		const body: DecisionInput = { verdict, reason: reason.trim(), signals, slop_type: verdict === 'slop' || verdict === 'likely_slop' ? slopType : null, tests, large };
		try {
			await review.decideSource(token.value!, open.platform, open.source_id, body);
			saved = 'Decision recorded. It reaches every install with the next list update.';
			await loadQueue();
		} catch (e) {
			formError = fail(e);
		}
		saving = false;
	}

	async function dismiss(reportId: string) {
		const why = reason.trim() || 'Reviewed: no change to the verdict.';
		try {
			await review.dismiss(token.value!, reportId, why);
			if (open) await openItem(open);
		} catch (e) {
			formError = fail(e);
		}
	}

	async function appeal(id: string, action: 'verify' | 'upheld' | 'denied') {
		try {
			if (action === 'verify') await review.verifyAppeal(token.value!, id);
			else await review.resolveAppeal(token.value!, id, action, reason.trim() || (action === 'upheld' ? 'Appeal upheld after review.' : 'Appeal denied after review.'));
			if (open) await openItem(open);
		} catch (e) {
			formError = fail(e);
		}
	}

	async function connect(e: Event) {
		e.preventDefault();
		const t = pasted.trim();
		if (!t) return;
		await chrome.storage.local.set({ [K.reviewerToken]: t });
		pasted = '';
		unauthorized = false;
	}

	async function signOut() {
		await chrome.storage.local.remove(K.reviewerToken);
		items = [];
		open = null;
		detail = null;
	}

	const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
	// Reviewers record evidence for the provenance and behavior layers only. Rubric, consensus,
	// staff review and appeal signals are computed by the server, which masks anything else out.
	const RECORDABLE: { name: string; signals: Signal[] }[] = [
		{ name: 'Provenance', signals: ['platform_label', 'content_credentials', 'creator_statement', 'watermark'] },
		{ name: 'Source behavior', signals: ['high_volume', 'mostly_ai', 'templated', 'near_duplicates', 'link_funnel', 'cross_posting'] }
	];
	const RECORDABLE_SET = new Set(RECORDABLE.flatMap((g) => g.signals));
	const KIND_WORD = { report: 'Report', appeal: 'Appeal', escalation: 'Escalation' } as const;
	const LAYERS = [
		['provenance', 'Provenance', 'Is it AI-made?'],
		['behavior', 'Source behavior', 'Is it mass-produced?'],
		['rubric', 'Content rubric', 'Low effort and hollow?'],
		['consensus', 'Community consensus', 'Do taggers agree?']
	] as const;
</script>

<div class="panel">
	<header class="head">
		<span class="brand"><ColanderMark size={20} /> Review</span>
		{#if token.value && !unauthorized}
			<div class="tools">
				<Button variant="ghost" class="quiet-muted" icon aria-label="Refresh" onclick={() => (open ? openItem(open) : loadQueue())}><RefreshCw size={16} strokeWidth={1.75} /></Button>
				<Button variant="ghost" class="quiet-muted" icon aria-label="Disconnect" onclick={signOut}><LogOut size={16} strokeWidth={1.75} /></Button>
			</div>
		{/if}
	</header>

	{#if !token.ready}
		<p class="pad muted">Loading</p>
	{:else if !token.value || unauthorized}
		<section class="signin">
			<div class="dots motif" aria-hidden="true"></div>
			<h1 class="t-title">Review for curators</h1>
			{#if unauthorized}
				<p class="warn" role="alert">Your reviewer token was not accepted. Connect again from your account page.</p>
			{:else}
				<p class="muted">Curators and staff review reports, appeals and escalations here. Open your account on the Colander website and choose Connect side panel, or paste a reviewer token.</p>
			{/if}
			<Button variant="primary" onclick={() => chrome.tabs.create({ url: `${SITE}/account` })}>Open my account</Button>
			<form class="paste" onsubmit={connect}>
				<label for="tok" class="t-caption muted">Reviewer token</label>
				<div class="row">
					<Input id="tok" type="password" bind:value={pasted} autocomplete="off" />
					<Button variant="outline" type="submit">Connect</Button>
				</div>
			</form>
		</section>
	{:else if open}
		<section class="detail">
			<Button variant="ghost" onclick={() => ((open = null), (detail = null))}><ArrowLeft size={16} strokeWidth={1.75} />Queue</Button>
			{#if error}<p class="warn pad" role="alert">{error}</p>{/if}
			{#if !detail}
				<p class="pad muted">Loading evidence</p>
			{:else}
				{@const s = detail.source}
				<div class="block">
					<div class="title-row">
						<h1 class="t-title">{s.name || s.id}</h1>
						{#if s.verdict}<VerdictChip verdict={s.verdict} />{:else}<span class="uin-badge uin-badge-md neutral">Not rated</span>{/if}
					</div>
					<p class="t-caption muted">{PLATFORM_NAME[s.platform]} · {s.aliases.join(' · ')}</p>
					{#if (s as { attribution?: string | null }).attribution}<p class="t-caption muted">Imported from {(s as { attribution?: string | null }).attribution}</p>{/if}
					<div class="flags">
						{#if s.large}<span class="uin-badge uin-badge-md neutral">Large source</span>{/if}
						{#if s.imported}<span class="uin-badge uin-badge-md neutral">Imported, not reviewed</span>{/if}
						{#if s.appeal_open}<span class="uin-badge uin-badge-md neutral"><Scale size={12} strokeWidth={1.75} />Appeal open</span>{/if}
						{#if open.computed_verdict && open.computed_verdict !== s.verdict}<span class="t-caption muted">Scoring says {VERDICT_WORD[open.computed_verdict]}</span>{/if}
					</div>
					<dl class="facts">
						<div><dt>Taggers</dt><dd class="cl-num">{s.evidence.taggers}</dd></div>
						<div><dt>Slop · fine · not</dt><dd class="cl-num">{s.evidence.tags.slop} · {s.evidence.tags.ai_fine} · {s.evidence.tags.not_slop}</dd></div>
						<div><dt>AI share</dt><dd class="cl-num">{s.evidence.ai_item_share == null ? 'n/a' : `${Math.round(s.evidence.ai_item_share * 100)}%`} of {s.evidence.items_seen}</dd></div>
						<div><dt>Uploads a day</dt><dd class="cl-num">{s.evidence.uploads_per_day ?? 'n/a'}</dd></div>
					</dl>
					<p class="t-caption muted">Re-scored {s.rescore_at ? fmtDate(s.rescore_at) : 'when it changes'} · <a href="{SITE}/s/{s.platform}/{idSegment(s.id)}" target="_blank" rel="noopener">Public page</a></p>
				</div>

				<div class="block">
					<h2>Layers</h2>
					<ul class="layers">
						{#each LAYERS as [key, name, q] (key)}
							{@const l = detail.layers[key]}
							<li class:met={l.met}>
								<span class="state" aria-label={l.met ? 'Met' : 'Not met'}>{#if l.met}<Check size={16} strokeWidth={2} />{:else}<X size={16} strokeWidth={2} />{/if}</span>
								<div>
									<p class="strong">{name} <span class="muted t-caption">{q}</span></p>
									<p class="t-caption">{l.detail}</p>
									{#if l.signals.length}<p class="t-caption muted">{l.signals.map((g) => SIGNAL_TEXT[g]).join('; ')}</p>{/if}
								</div>
							</li>
						{/each}
					</ul>
				</div>

				{#if detail.reports.length}
					<div class="block">
						<h2>Reports <span class="muted cl-num">{detail.reports.length}</span></h2>
						{#each detail.reports as r (r.id)}
							<div class="entry">
								<p>{r.reason}</p>
								<p class="t-caption muted">{fmtDate(r.created_at)}{r.slop_type ? ` · ${SLOP_TYPE_WORD[r.slop_type]}` : ''}{r.tests.length ? ` · ${r.tests.map((t) => TEST_WORD[t]).join(', ')}` : ''}</p>
								{#if r.examples.length}<p class="t-caption">Examples: {r.examples.join(', ')}</p>{/if}
								{#if r.status === 'under_review'}<Button variant="ghost" onclick={() => dismiss(r.id)}>Dismiss with no change</Button>{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if detail.appeals.length}
					<div class="block">
						<h2>Appeals</h2>
						{#each detail.appeals as a (a.id)}
							<div class="entry">
								<p>{a.statement}</p>
								<p class="t-caption muted">{a.status.replace('_', ' ')} · code {a.code} · {fmtDate(a.created_at)}</p>
								<div class="row">
									{#if a.status === 'pending_manual'}<Button variant="outline" onclick={() => appeal(a.id, 'verify')}>Code is on the account</Button>{/if}
									{#if a.status === 'under_review'}
										<Button variant="outline" onclick={() => appeal(a.id, 'upheld')}>Uphold</Button>
										<Button variant="outline" onclick={() => appeal(a.id, 'denied')}>Deny</Button>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}

				{#if detail.items.length}
					<div class="block">
						<h2>Items</h2>
						<ul class="items">
							{#each detail.items as it (it.id)}
								<li><span class="mono">{it.id}</span>{#if it.verdict}<VerdictChip verdict={it.verdict} />{/if}<span class="t-caption muted cl-num">{it.tags.slop} · {it.tags.ai_fine} · {it.tags.not_slop}</span></li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if detail.history.length}
					<div class="block">
						<h2>History</h2>
						<ol class="history">
							{#each detail.history as h (h.id)}
								<li><p class="t-caption"><strong>{h.from ? VERDICT_WORD[h.from] : 'Not rated'} to {h.to ? VERDICT_WORD[h.to] : 'not rated'}</strong> · {h.actor_name ?? h.actor} · {ago(Date.parse(h.at))}</p><p class="t-caption muted">{h.reason}</p></li>
							{/each}
						</ol>
					</div>
				{/if}

				<form class="block decide" onsubmit={(e) => (e.preventDefault(), decide())}>
					<h2>Decision</h2>
					<label for="verdict" class="t-caption muted">Verdict</label>
					<NativeSelect id="verdict" options={[...VERDICTS.map((v) => ({ value: v as string, label: VERDICT_WORD[v] })), { value: 'none', label: 'Not rated' }]} bind:value={verdict} />
					<label for="reason" class="t-caption muted">Reason, published in the decision log</label>
					<Textarea id="reason" bind:value={reason} rows={3} maxlength={500} />
					{#each RECORDABLE as group (group.name)}
						<fieldset>
							<legend class="t-caption muted">{group.name} signals</legend>
							<div class="signals">
								{#each group.signals as g (g)}
									<Checkbox label={SIGNAL_TEXT[g]} checked={signals.includes(g)} onchange={() => (signals = toggle(signals, g))} />
								{/each}
							</div>
						</fieldset>
					{/each}
					<p class="t-caption muted">Rubric, consensus, staff review and appeal signals are computed from tags and decisions.</p>
					{#if verdict === 'slop' || verdict === 'likely_slop'}
						<fieldset>
							<legend class="t-caption muted">Type</legend>
							<SegmentedControl options={[{ value: 'none', label: 'None' }, ...SLOP_TYPES.map((t) => ({ value: t as string, label: SLOP_TYPE_WORD[t] }))]} value={slopType ?? 'none'} onChange={(v) => (slopType = v === 'none' ? null : (v as SlopType))} ariaLabel="Type" />
						</fieldset>
					{/if}
					<fieldset>
						<legend class="t-caption muted">Tests</legend>
						<div class="row">{#each TESTS as t (t)}<Checkbox label={TEST_WORD[t]} checked={tests.includes(t)} onchange={() => (tests = toggle(tests, t))} />{/each}</div>
					</fieldset>
					<div class="row between"><span id="large-l">Large source, staff only</span><Switch checked={large} aria-labelledby="large-l" onCheckedChange={(v) => (large = v)} /></div>
					{#if formError}<p class="warn" role="alert">{formError}</p>{/if}
					{#if saved}<p class="ok" role="status">{saved}</p>{/if}
					<Button variant="primary" type="submit" aria-busy={saving}>Record decision</Button>
				</form>
			{/if}
		</section>
	{:else}
		<section class="queue">
			<div class="pad">
				<SegmentedControl
					options={[{ value: 'all', label: 'All' }, { value: 'reports', label: 'Reports' }, { value: 'appeals', label: 'Appeals' }, { value: 'escalations', label: 'Escalated' }]}
					value={kind}
					onChange={(v) => ((kind = v), loadQueue())}
					ariaLabel="Queue"
				/>
			</div>
			{#if error}<p class="warn pad" role="alert">{error}</p>{/if}
			{#if !loading && items.length === 0 && !error}
				<div class="empty">
					<div class="dots motif" aria-hidden="true"></div>
					<p>The queue is empty.</p>
				</div>
			{/if}
			<ul class="list">
				{#each items as q (q.id)}
					<li>
						<button type="button" class="q" onclick={() => openItem(q)}>
							<span class="q-top"><span class="strong">{q.source_name || q.source_id}</span><span class="t-caption muted">{ago(Date.parse(q.created_at))}</span></span>
							<span class="t-caption muted">{KIND_WORD[q.kind]} · {PLATFORM_NAME[q.platform]}{q.large ? ' · Large' : ''}{q.report_count ? ` · ${q.report_count} reports` : ''}</span>
							<span class="t-caption">{q.summary}</span>
							<span class="chips">
								{#if q.verdict}<VerdictChip verdict={q.verdict} />{/if}
								{#if q.computed_verdict && q.computed_verdict !== q.verdict}<span class="t-caption muted">scoring: {VERDICT_WORD[q.computed_verdict]}</span>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
			{#if cursor}<div class="pad"><Button variant="outline" onclick={() => loadQueue(true)} aria-busy={loading}>Load more</Button></div>{/if}
		</section>
	{/if}
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
	.head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 48px;
		padding: 0 8px 0 16px;
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-surface);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
	}
	.tools {
		display: flex;
		gap: 4px;
	}
	.pad {
		padding: 12px 16px;
	}
	.signin {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 16px;
		padding: 32px 16px;
	}
	.motif {
		width: 120px;
		height: 48px;
	}
	.paste {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}
	.paste .row {
		flex-wrap: nowrap;
	}
	.paste :global(.uin-input) {
		flex: 1;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.between {
		justify-content: space-between;
	}
	.warn {
		color: var(--cl-slop);
	}
	.ok {
		color: var(--cl-clear);
	}
	.list li + li {
		border-top: 1px solid var(--cl-border);
	}
	.q {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		padding: 12px 16px;
		border: 0;
		background: none;
		color: var(--cl-text);
		text-align: left;
		cursor: pointer;
	}
	.q:hover {
		background: var(--uin-mat-hover);
	}
	.q:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: -2px;
	}
	.q-top {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.chips {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}
	.strong {
		font-weight: 600;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 48px 16px;
		color: var(--cl-text-muted);
	}
	.detail {
		display: flex;
		flex-direction: column;
		padding: 8px 0 32px;
	}
	.detail > :global(.uin-btn) {
		align-self: flex-start;
		margin-left: 8px;
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border-bottom: 1px solid var(--cl-border);
	}
	.block h2 {
		font-weight: 600;
	}
	.title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.flags {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.neutral {
		background: var(--cl-surface-raised);
		color: var(--cl-text);
	}
	.facts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 16px;
	}
	dt {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	dd {
		font-weight: 600;
	}
	.layers li {
		display: flex;
		gap: 12px;
		padding: 8px 0;
	}
	.layers li + li {
		border-top: 1px solid var(--cl-border);
	}
	.state {
		display: grid;
		place-items: center;
		flex: none;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--cl-surface-raised);
		color: var(--cl-text-muted);
	}
	.met .state {
		background: var(--cl-clear-tint);
		color: var(--cl-clear);
	}
	.entry {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 12px;
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface-raised);
	}
	.items li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}
	.mono {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 12px;
	}
	.history li + li {
		margin-top: 8px;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend {
		margin-bottom: 4px;
		padding: 0;
	}
	.signals {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.decide :global(.uin-btn-primary) {
		align-self: flex-start;
		margin-top: 8px;
	}
</style>
