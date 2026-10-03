<!-- @component Everything known about one source, in one view: layers, tags, reports, appeals, items and history. -->
<script lang="ts">
	import {
		PLATFORM_NAME,
		SIGNAL_TEXT,
		SLOP_TYPE_WORD,
		SOURCE_NOUN,
		TEST_WORD
	} from '@colander/shared';
	import type { Appeal, ItemSummary, QueueItem, ReviewSourceResponse, Role } from '@colander/shared/api';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Lock from '@lucide/svelte/icons/lock';
	import { api, errorText } from '#lib/api.ts';
	import { fmtDateTime, fmtNum, fmtPct, platformItemUrl, platformSourceUrl, sourcePath } from '@colander/shared';
	import { LAYER_KEYS, LAYER_QUESTION, LAYER_WORD } from '@colander/shared';
	import { LogRow } from '@colander/shared';
	import Notice from '../Notice.svelte';
	import { VerdictChip } from '@colander/shared';

	let {
		data,
		queueItem,
		role,
		onDecideItem,
		onChanged
	}: {
		data: ReviewSourceResponse;
		queueItem: QueueItem | null;
		role: Role;
		onDecideItem: (item: ItemSummary) => void;
		onChanged: (message: string) => void;
	} = $props();

	const s = $derived(data.source);
	const noun = $derived(SOURCE_NOUN[s.platform]);
	const isStaff = $derived(role === 'staff');

	let dismissing = $state<string | null>(null);
	let dismissReason = $state('');
	let resolving = $state<string | null>(null);
	let outcome = $state<'upheld' | 'denied' | ''>('');
	let reasoning = $state('');
	let actionError = $state('');
	let busy = $state(false);

	async function act(path: string, body: unknown, message: string) {
		busy = true;
		actionError = '';
		try {
			await api(path, { method: 'POST', body });
			dismissing = null;
			resolving = null;
			onChanged(message);
		} catch (e) {
			actionError = errorText(e);
		} finally {
			busy = false;
		}
	}

	const APPEAL_STATUS: Record<Appeal['status'], string> = {
		awaiting_verification: 'Waiting for the code',
		pending_manual: 'Needs a manual code check',
		under_review: 'Under review',
		upheld: 'Upheld',
		denied: 'Denied',
		expired: 'Expired'
	};
</script>

<article class="evidence" aria-labelledby="ev-title">
	<header class="ev-head">
		<p class="cl-eyebrow">{PLATFORM_NAME[s.platform]} {noun}</p>
		<h2 class="cl-display" id="ev-title">{s.name ?? s.id}</h2>
		<p class="ids">{#each s.aliases as a (a)}<span class="cl-figure id">{a}</span>{/each}</p>
		<div class="verdict-row">
			<span class="vr"><span class="vr-label">Current</span><VerdictChip verdict={s.verdict} /></span>
			{#if queueItem}
				<span class="vr"><span class="vr-label">Scoring says</span><VerdictChip verdict={queueItem.computed_verdict} /></span>
			{/if}
			{#if s.large}<span class="uin-badge uin-badge-md"><Lock size={12} aria-hidden="true" /> Large audience</span>{/if}
			{#if s.imported}<span class="uin-badge uin-badge-md">Imported, not reviewed</span>{/if}
			{#if s.appeal_open}<span class="uin-badge uin-badge-md">Appeal open</span>{/if}
		</div>
		<p class="links">
			<a class="icon-line" href={platformSourceUrl(s.platform, s.id)} rel="noreferrer" target="_blank">
				Open on {PLATFORM_NAME[s.platform]} <ExternalLink size={14} aria-hidden="true" />
			</a>
			<a href={sourcePath(s.platform, s.id)} target="_blank">Public source page</a>
		</p>
	</header>

	{#if actionError}<Notice tone="error" title="That did not go through"><p>{actionError}</p></Notice>{/if}

	<section aria-labelledby="layers-title" class="sec">
		<h3 class="sec-title" id="layers-title">Evidence layers</h3>
		<div class="layers">
			{#each LAYER_KEYS as k (k)}
				{@const l = data.layers[k]}
				<div class="layer" class:met={l.met}>
					<p class="layer-top">
						<span class="layer-name">{LAYER_WORD[k]}</span>
						<span class="status">
							{#if l.met}<Check size={14} strokeWidth={2} aria-hidden="true" /> Met{:else}<X size={14} strokeWidth={2} aria-hidden="true" /> Not met{/if}
						</span>
					</p>
					<p class="layer-q">{LAYER_QUESTION[k]}</p>
					<p class="layer-detail">{l.detail}</p>
					{#if l.signals.length}
						<ul class="sig">{#each l.signals as sig (sig)}<li>{SIGNAL_TEXT[sig]}</li>{/each}</ul>
					{/if}
				</div>
			{/each}
		</div>
		<dl class="numbers">
			<div><dt>Taggers</dt><dd class="cl-num">{fmtNum(s.evidence.taggers)}</dd></div>
			<div><dt>Slop / fine / not slop</dt><dd class="cl-num">{s.evidence.tags.slop} / {s.evidence.tags.ai_fine} / {s.evidence.tags.not_slop}</dd></div>
			<div><dt>AI item share</dt><dd class="cl-num">{s.evidence.ai_item_share === null ? 'No data' : `${fmtPct(s.evidence.ai_item_share)} of ${s.evidence.items_seen}`}</dd></div>
			<div><dt>Uploads a day</dt><dd class="cl-num">{s.evidence.uploads_per_day ?? 'No data'}</dd></div>
		</dl>
	</section>

	<section aria-labelledby="reports-title" class="sec">
		<h3 class="sec-title" id="reports-title">Reports <span class="count">{data.reports.length}</span></h3>
		{#if data.reports.length === 0}
			<p class="cl-body cl-muted">No reports on this {noun}.</p>
		{:else}
			<ul class="cards">
				{#each data.reports as r (r.id)}
					<li class="item-card">
						<p class="meta">{fmtDateTime(r.created_at)} · {r.status === 'under_review' ? 'Under review' : r.status}</p>
						<p class="cl-body">{r.reason}</p>
						<p class="meta">
							{#if r.slop_type}Type: {SLOP_TYPE_WORD[r.slop_type]}.{/if}
							{#if r.tests.length}Tests: {r.tests.map((t) => TEST_WORD[t]).join(', ')}.{/if}
						</p>
						{#if r.examples.length}
							<p class="examples">
								<span class="meta">Examples:</span>
								{#each r.examples as ex (ex)}
									<a class="cl-figure icon-line id" href={platformItemUrl(s.platform, ex, s.id)} rel="noreferrer" target="_blank">{ex} <ExternalLink size={16} aria-hidden="true" /></a>
								{/each}
							</p>
						{/if}
						{#if r.status === 'under_review'}
							{#if dismissing === r.id}
								<div class="inline-form">
									<label class="field-label" for="dismiss-{r.id}">Why dismiss it?</label>
									<Textarea id="dismiss-{r.id}" rows={2} bind:value={dismissReason} />
									<div class="row">
										<button type="button" class="uin-btn uin-btn-primary uin-btn-lg" disabled={busy || dismissReason.trim().length < 5} onclick={() => act(`/v1/review/reports/${r.id}/dismiss`, { reason: dismissReason.trim() }, 'Report dismissed.')}>Dismiss report</button>
										<button type="button" class="uin-btn uin-btn-ghost uin-btn-lg" onclick={() => (dismissing = null)}>Cancel</button>
									</div>
								</div>
							{:else}
								<button type="button" class="uin-btn uin-btn-outline uin-btn-lg" onclick={() => ((dismissing = r.id), (dismissReason = ''))}>Dismiss with no change</button>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.appeals.length}
		<section aria-labelledby="appeals-title" class="sec">
			<h3 class="sec-title" id="appeals-title">Appeals <span class="count">{data.appeals.length}</span></h3>
			{#if !isStaff}
				<p class="cl-body cl-muted icon-line"><Lock size={16} aria-hidden="true" /> Verifying and resolving appeals needs staff.</p>
			{/if}
			<ul class="cards">
				{#each data.appeals as a (a.id)}
					<li class="item-card">
						<p class="meta">{fmtDateTime(a.created_at)} · <strong>{APPEAL_STATUS[a.status]}</strong> · Code <span class="cl-figure id">{a.code}</span></p>
						<p class="cl-body quote">{a.statement}</p>
						{#if isStaff && a.status === 'pending_manual'}
							<div class="row">
								<a class="uin-btn uin-btn-ghost uin-btn-lg icon-line" href={platformSourceUrl(s.platform, s.id)} rel="noreferrer" target="_blank">Look for the code <ExternalLink size={16} aria-hidden="true" /></a>
								<button type="button" class="uin-btn uin-btn-outline uin-btn-lg" disabled={busy} onclick={() => act(`/v1/review/appeals/${a.id}/verify`, {}, 'Appeal verified. The source now shows as Disputed.')}>The code is on the {noun}</button>
							</div>
						{/if}
						{#if isStaff && a.status === 'under_review'}
							{#if resolving === a.id}
								<fieldset class="inline-form">
									<legend class="field-label">Outcome</legend>
									<div class="row">
										<label class="radio"><input type="radio" name="outcome-{a.id}" value="upheld" bind:group={outcome} /> Upheld: set Clear</label>
										<label class="radio"><input type="radio" name="outcome-{a.id}" value="denied" bind:group={outcome} /> Denied: restore the scored verdict</label>
									</div>
									<label class="field-label" for="reasoning-{a.id}">Reasoning, published in the log</label>
									<Textarea id="reasoning-{a.id}" rows={3} bind:value={reasoning} />
									<div class="row">
										<button type="button" class="uin-btn uin-btn-primary uin-btn-lg" disabled={busy || !outcome || reasoning.trim().length < 10} onclick={() => act(`/v1/review/appeals/${a.id}/resolve`, { outcome, reasoning: reasoning.trim() }, 'Appeal resolved and logged.')}>Resolve appeal</button>
										<button type="button" class="uin-btn uin-btn-ghost uin-btn-lg" onclick={() => (resolving = null)}>Cancel</button>
									</div>
								</fieldset>
							{:else}
								<button type="button" class="uin-btn uin-btn-outline uin-btn-lg" onclick={() => ((resolving = a.id), (outcome = ''), (reasoning = ''))}>Resolve</button>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section aria-labelledby="items-title" class="sec">
		<h3 class="sec-title" id="items-title">Items <span class="count">{data.items.length}</span></h3>
		{#if data.items.length === 0}
			<p class="cl-body cl-muted">No items recorded.</p>
		{:else}
			<div class="table-scroll">
				<table class="plain items stack-sm">
					<thead><tr><th scope="col">Item</th><th scope="col">Verdict</th><th scope="col">Slop / fine / not slop</th><th scope="col">AI label seen</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead>
					<tbody>
						{#each data.items as it (it.id)}
							<tr>
								<th scope="row"><a class="cl-figure icon-line id" href={platformItemUrl(it.platform, it.id, s.id)} rel="noreferrer" target="_blank">{it.id} <ExternalLink size={16} aria-hidden="true" /></a></th>
								<td data-label="Verdict"><VerdictChip verdict={it.verdict} /></td>
								<td class="cl-num" data-label="Slop / fine / not slop">{it.tags.slop} / {it.tags.ai_fine} / {it.tags.not_slop}</td>
								<td class="cl-num" data-label="AI label seen">{it.platform_label_reports} {it.platform_label_reports === 1 ? 'report' : 'reports'}</td>
								<td><button type="button" class="uin-btn uin-btn-ghost uin-btn-lg" onclick={() => onDecideItem(it)}>Decide item</button></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section aria-labelledby="hist-title" class="sec">
		<h3 class="sec-title" id="hist-title">History</h3>
		{#if data.history.length === 0}
			<p class="cl-body cl-muted">No decisions logged yet.</p>
		{:else}
			<ol class="history">
				{#each data.history as e (e.id)}<li><LogRow entry={e} /></li>{/each}
			</ol>
		{/if}
	</section>
</article>

<style>
	.id {
		overflow-wrap: anywhere;
	}
	.evidence {
		display: grid;
		gap: var(--cl-s5);
		min-width: 0;
	}
	.ev-head {
		display: grid;
		gap: var(--cl-s2);
	}
	.ev-head .cl-display {
		overflow-wrap: anywhere;
	}
	.ids {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s1) var(--cl-s4);
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	.verdict-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		margin-top: 4px;
	}
	.vr {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.vr-label {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s1) var(--cl-s5);
		font: 600 14px/20px var(--cl-font);
	}
	.sec {
		display: grid;
		gap: var(--cl-s3);
		padding-top: var(--cl-s4);
		border-top: 1px solid var(--cl-border);
	}
	.sec-title {
		font: 600 16px/24px var(--cl-font);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.count {
		min-width: 20px;
		padding: 0 var(--cl-s1);
		border-radius: var(--cl-r-full);
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
		font: 600 12px/20px var(--cl-font);
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
	.layers {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s3);
	}
	.layer {
		display: grid;
		gap: var(--cl-s1);
		align-content: start;
		padding: var(--cl-s3) var(--cl-s4);
		border-radius: var(--cl-r-card);
		border: 1px dashed var(--cl-border-strong);
		background: transparent;
	}
	.layer.met {
		border: 1px solid var(--cl-border);
		background: var(--cl-surface);
	}
	.layer-top {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.layer-name {
		font: 600 14px/20px var(--cl-font);
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font: 600 12px/20px var(--cl-font);
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
	.met .status {
		color: var(--cl-text);
	}
	.layer-q {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.layer-detail {
		font: var(--cl-body);
	}
	.sig {
		padding-left: 16px;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.numbers {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--cl-s3);
	}
	.numbers dt {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.numbers dd {
		font: 600 14px/20px var(--cl-font);
	}
	.cards {
		list-style: none;
		display: grid;
		gap: var(--cl-s2);
	}
	.item-card {
		display: grid;
		gap: var(--cl-s2);
		justify-items: start;
		padding: var(--cl-s3) var(--cl-s4);
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
		background: var(--cl-surface);
	}
	.meta {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.examples {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		font: var(--cl-caption);
	}
	.quote {
		padding-left: var(--cl-s3);
		border-left: 2px solid var(--cl-border);
	}
	.inline-form {
		display: grid;
		gap: 8px;
		width: 100%;
		border: 0;
		margin: 0;
		padding: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
		align-items: center;
	}
	.radio {
		display: inline-flex;
		align-items: center;
		gap: var(--cl-s2);
		font: var(--cl-body);
		min-height: 32px;
	}
	.radio input {
		accent-color: var(--cl-brand);
		width: 16px;
		height: 16px;
	}
	.items th[scope='row'] {
		color: var(--cl-text);
		font-weight: 400;
	}
	.items td,
	.items th {
		vertical-align: middle;
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.history {
		list-style: none;
	}
	.history li + li {
		border-top: 1px solid var(--cl-border);
	}
	.history :global(.entry) {
		grid-template-columns: 1fr;
		padding-block: var(--cl-s3);
	}
	.history :global(.entry .when) {
		display: flex;
		gap: 8px;
	}
	@media (max-width: 720px) {
		.layers {
			grid-template-columns: 1fr;
		}
		.numbers {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
