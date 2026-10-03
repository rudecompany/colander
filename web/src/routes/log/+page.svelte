<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		EvidenceCard,
		LiveBadge,
		LogRow,
		PageHeader,
		PLATFORMS,
		PLATFORM_NAME,
		StatCell,
		VerdictTally,
		VERDICTS,
		VERDICT_WORD,
		fmtDay,
		isPlatform,
		plural,
		type Platform,
		type Verdict
	} from '@colander/shared';
	import { evidence } from '@colander/shared/inpage/evidence.ts';
	import type { LogEntry, LogResponse } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { api, errorText } from '#lib/api.ts';
	import { live } from '#lib/live.svelte.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	let platform = $state<Platform | ''>('');
	let verdict = $state<Verdict | ''>('');
	let entries = $state<LogEntry[]>([]);
	let cursor = $state<string | null>(null);
	let status = $state<'idle' | 'loading' | 'more' | 'ready' | 'error'>('idle');
	let error = $state('');
	let ready = false;
	let request = 0;

	function query(next: string | null) {
		const q = new URLSearchParams({ limit: '50' });
		if (platform) q.set('platform', platform);
		if (verdict) q.set('verdict', verdict);
		if (next) q.set('cursor', next);
		return `/v1/log?${q}`;
	}

	async function fetchPage(more: boolean) {
		const mine = ++request;
		status = more ? 'more' : 'loading';
		error = '';
		try {
			const res = await api<LogResponse>(query(more ? cursor : null));
			if (mine !== request) return;
			entries = more ? [...entries, ...res.entries] : res.entries;
			cursor = res.next_cursor;
			status = 'ready';
		} catch (e) {
			if (mine !== request) return;
			error = errorText(e);
			status = 'error';
		}
	}

	function applyFilters() {
		if (!ready) return;
		const q = new URLSearchParams();
		if (platform) q.set('platform', platform);
		if (verdict) q.set('verdict', verdict);
		const search = q.size ? `?${q}` : '';
		if (search !== location.search) goto(`/log${search}`, { replace: true, shallow: true });
		fetchPage(false);
	}

	onMount(() => {
		const q = new URLSearchParams(location.search);
		const p = q.get('platform') ?? '';
		const v = q.get('verdict') ?? '';
		platform = isPlatform(p) ? p : '';
		verdict = (VERDICTS as string[]).includes(v) ? (v as Verdict) : '';
		ready = true;
		fetchPage(false);
	});

	const platformOptions = [{ value: '', label: 'All platforms' }, ...PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))];
	const verdictOptions = [{ value: '', label: 'All verdicts' }, ...VERDICTS.map((v) => ({ value: v, label: VERDICT_WORD[v] }))];

	/** Entries grouped by their UTC day, newest first, for the sticky day headers. */
	const days = $derived.by(() => {
		const out: { day: string; date: string; entries: LogEntry[] }[] = [];
		for (const e of entries) {
			const day = fmtDay(e.at);
			if (out.at(-1)?.day !== day) out.push({ day, date: e.at.slice(0, 10), entries: [] });
			out.at(-1)!.entries.push(e);
		}
		return out;
	});

	const why = (e: LogEntry) => ({
		...evidence({
			verdict: e.to,
			hidden: e.to === 'slop' || e.to === 'likely_slop',
			signals: e.signals,
			platform: e.platform,
			sourceId: e.source_id
		}),
		title: e.signals.length ? 'Signals behind this change' : 'No signals recorded'
	});
</script>

<svelte:head>
	<title>Decision log · Colander</title>
	<meta name="description" content="Every Colander verdict change in public: what changed, who decided, the reason and the signals that agreed." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Decision log"
		title="Every verdict change,"
		title2="in public."
		lede="Each entry records what changed, who decided, the reason and the signals that agreed. Community scoring, curators, staff and appeals all write here, newest first."
	/>
</div>

<div class="cl-container page-body">
	<section class="summary uin-card uin-card-lg uin-card-pad" aria-label="This week">
		<StatCell
			size="lg"
			label="Verdict changes in the last 7 days"
			value={live.stats ? live.stats.decisions_7d : ''}
			zero={live.stats ? 'None this week' : undefined}
			reserve={5}
		/>
		<div class="sum-side">
			<LiveBadge sequence={live.stats?.list_sequence} updatedAt={live.stats?.list_updated_at} now={live.now ?? undefined} />
			{#if live.stats}
				<div class="tally">
					<p class="cl-caption cl-muted">Sources by verdict</p>
					<VerdictTally counts={live.stats.sources} />
				</div>
			{/if}
		</div>
	</section>

	<form class="filters" aria-label="Filter the log" onsubmit={(e) => e.preventDefault()}>
		<div class="field">
			<label class="field-label" for="log-platform">Platform</label>
			<NativeSelect
				id="log-platform"
				size="lg"
				options={platformOptions}
				value={platform}
				onchange={(e) => {
					platform = e.currentTarget.value as Platform | '';
					applyFilters();
				}}
			/>
		</div>
		<div class="field">
			<label class="field-label" for="log-verdict">Verdict</label>
			<NativeSelect
				id="log-verdict"
				size="lg"
				options={verdictOptions}
				value={verdict}
				onchange={(e) => {
					verdict = e.currentTarget.value as Verdict | '';
					applyFilters();
				}}
			/>
		</div>
		<p class="count cl-body cl-muted" aria-live="polite">
			{#if status === 'ready' || status === 'more'}
				Showing {plural(entries.length, 'entry', 'entries')}{cursor ? '' : ', the whole log for these filters'}.
			{/if}
		</p>
	</form>

	{#if status === 'loading' || status === 'idle'}
		<Loading label="Loading" />
	{:else if status === 'error' && entries.length === 0}
		<div class="error-box">
			<Notice tone="error" title="The log could not load"><p>{error}</p></Notice>
			<Button variant="secondary" size="xl" onclick={() => fetchPage(false)}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
		</div>
	{:else if entries.length === 0}
		<p class="empty cl-muted"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span>No decisions match these filters yet.</p>
	{:else}
		{#each days as d (d.date)}
			<section class="day" aria-labelledby="day-{d.date}">
				<h2 class="cl-figure day-head" id="day-{d.date}">{d.day}</h2>
				<ol class="entries">
					{#each d.entries as e (e.id)}
						<li>
							<LogRow entry={e}>
								<div class="more">
									<p class="reason">{e.reason}</p>
									{#if e.target_type === 'item'}<p class="cl-caption cl-muted">Item <span class="cl-figure">{e.target_id}</span></p>{/if}
									<EvidenceCard evidence={why(e)} variant="inline" headingLevel={3} />
								</div>
							</LogRow>
						</li>
					{/each}
				</ol>
			</section>
		{/each}
		<div class="load">
			{#if cursor}
				<Button variant="secondary" size="xl" block onclick={() => fetchPage(true)} loading={status === 'more'}>Load more</Button>
			{:else}
				<p class="cl-body cl-muted">That is the whole log for these filters.</p>
			{/if}
			{#if status === 'error'}<p class="field-error" role="alert">{error}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px 48px;
		margin-bottom: 32px;
	}
	.sum-side {
		display: grid;
		justify-items: end;
		gap: 16px;
	}
	.tally {
		display: grid;
		justify-items: end;
		gap: 8px;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 16px;
		padding-bottom: 24px;
	}
	.filters .field {
		width: 240px;
	}
	.count {
		margin-left: auto;
		padding-bottom: 10px;
	}
	.day-head {
		position: sticky;
		top: 64px;
		z-index: 2;
		padding: 10px 0;
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-paper);
		color: var(--cl-text-muted);
	}
	.entries {
		list-style: none;
	}
	/* Every row's verdict change gets the same width, so the chips line up down the log. */
	.entries :global(.change) {
		min-width: 216px;
	}
	@media (max-width: 719px) {
		.entries :global(.change) {
			min-width: 0;
		}
	}
	.entries li:first-child :global(.log) {
		border-top: 0;
	}
	.more {
		display: grid;
		gap: 12px;
		max-width: 720px;
		padding-left: 80px;
	}
	.reason {
		font: var(--cl-body);
	}
	.load {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding-top: 24px;
		border-top: 1px solid var(--cl-border);
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-block: 32px;
		border-top: 1px solid var(--cl-border);
		font: var(--cl-body);
	}
	.three {
		display: inline-flex;
		gap: 4px;
	}
	.three i {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
	.error-box {
		display: grid;
		justify-items: start;
		gap: 12px;
		max-width: 560px;
	}
	@media (max-width: 1023px) {
		.day-head {
			top: 56px;
		}
	}
	@media (max-width: 639px) {
		.sum-side,
		.tally {
			justify-items: start;
		}
		.filters .field {
			width: calc(50% - 8px);
		}
		.count {
			margin-left: 0;
			padding: 0;
		}
		.more {
			padding-left: 0;
		}
	}
</style>
