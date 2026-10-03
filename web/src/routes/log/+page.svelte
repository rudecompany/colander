<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { PLATFORMS, PLATFORM_NAME, VERDICTS, VERDICT_WORD, type Platform, type Verdict } from '@colander/shared';
	import type { LogEntry, LogResponse } from '@colander/shared/api';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { api, errorText } from '#lib/api.ts';
	import { isPlatform, plural } from '#lib/format.ts';
	import PageHead from '#lib/components/PageHead.svelte';
	import LogEntryView from '#lib/components/LogEntryView.svelte';
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
	const verdictOptions = [
		{ value: '', label: 'All verdicts' },
		...VERDICTS.map((v) => ({ value: v, label: VERDICT_WORD[v] }))
	];
</script>

<svelte:head>
	<title>Decision log · Colander</title>
	<meta name="description" content="Every Colander verdict change in public: what changed, who decided, the reason and the signals that fired." />
</svelte:head>

<PageHead
	eyebrow="Decision log"
	title="Every verdict change, in public"
	lede="Each entry records what changed, who decided, the reason and the signals that fired. Community scoring, curators, staff and appeals all write here, newest first."
/>

<div class="wrap page">
	<form class="filters" aria-label="Filter the log" onsubmit={(e) => e.preventDefault()}>
		<div class="field">
			<label class="field-label" for="log-platform">Platform</label>
			<NativeSelect
				id="log-platform"
				options={platformOptions}
				value={platform}
				onchange={(e) => {
					platform = e.currentTarget.value as Platform | '';
					applyFilters();
				}}
			/>
		</div>
		<div class="field">
			<label class="field-label" for="log-verdict">Changed to</label>
			<NativeSelect
				id="log-verdict"
				options={verdictOptions}
				value={verdict}
				onchange={(e) => {
					verdict = e.currentTarget.value as Verdict | '';
					applyFilters();
				}}
			/>
		</div>
		<p class="count t-body muted" aria-live="polite">
			{#if status === 'ready' || status === 'more'}
				Showing {plural(entries.length, 'entry', 'entries')}{cursor ? '' : ', the whole log for these filters'}.
			{/if}
		</p>
	</form>

	{#if status === 'loading' || status === 'idle'}
		<Loading label="Loading the decision log" />
	{:else if status === 'error' && entries.length === 0}
		<div class="error-box">
			<Notice tone="error" title="The log could not load"><p>{error}</p></Notice>
			<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={() => fetchPage(false)}>
				<RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Try again
			</button>
		</div>
	{:else if entries.length === 0}
		<div class="empty cl-dots">
			<p class="empty-text">No decisions match these filters yet.</p>
		</div>
	{:else}
		<ol class="entries">
			{#each entries as e (e.id)}<li><LogEntryView entry={e} headingLevel={2} /></li>{/each}
		</ol>
		<div class="more">
			{#if cursor}
				<button type="button" class="uin-btn uin-btn-outline btn-lg" onclick={() => fetchPage(true)} disabled={status === 'more'}>
					{status === 'more' ? 'Loading more' : 'Load more'}
				</button>
			{:else}
				<p class="t-body muted">That is the whole log for these filters.</p>
			{/if}
			{#if status === 'error'}<p class="field-error" role="alert">{error}</p>{/if}
		</div>
	{/if}
</div>

<style>
	.page {
		padding-top: var(--cl-s5);
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--cl-s4);
		padding-bottom: var(--cl-s4);
		border-bottom: 1px solid var(--cl-border);
	}
	.filters .field {
		width: 220px;
	}
	.count {
		margin-left: auto;
		padding-bottom: 10px;
	}
	.entries {
		list-style: none;
	}
	.entries li + li {
		border-top: 1px solid var(--cl-border);
	}
	.more {
		display: grid;
		justify-items: center;
		gap: var(--cl-s3);
		padding: var(--cl-s5) 0;
		border-top: 1px solid var(--cl-border);
	}
	.empty {
		display: grid;
		place-items: center;
		min-height: 260px;
		margin-top: var(--cl-s5);
		border-radius: var(--cl-r-card);
	}
	.empty-text {
		background: var(--cl-paper);
		padding: 8px 14px;
		border-radius: var(--cl-r-chip);
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	.error-box {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
		max-width: 560px;
		margin-top: var(--cl-s5);
	}
	@media (max-width: 600px) {
		.filters .field {
			width: calc(50% - var(--cl-s2));
		}
		.count {
			margin-left: 0;
			padding: 0;
		}
	}
</style>
