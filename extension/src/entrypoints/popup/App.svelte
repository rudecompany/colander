<!--
@component The toolbar popup: the shared PopupView, fed from storage and the open page. The
website hero renders the same component, so the two cannot drift. 360 wide, never over 600 tall.
-->
<script lang="ts">
	import { PopupView, type PopupActions, type PopupRow, type PopupState } from '@colander/shared';
	import { ITEM_NOUN, PLATFORM_DOMAIN } from '@colander/shared/copy';
	import { sourcePath } from '@colander/shared/format';
	import { PLATFORM_NAME, STRICTNESS_WORD, type Platform, type Strictness } from '@colander/shared/verdicts';
	import { SITE } from '../../lib/env';
	import { targetKey } from '../../lib/ids';
	import type { PageAction, PageState, ToPage } from '../../lib/messages';
	import { ORIGINS } from '../../lib/platforms';
	import { dayKey, isPlus, K, needsAttention, withDefaults, DEFAULT_STATUS, type Entitlement, type Settings, type Stats, type Status } from '../../lib/settings';
	import { send, stored } from '../../ui/store.svelte';

	type CardTiming = { shownAt?: number; dismissedAt?: number };
	const DAY = 86_400_000;

	/** A dismissible card shows at most once per `every`: the whole day it first shows, until dismissed. */
	function due(c: CardTiming, every: number, now = Date.now()): boolean {
		if (c.dismissedAt && now - c.dismissedAt < every) return false;
		return !c.shownAt || now - c.shownAt > every || dayKey(c.shownAt) === dayKey(now);
	}

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const stats = stored<Stats | undefined>(K.stats, undefined);
	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const supportCard = stored<CardTiming>(K.supportCard, {});
	const weeklyCard = stored<CardTiming>(K.weeklyCard, {});
	const settings = $derived(withDefaults(settingsStore.value));

	let tabId = $state<number | null>(null);
	let tabPlatform = $state<Platform | null>(null);
	let page = $state<PageState | null>(null);
	let loaded = $state(false);

	const platform = $derived(page?.platform ?? tabPlatform);
	// A supported site whose platform is switched off has no content script: Colander is not running there.
	const running = $derived(!!platform && (!!page || settings.platforms[platform]));
	const sitePaused = $derived(!!platform && settings.pausedSites.includes(platform));
	const tabPaused = $derived(page?.paused.tab ?? false);
	const plus = $derived(isPlus(entitlement.value));
	const override = $derived(plus && platform ? settings.perPlatform[platform] : undefined);
	const today = $derived.by(() => {
		const d = stats.value?.days[dayKey()];
		return d?.hidden ?? 0;
	});
	const week = $derived.by(() => {
		let n = 0;
		for (let i = 0; i < 7; i++) {
			const d = stats.value?.days[dayKey(Date.now() - i * DAY)];
			if (d) n += d.hidden;
		}
		return n;
	});
	const syncFailed = $derived(needsAttention({ ...status.value, reportsUpdated: false }));
	const firstWeekDone = $derived(!!stats.value?.firstRunAt && Date.now() - stats.value.firstRunAt >= 7 * DAY);
	// After the first week, one dismissible card with the person's own numbers: once a week with
	// Plus (its weekly summary), otherwise at most once every 30 days, with Get Plus.
	const card = $derived(plus ? { key: K.weeklyCard, store: weeklyCard, every: 7 * DAY } : { key: K.supportCard, store: supportCard, every: 30 * DAY });
	const showWeekly = $derived(firstWeekDone && week > 0 && card.store.ready && due(card.store.value, card.every));
	$effect(() => {
		const c = card.store.value;
		if (showWeekly && (!c.shownAt || Date.now() - c.shownAt > card.every)) void chrome.storage.local.set({ [card.key]: { ...c, shownAt: Date.now() } });
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

	const title = (a: PageAction) => a.title || a.sourceName || a.itemId || a.sourceId || '';
	const byId = (r: PopupRow) => page?.actions.find((a) => a.id === r.id);

	const onPage = $derived(page?.counts.hidden ?? 0);
	const popup = $derived<PopupState>({
		status: !loaded ? 'loading' : !running ? 'unsupported' : sitePaused || tabPaused ? 'paused' : 'active',
		domain: platform ? PLATFORM_DOMAIN[platform] : undefined,
		pausedScope: sitePaused ? 'site' : 'tab',
		plus,
		strictness: settings.strictness,
		strictnessNote: override && platform ? `${PLATFORM_NAME[platform]} uses ${STRICTNESS_WORD[override]}, set in Options.` : undefined,
		// Today's count is written after the page's counts arrive, so it never reads lower than this page.
		hiddenToday: Math.max(today, onPage),
		onPage,
		noun: platform ? ITEM_NOUN[platform] : undefined,
		rows: page?.actions.map((a) => ({ id: a.id, verdict: a.verdict, title: title(a), action: a.action, shown: a.shown })) ?? [],
		// One slot, by priority: a sync failure, a report verdict, the weekly card, else the footer.
		slot: syncFailed ? { kind: 'sync' } : status.value.reportsUpdated ? { kind: 'report' } : showWeekly ? { kind: 'weekly', hidden: week } : null,
		list: { sequence: status.value.listSequence || null, updatedAt: status.value.lastSyncAt },
		canPauseTab: !!page
	});

	function openOptions(section?: string) {
		void send({ type: 'open', page: 'options', section });
		window.close();
	}
	const openSite = (path: string) => void chrome.tabs.create({ url: `${SITE}${path}` });
	const toPage = (m: ToPage) => (tabId === null ? Promise.resolve() : chrome.tabs.sendMessage(tabId, m).catch(() => undefined));

	async function notSlop(a: PageAction) {
		if (!a.sourceId && !a.itemId) return;
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

	const actions: PopupActions = {
		strictness: (level: Strictness) => void send({ type: 'settings', patch: { strictness: level } }),
		pause: async (scope) => {
			if (scope === 'tab' && tabId !== null) await send({ type: 'pause-tab', tabId, paused: true });
			else if (scope === 'site' && platform) await send({ type: 'settings', patch: { pausedSites: [...settings.pausedSites.filter((p) => p !== platform), platform] } });
			await load();
		},
		resume: async () => {
			if (tabPaused && tabId !== null) await send({ type: 'pause-tab', tabId, paused: false });
			if (sitePaused && platform) await send({ type: 'settings', patch: { pausedSites: settings.pausedSites.filter((p) => p !== platform) } });
			await load();
		},
		// On a supported site that is switched off, Options opens on Platforms.
		options: () => openOptions(tabPlatform && !running ? 'platforms' : undefined),
		show: async (r) => {
			await toPage({ type: 'show', id: Number(r.id) });
			setTimeout(load, 150);
		},
		allow: async (r) => {
			const a = byId(r);
			const key = a?.sourceId ? targetKey(a.platform, 'source', a.sourceId) : a?.itemId ? targetKey(a.platform, 'item', a.itemId) : null;
			if (key) await send({ type: 'allow', key, name: a!.sourceName || undefined });
			setTimeout(load, 150);
		},
		notSlop: async (r) => {
			const a = byId(r);
			if (a) await notSlop(a);
			setTimeout(load, 150);
		},
		why: async (r) => {
			await toPage({ type: 'why', id: Number(r.id) });
			window.close();
		},
		sourcePage: (r) => {
			const a = byId(r);
			if (a?.sourceId) openSite(sourcePath(a.platform, a.sourceId));
		},
		sync: () => void send({ type: 'sync-now' }),
		reports: () => openOptions('reports'),
		dismissWeekly: () => void chrome.storage.local.set({ [card.key]: { ...card.store.value, dismissedAt: Date.now() } }),
		plus: () => openSite('/plans'),
		support: () => openSite('/support'),
		log: () => openSite('/log')
	};

	// Chrome's popup is at most 600 px of screen, so at 125% zoom it is 480 CSS px and the document
	// would scroll. Once the content outgrows the window, the popup is capped to the window and only
	// the list scrolls. Chrome sizes the popup to its content during layout, before these callbacks,
	// so the window is only ever smaller than the content when it has reached its limit. Below 440
	// (past about 135% zoom) the fixed cards alone fill the window, so the whole popup scrolls instead.
	const fit = () => {
		const root = document.documentElement;
		if (root.scrollHeight <= innerHeight + 1 || innerHeight < 440) return;
		root.style.setProperty('--popup-cap', `${innerHeight}px`);
		root.dataset.capped = '';
	};
	addEventListener('resize', fit);
	new ResizeObserver(fit).observe(document.documentElement);
</script>

<PopupView state={popup} {actions} />

<style>
	:global(body) {
		width: 360px;
		margin: 0;
		background: var(--cl-paper);
	}
	/* Chrome's popup window is at most 600 tall; PopupView grows with its content elsewhere. */
	:global(.popup) {
		max-height: 600px;
	}
	/* Capped by zoom: the On this page card gives way and its rows scroll, fading at the foot. */
	:global(html[data-capped] .popup) {
		max-height: var(--popup-cap);
	}
	:global(html[data-capped] .popup .page) {
		flex: 0 1 auto;
		min-height: 0;
	}
	/* The tally repeats the chips in the list, which needs the room more. */
	:global(html[data-capped] .popup .stats .tally) {
		display: none;
	}
	:global(html[data-capped] .popup .rows) {
		min-height: 0;
		overflow-y: auto;
		padding-bottom: 16px;
		mask-image: linear-gradient(to bottom, black calc(100% - 16px), transparent);
	}
</style>
