<!--
@component The toolbar popup: pause, strictness, counts, what was acted on in this page with
Show, Always allow and Not slop beside each (P0-12), Report this source, and the support card.
-->
<script lang="ts">
	import { ColanderMark, VerdictGlyph } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import {
		PLATFORM_NAME,
		SOURCE_NOUN,
		STRICTNESS,
		STRICTNESS_HINT,
		STRICTNESS_WORD,
		VERDICT_WORD,
		type Platform,
		type Strictness
	} from '@colander/shared/verdicts';
	import Flag from '@lucide/svelte/icons/flag';
	import Heart from '@lucide/svelte/icons/heart';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import X from '@lucide/svelte/icons/x';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { SITE } from '../../lib/env';
	import { targetKey } from '../../lib/ids';
	import type { PageAction, PageState, ToPage } from '../../lib/messages';
	import { ORIGINS } from '../../lib/platforms';
	import { dayKey, K, needsAttention, withDefaults, DEFAULT_STATUS, type Entitlement, type Settings, type Stats, type Status } from '../../lib/settings';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const stats = stored<Stats | undefined>(K.stats, undefined);
	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const supportCard = stored<{ shownAt?: number; dismissedAt?: number }>(K.supportCard, {});
	const settings = $derived(withDefaults(settingsStore.value));

	let tabId = $state<number | null>(null);
	let tabPlatform = $state<Platform | null>(null);
	let page = $state<PageState | null>(null);
	let loaded = $state(false);
	let syncing = $state(false);

	const platform = $derived(page?.platform ?? tabPlatform);
	const sitePaused = $derived(!!platform && settings.pausedSites.includes(platform));
	const tabPaused = $derived(page?.paused.tab ?? false);
	const plus = $derived(!!entitlement.value?.plus && entitlement.value.exp * 1000 > Date.now());
	const override = $derived(plus && platform ? settings.perPlatform[platform] : undefined);
	const today = $derived.by(() => {
		const d = stats.value?.days[dayKey()];
		return d ? d.hidden + d.collapsed : 0;
	});
	const onPage = $derived(page ? page.counts.hidden + page.counts.collapsed : 0);
	const week = $derived.by(() => {
		let n = 0;
		for (let i = 0; i < 7; i++) {
			const d = stats.value?.days[dayKey(Date.now() - i * 86_400_000)];
			if (d) n += d.hidden + d.collapsed;
		}
		return n;
	});
	const DAY = 86_400_000;
	const showSupport = $derived.by(() => {
		const first = stats.value?.firstRunAt;
		if (!first || Date.now() - first < 7 * DAY || week === 0) return false;
		const { shownAt, dismissedAt } = supportCard.value;
		if (dismissedAt && Date.now() - dismissedAt < 30 * DAY) return false;
		return !shownAt || Date.now() - shownAt > 30 * DAY || dayKey(shownAt) === dayKey();
	});
	$effect(() => {
		if (showSupport && supportCard.ready && (!supportCard.value.shownAt || Date.now() - supportCard.value.shownAt > 30 * DAY)) {
			void chrome.storage.local.set({ [K.supportCard]: { ...supportCard.value, shownAt: Date.now() } });
		}
	});

	async function load() {
		// popup.html?tab=<id> inspects a given tab, for opening the popup in a tab while developing.
		const forced = Number(new URLSearchParams(location.search).get('tab'));
		const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
		tabId = tab?.id ?? null;
		if (tab?.url) {
			const host = new URL(tab.url).hostname;
			tabPlatform = (Object.keys(ORIGINS) as Platform[]).find((p) => ORIGINS[p].some((o) => o.split('/')[2] === host)) ?? null;
		}
		if (tabId !== null) {
			try {
				page = (await chrome.tabs.sendMessage(tabId, { type: 'page-state' } satisfies ToPage)) ?? null;
			} catch {
				page = null;
			}
		}
		loaded = true;
	}
	void load();

	function setStrictness(next: Strictness) {
		void send({ type: 'settings', patch: { strictness: next } });
	}

	function toggleSite(on: boolean) {
		if (!platform) return;
		const rest = settings.pausedSites.filter((p) => p !== platform);
		void send({ type: 'settings', patch: { pausedSites: on ? [...rest, platform] : rest } }).then(load);
	}

	function toggleTab(on: boolean) {
		if (tabId === null) return;
		void send({ type: 'pause-tab', tabId, paused: on }).then(load);
	}

	async function act(a: PageAction, what: 'show' | 'allow' | 'not_slop') {
		if (tabId === null) return;
		if (what === 'show') await chrome.tabs.sendMessage(tabId, { type: 'show', id: a.id } satisfies ToPage).catch(() => undefined);
		else if (what === 'allow') {
			const key = a.sourceId ? targetKey(a.platform, 'source', a.sourceId) : a.itemId ? targetKey(a.platform, 'item', a.itemId) : null;
			if (key) await send({ type: 'allow', key, name: a.sourceName || undefined });
		} else if (a.sourceId || a.itemId) {
			// A source verdict is countered at the source; an item without a known source as an item alone.
			const source = !!a.sourceId && (a.reason === 'source_list' || !a.itemId);
			await send({
				type: 'tag',
				tag: {
					platform: a.platform,
					targetType: source ? 'source' : 'item',
					targetId: source ? a.sourceId! : a.itemId!,
					sourceId: source ? undefined : (a.sourceId ?? undefined),
					verdict: 'not_slop',
					platformLabel: a.signals.includes('platform_label'),
					name: a.sourceName || a.title || undefined
				}
			});
		}
		setTimeout(load, 150);
	}

	async function report() {
		if (tabId === null) return;
		await chrome.tabs.sendMessage(tabId, { type: 'report-open' } satisfies ToPage).catch(() => undefined);
		window.close();
	}

	async function syncNow() {
		syncing = true;
		await send({ type: 'sync-now' }).catch(() => undefined);
		syncing = false;
	}

	function openOptions(section?: string) {
		void send({ type: 'open', page: 'options', section });
		window.close();
	}

	const actionWord = (a: PageAction) => (a.shown ? 'Shown' : a.action === 'hide' ? 'Hidden' : a.action === 'collapse' ? 'Collapsed' : 'Labeled');
	const options = STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s] }));
</script>

<main class="popup">
	<header class="head">
		<span class="brand"><ColanderMark size={24} /> <span class="name">Colander</span></span>
		{#if plus}<span class="uin-badge uin-badge-md uin-badge-accent">Plus</span>{/if}
	</header>

	{#if needsAttention(status.value) || status.value.reportsClosed}
		<div class="note" class:calm={!needsAttention(status.value)} role="status">
			{#if status.value.reportsUpdated}
				<p>A report you sent has a verdict.</p>
				<Button variant="ghost" onclick={() => openOptions('reports')}>My reports</Button>
			{:else if needsAttention(status.value)}
				<p>The list could not update. Blocking still works from the last copy.</p>
				<Button variant="ghost" onclick={syncNow} aria-busy={syncing}><RefreshCw size={16} strokeWidth={1.75} />Sync now</Button>
			{:else}
				<p>A report you sent was closed.</p>
				<Button variant="ghost" onclick={() => openOptions('reports')}>My reports</Button>
			{/if}
		</div>
	{/if}

	{#if platform}
		<section class="block" aria-label="Pause">
			{#if sitePaused || tabPaused}
				<p class="paused" role="status">{sitePaused ? 'Paused on this site.' : 'Paused on this tab.'}</p>
			{/if}
			<div class="row">
				<span id="pause-site">Pause on this site</span>
				<Switch checked={sitePaused} aria-labelledby="pause-site" onCheckedChange={toggleSite} />
			</div>
			<div class="row">
				<span id="pause-tab">Pause on this tab</span>
				<Switch checked={tabPaused} aria-labelledby="pause-tab" disabled={!page} onCheckedChange={toggleTab} />
			</div>
		</section>
	{/if}

	<section class="block" aria-labelledby="strict-title">
		<h2 id="strict-title" class="label"><SlidersHorizontal size={16} strokeWidth={1.75} />Strictness</h2>
		<SegmentedControl {options} value={settings.strictness} onChange={setStrictness} ariaLabel="Strictness" />
		<p class="hint t-caption muted">{STRICTNESS_HINT[settings.strictness]}</p>
		{#if override && platform}
			<p class="hint t-caption muted">{PLATFORM_NAME[platform]} uses {STRICTNESS_WORD[override]}, set in Options.</p>
		{/if}
	</section>

	<section class="counts" aria-label="Counts">
		<div class="count"><span class="num cl-num">{today}</span><span class="t-caption muted">Hidden today</span></div>
		<div class="count"><span class="num cl-num">{onPage}</span><span class="t-caption muted">Hidden on this page</span></div>
	</section>

	<section class="block actions-block" aria-labelledby="recent-title">
		<h2 id="recent-title" class="label">On this page</h2>
		{#if !loaded}
			<p class="t-caption muted">Loading</p>
		{:else if !page}
			<div class="empty">
				<div class="dots motif" aria-hidden="true"></div>
				<p>Colander works on YouTube, TikTok, Instagram and Facebook.</p>
				{#if tabPlatform && !settings.platforms[tabPlatform]}
					<Button variant="outline" onclick={() => openOptions('platforms')}>Turn on {PLATFORM_NAME[tabPlatform]}</Button>
				{/if}
			</div>
		{:else if page.actions.length === 0}
			<div class="empty">
				<div class="dots motif" aria-hidden="true"></div>
				<p>Nothing hidden on this page.</p>
			</div>
		{:else}
			<ul class="list">
				{#each page.actions as a (a.id)}
					<li class="item">
						<div class="what">
							{#if a.verdict}
								<span class="v v-{a.verdict}"><VerdictGlyph verdict={a.verdict} size={12} /></span>
								<span class="vw">{VERDICT_WORD[a.verdict]}</span>
							{:else}
								<span class="vw">Your rule</span>
							{/if}
							<span class="state t-caption muted">· {actionWord(a)}</span>
						</div>
						<p class="title" title={a.title}>{a.title || a.sourceName || a.itemId || a.sourceId}</p>
						{#if a.sourceName && a.title}<p class="source t-caption muted">{a.sourceName}</p>{/if}
						<div class="btns">
							{#if (a.action === 'hide' || a.action === 'collapse') && !a.shown}
								<Button variant="ghost" onclick={() => act(a, 'show')}>Show</Button>
							{/if}
							<Button variant="ghost" onclick={() => act(a, 'allow')}>Always allow</Button>
							{#if a.verdict && (a.sourceId || a.itemId)}
								<Button variant="ghost" onclick={() => act(a, 'not_slop')}>Not slop</Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if page?.source}
		<section class="block">
			<Button variant="outline" class="wide" onclick={report}><Flag size={16} strokeWidth={1.75} />Report this {SOURCE_NOUN[page.platform]}</Button>
		</section>
	{/if}

	{#if showSupport}
		<section class="support" aria-label="Support">
			<button class="dismiss" aria-label="Dismiss" onclick={() => chrome.storage.local.set({ [K.supportCard]: { ...supportCard.value, dismissedAt: Date.now() } })}>
				<X size={16} strokeWidth={1.75} />
			</button>
			<p>You skipped <strong class="cl-num">{week}</strong> slop items this week. Colander runs on support from people like you.</p>
			<div class="support-btns">
				{#if !plus}<Button variant="primary" onclick={() => chrome.tabs.create({ url: `${SITE}/plans` })}>Get Plus</Button>{/if}
				<Button variant="outline" onclick={() => chrome.tabs.create({ url: `${SITE}/support` })}><Heart size={16} strokeWidth={1.75} />Support our work</Button>
			</div>
		</section>
	{/if}

	<footer class="foot">
		<Button variant="ghost" class="quiet-muted" onclick={() => openOptions()}><Settings2 size={16} strokeWidth={1.75} />Options</Button>
		<Button variant="ghost" class="quiet-muted" onclick={() => chrome.tabs.create({ url: `${SITE}/support` })}><Heart size={16} strokeWidth={1.75} />Support our work</Button>
	</footer>
</main>

<style>
	:global(body) {
		width: 360px;
	}
	.popup {
		display: flex;
		flex-direction: column;
		background: var(--cl-surface);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 48px;
		padding: 0 16px;
		border-bottom: 1px solid var(--cl-border);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--cl-ink);
	}
	:global(:root[data-theme='dark']) .brand,
	.brand {
		color: var(--cl-text);
	}
	.name {
		font: var(--cl-title);
		font-size: 16px;
		line-height: 24px;
	}
	.note {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 8px 8px 16px;
		background: var(--cl-brand-tint);
		font: var(--cl-caption);
	}
	.note.calm {
		background: var(--cl-surface-raised);
	}
	.block {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
		border-bottom: 1px solid var(--cl-border);
	}
	.label {
		display: flex;
		align-items: center;
		gap: 8px;
		font: var(--cl-body);
		font-weight: 600;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 32px;
	}
	.paused {
		padding: 8px 12px;
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface-raised);
		font-weight: 600;
	}
	.hint {
		margin-top: -2px;
	}
	.counts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--cl-border);
	}
	.count {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 12px 16px;
	}
	.count + .count {
		border-left: 1px solid var(--cl-border);
	}
	.num {
		font: var(--cl-display);
		font-size: 24px;
		line-height: 32px;
	}
	.list {
		display: flex;
		flex-direction: column;
		margin: 0 -16px;
	}
	.item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 16px;
	}
	.item + .item {
		border-top: 1px solid var(--cl-border);
	}
	.what {
		display: flex;
		align-items: center;
		gap: 6px;
		font: var(--cl-chip);
	}
	.v {
		display: inline-flex;
	}
	.v-slop {
		color: var(--cl-slop);
	}
	.v-likely_slop {
		color: var(--cl-likely);
	}
	.v-ai_made {
		color: var(--cl-ai);
	}
	.v-disputed {
		color: var(--cl-disputed);
	}
	.v-clear {
		color: var(--cl-clear);
	}
	.state {
		font-weight: 400;
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.btns {
		display: flex;
		gap: 0;
		margin: 2px -8px 0;
	}
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 16px 0 8px;
		text-align: center;
		color: var(--cl-text-muted);
	}
	.motif {
		width: 96px;
		height: 36px;
		border-radius: var(--cl-r-chip);
	}
	:global(.wide) {
		width: 100%;
	}
	.support {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 16px;
		padding: 16px;
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
	}
	.support p {
		padding-right: 24px;
	}
	.support-btns {
		display: flex;
		gap: 8px;
	}
	.dismiss {
		position: absolute;
		top: 8px;
		right: 8px;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 0;
		border-radius: var(--cl-r-chip);
		background: none;
		color: var(--cl-text-muted);
		cursor: pointer;
	}
	.dismiss:hover {
		background: var(--uin-mat-hover);
		color: var(--cl-text);
	}
	.dismiss:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	.foot {
		display: flex;
		justify-content: space-between;
		padding: 8px;
	}
</style>
