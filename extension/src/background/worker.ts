// The service worker: list and config sync, the tag queue, reports, plan tokens and Plus
// settings sync, content script registration, the toolbar badge, and website handoff.
import type { Report, Tag } from '@colander/shared/api';
import { PLATFORMS, type Platform } from '@colander/shared/verdicts';
import defaults from '../adapters/default-config.json';
import { validateConfig, type AdapterConfig } from '../adapters/schema';
import * as db from '../lib/db';
import { SITE, PUBLIC_KEYS } from '../lib/env';
import { targetKey } from '../lib/ids';
import type { ActivityEntry, HelloReply, PageCounts, ReportReply, ReportRequest, TagRequest, ToPage, ToWorker } from '../lib/messages';
import { offered, ORIGINS } from '../lib/platforms';
import {
	dayKey,
	isPlus,
	K,
	withDefaults,
	type Entitlement,
	type MyListEntry,
	type OwnTag,
	type Settings,
	type Stats,
	type Status
} from '../lib/settings';
import { CONFIG_CONTEXT, importKeys, verifyEnvelope, verifyPlanToken, type TrustedKey } from '../lib/signing';
import { setGlobalIcon, setTabIcon } from './icons';
import { clearList, getStatus, setStatus, syncList } from './listsync';
import { ApiError, installId, json, request } from './net';
import { dueBatch, enqueue, nextDue, settle, type Outcome, type Queued } from './queue';

const VERSION = chrome.runtime.getManifest().version;
let keysP: Promise<TrustedKey[]> | null = null;
const keys = () => (keysP ??= importKeys(PUBLIC_KEYS));

// ---- Settings ------------------------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
	const got = await chrome.storage.local.get(K.settings);
	return withDefaults(got[K.settings] as Partial<Settings>);
}

/** Serialized read-modify-write, so two quick changes never overwrite each other. */
let settingsChain: Promise<unknown> = Promise.resolve();
export function updateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
	const next = settingsChain.then(async () => {
		const s = fn(await getSettings());
		await chrome.storage.local.set({ [K.settings]: s });
		return s;
	});
	settingsChain = next.catch(() => undefined);
	return next;
}

function upsert(list: MyListEntry[], key: string, name?: string): MyListEntry[] {
	return [...list.filter((e) => e.key !== key), { key, name, at: Date.now() }];
}

// ---- Content scripts -------------------------------------------------------------------------

/**
 * Registers scripts only for platforms that are switched on, granted and offered (an early
 * access platform needs Plus); removes the rest. Calls are serialized: two overlapping runs
 * would both try to register the same IDs.
 */
let reconciling: Promise<void> = Promise.resolve();
export function reconcileScripts(): Promise<void> {
	const run = reconciling.then(reconcileOnce, reconcileOnce);
	reconciling = run.catch(() => undefined);
	return run;
}

async function reconcileOnce(): Promise<void> {
	const s = await getSettings();
	const got = await chrome.storage.local.get([K.adapterConfig, K.entitlement]);
	const plus = isPlus(got[K.entitlement] as Entitlement | undefined);
	const registered = new Set((await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id));
	for (const p of PLATFORMS) {
		const granted = await chrome.permissions.contains({ origins: ORIGINS[p] });
		const want = s.platforms[p] && granted && offered(p, got[K.adapterConfig] as AdapterConfig | undefined, plus);
		const ids = [`cl-${p}`, `cl-${p}-bridge`];
		if (want) {
			const missing = ids.filter((id) => !registered.has(id));
			if (!missing.length) continue;
			// Careful: an empty `ids` list unregisters every script, not none.
			const stale = ids.filter((id) => registered.has(id));
			if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
			await chrome.scripting.registerContentScripts([
				{
					id: `cl-${p}`,
					matches: ORIGINS[p],
					js: ['content-scripts/content.js'],
					css: ['content-scripts/content.css'],
					runAt: 'document_start',
					allFrames: false,
					persistAcrossSessions: true
				},
				{
					id: `cl-${p}-bridge`,
					matches: ORIGINS[p],
					js: ['content-scripts/bridge.js'],
					runAt: 'document_start',
					world: 'MAIN',
					allFrames: false,
					persistAcrossSessions: true
				}
			]);
		} else {
			const present = ids.filter((id) => registered.has(id));
			if (present.length) await chrome.scripting.unregisterContentScripts({ ids: present });
		}
	}
}

// ---- Sync: list, adapter config, reports, plan ----------------------------------------------

export async function syncConfig(): Promise<void> {
	try {
		const res = await request('/v1/config/adapters');
		if (res.status === 404) return;
		const envelope = await json<unknown>(res);
		const payload = validateConfig(await verifyEnvelope(envelope, CONFIG_CONTEXT, await keys()));
		const got = await chrome.storage.local.get(K.adapterConfig);
		const cached = got[K.adapterConfig] as AdapterConfig | undefined;
		const have = Math.max((defaults as AdapterConfig).version, cached?.version ?? 0);
		if (payload.version > have) {
			await chrome.storage.local.set({ [K.adapterConfig]: payload });
			await setStatus({ configVersion: payload.version });
		}
	} catch {
		// Unsigned, malformed or older configs are ignored; the bundled or cached copy stays.
	}
}

export async function syncAll(): Promise<void> {
	await syncList(await keys());
	await Promise.allSettled([syncConfig(), refreshPendingReports(), refreshEntitlement(), pullSettings(), flushTags()]);
	// An expired entitlement changes no storage; this keeps early access platforms in step.
	await reconcileScripts();
	await refreshIcons();
}

// ---- Tags --------------------------------------------------------------------------------------

/** How long a tag from an open tag menu waits for its final state before it is sent anyway. */
const HOLD_MS = 5 * 60_000;

export async function addTag(req: TagRequest, hold = false): Promise<void> {
	const key = targetKey(req.platform, req.targetType, req.targetId);
	const own = (await chrome.storage.local.get(K.ownTags))[K.ownTags] as Record<string, OwnTag> | undefined;
	await chrome.storage.local.set({ [K.ownTags]: { ...own, [key]: { verdict: req.verdict, at: Date.now() } } });
	const tag: Tag = {
		client_id: crypto.randomUUID(),
		platform: req.platform,
		target_type: req.targetType,
		target_id: req.targetId,
		verdict: req.verdict,
		platform_label: req.platformLabel,
		created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		ext_version: VERSION
	};
	if (req.targetType === 'item' && req.sourceId) tag.source_id = req.sourceId;
	if (req.verdict === 'slop') {
		if (req.slopType) tag.slop_type = req.slopType;
		if (req.tests?.length) tag.tests = req.tests;
	}
	const queue = await db.all<Queued>('tags');
	const { add, remove } = enqueue(queue, tag, key, Date.now() + (hold ? HOLD_MS : 0));
	for (const id of remove) await db.del('tags', id);
	await db.put('tags', add);
	// A held tag is not due yet: this sends any other due tags and sets the alarm for it.
	await flushTags();
}

let flushing: Promise<void> | null = null;
export function flushTags(): Promise<void> {
	flushing ??= (async () => {
		try {
			for (;;) {
				const now = Date.now();
				const batch = dueBatch(await db.all<Queued>('tags'), now);
				if (!batch.length) break;
				let outcome: Outcome;
				try {
					const res = await request('/v1/tags', { body: { tags: batch.map((q) => q.tag) }, auth: { install: true } });
					if (res.status === 429) outcome = { kind: 'rate-limited', retryAfterMs: Math.max(1000, Number(res.headers.get('Retry-After')) * 1000 || 60_000) };
					else if (res.status === 400) outcome = { kind: 'invalid' };
					else if (res.ok) outcome = { kind: 'sent', ...(await res.json()) };
					else outcome = { kind: 'failed' };
				} catch {
					outcome = { kind: 'failed' };
				}
				const { remove, update } = settle(batch, outcome, Date.now());
				for (const id of remove) await db.del('tags', id);
				for (const q of update) await db.put('tags', q);
				if (outcome.kind !== 'sent' || update.length) break;
			}
		} finally {
			const due = nextDue(await db.all<Queued>('tags'));
			if (due === null) await chrome.alarms.clear('tags');
			else await chrome.alarms.create('tags', { when: Math.max(due, Date.now() + 30_000) });
			flushing = null;
		}
	})();
	return flushing;
}

// ---- Reports ------------------------------------------------------------------------------------

export async function submitReport(r: ReportRequest): Promise<ReportReply> {
	const body = {
		client_id: crypto.randomUUID(),
		platform: r.platform,
		source_id: r.sourceId,
		...(r.sourceName ? { source_name: r.sourceName.slice(0, 120) } : {}),
		examples: r.examples.slice(0, 3),
		reason: r.reason.slice(0, 500),
		...(r.slopType ? { slop_type: r.slopType } : {}),
		...(r.tests?.length ? { tests: r.tests } : {}),
		ext_version: VERSION
	};
	try {
		const { report } = await json<{ report: Report }>(await request('/v1/reports', { body, auth: { install: true } }));
		const cached = ((await chrome.storage.local.get(K.reports))[K.reports] as Report[] | undefined) ?? [];
		await chrome.storage.local.set({ [K.reports]: [report, ...cached.filter((x) => x.id !== report.id)] });
		return { ok: true, report };
	} catch (e) {
		if (e instanceof ApiError) return { ok: false, error: e.message };
		return { ok: false, error: 'Could not reach Colander. Check your connection and try again.' };
	}
}

async function cachedReports(): Promise<Report[]> {
	return ((await chrome.storage.local.get(K.reports))[K.reports] as Report[] | undefined) ?? [];
}

/**
 * The sync asks for report statuses only while one of this install's reports waits for a
 * verdict, so an install that never reported never sends its ID on a schedule (P0-11).
 */
async function refreshPendingReports(): Promise<void> {
	if ((await cachedReports()).some((r) => r.status === 'under_review')) await refreshReports();
}

/** Refreshes My reports: a verdict raises the attention dot, a dismissal only a calm note. */
export async function refreshReports(): Promise<Report[] | null> {
	const cached = await cachedReports();
	try {
		const { reports } = await json<{ reports: Report[] }>(await request('/v1/reports', { auth: { install: true } }));
		const before = new Map(cached.map((r) => [r.id, r.status]));
		const landed = reports.filter((r) => before.has(r.id) && before.get(r.id) !== r.status && r.status !== 'under_review');
		await chrome.storage.local.set({ [K.reports]: reports });
		const patch: Partial<Status> = {};
		if (landed.some((r) => r.status !== 'dismissed')) patch.reportsUpdated = true;
		if (landed.some((r) => r.status === 'dismissed')) patch.reportsClosed = true;
		if (landed.length) await setStatus(patch);
		return reports;
	} catch {
		return null;
	}
}

// ---- Plan, trial and settings sync -------------------------------------------------------------

export async function applyPlanToken(token: string): Promise<boolean> {
	const p = await verifyPlanToken(token, await keys());
	if (!p) return false;
	const ent: Entitlement = { plus: true, trial: p.trial, exp: p.exp };
	await chrome.storage.local.set({ [K.planToken]: token, [K.entitlement]: ent });
	return true;
}

async function planToken(): Promise<string | null> {
	const t = (await chrome.storage.local.get(K.planToken))[K.planToken] as string | undefined;
	if (!t) return null;
	const p = await verifyPlanToken(t, await keys());
	return p && Date.now() / 1000 < p.exp ? t : null;
}

export async function startTrial(): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const { token } = await json<{ token: string }>(await request('/v1/trial', { method: 'POST', auth: { install: true } }));
		if (!(await applyPlanToken(token))) return { ok: false, error: 'The trial token could not be verified.' };
		return { ok: true };
	} catch (e) {
		if (e instanceof ApiError && e.code === 'trial_used') return { ok: false, error: 'This browser has already used its free trial.' };
		if (e instanceof ApiError) return { ok: false, error: e.message };
		return { ok: false, error: 'Could not reach Colander. Check your connection and try again.' };
	}
}

/**
 * Swaps a paid token for a fresh one once a day, also after it ran out (the server accepts an
 * expired token whose signature verifies), so a cancel or refund turns Plus off within a day.
 * `404 no_plan` means the plan ended: Plus turns off. Trials are never refreshed; they end.
 */
export async function refreshEntitlement(): Promise<void> {
	const got = await chrome.storage.local.get([K.planToken, K.planCheckedAt]);
	const t = got[K.planToken] as string | undefined;
	if (!t) return;
	const p = await verifyPlanToken(t, await keys());
	if (!p) {
		await chrome.storage.local.remove([K.planToken, K.entitlement]);
		return;
	}
	if (p.trial || Date.now() - ((got[K.planCheckedAt] as number | undefined) ?? 0) < 86_400_000) return;
	try {
		const { token } = await json<{ token: string }>(await request('/v1/entitlement/refresh', { body: { token: t } }));
		if (await applyPlanToken(token)) await chrome.storage.local.set({ [K.planCheckedAt]: Date.now() });
	} catch (e) {
		if (e instanceof ApiError && e.status === 404 && e.code === 'no_plan') {
			await chrome.storage.local.remove([K.planToken, K.planCheckedAt]);
			await chrome.storage.local.set({ [K.entitlement]: { plus: false, trial: false, exp: p.exp } satisfies Entitlement });
		}
		// Offline or a server error: keep the token and try again on the next hourly sync.
	}
}

const SYNCED = ['strictness', 'perPlatform', 'topics', 'allows', 'blocks', 'plainChips'] as const;
type SyncState = { version: number; dirty: boolean };

async function syncState(): Promise<SyncState> {
	return { version: 0, dirty: false, ...((await chrome.storage.local.get(K.syncState))[K.syncState] as Partial<SyncState>) };
}

function pick(s: Settings) {
	return Object.fromEntries(SYNCED.map((k) => [k, s[k]]));
}

/** Plus: pushes settings with optimistic versioning; on a conflict, merges and tries once more. */
export async function pushSettings(): Promise<void> {
	const token = await planToken();
	if (!token) return;
	const st = await syncState();
	const s = await getSettings();
	const put = (version: number, data: unknown) => request('/v1/sync', { method: 'PUT', body: { version, data }, auth: { plan: token } });
	try {
		let res = await put(st.version, pick(s));
		if (res.status === 409) {
			const remote = (await res.json()) as { version: number; data: Partial<Settings> };
			const merged = await updateSettings((cur) => mergeRemote(cur, remote.data, true));
			res = await put(remote.version, pick(merged));
		}
		const out = await json<{ version?: number }>(res);
		await chrome.storage.local.set({ [K.syncState]: { version: out?.version ?? st.version + 1, dirty: false } });
	} catch {
		await chrome.storage.local.set({ [K.syncState]: { ...st, dirty: true } });
	}
}

/** Lists merge as unions; scalars come from the side named by `preferLocal`. */
export function mergeRemote(local: Settings, remote: Partial<Settings>, preferLocal: boolean): Settings {
	const union = (a: MyListEntry[], b: MyListEntry[] = []) => {
		const m = new Map<string, MyListEntry>();
		for (const e of [...b, ...a]) m.set(e.key, e);
		return [...m.values()];
	};
	const scalars = preferLocal ? {} : { strictness: remote.strictness ?? local.strictness, perPlatform: remote.perPlatform ?? local.perPlatform, topics: remote.topics ?? local.topics, plainChips: remote.plainChips ?? local.plainChips };
	return { ...local, ...scalars, allows: union(local.allows, remote.allows), blocks: union(local.blocks, remote.blocks) };
}

export async function pullSettings(): Promise<void> {
	const token = await planToken();
	if (!token) return;
	const st = await syncState();
	if (st.dirty) return pushSettings();
	try {
		const res = await request('/v1/sync', { auth: { plan: token } });
		if (res.status === 404) return pushSettings();
		const remote = await json<{ version: number; data: Partial<Settings> | null }>(res);
		// An empty blob ({"version": 0, "data": null}) means this account has not synced yet.
		if (!remote?.data) return pushSettings();
		if (remote.version > st.version) {
			await updateSettings((cur) => mergeRemote(cur, remote.data ?? {}, false));
			await chrome.storage.local.set({ [K.syncState]: { version: remote.version, dirty: false } });
		}
	} catch {
		// Offline: try again on the next hourly sync.
	}
}

// ---- Toolbar, tabs and activity ----------------------------------------------------------------

type TabInfo = { platform: Platform; count: number };

async function tabs(): Promise<{ pausedTabs: number[]; tabInfo: Record<string, TabInfo> }> {
	const got = await chrome.storage.session.get(['pausedTabs', 'tabInfo']);
	return { pausedTabs: (got.pausedTabs as number[]) ?? [], tabInfo: (got.tabInfo as Record<string, TabInfo>) ?? {} };
}

async function tabPaused(tabId: number, platform: Platform | undefined, s?: Settings): Promise<boolean> {
	const { pausedTabs } = await tabs();
	const settings = s ?? (await getSettings());
	return pausedTabs.includes(tabId) || (!!platform && settings.pausedSites.includes(platform));
}

export async function refreshIcons(): Promise<void> {
	const status = await getStatus();
	await setGlobalIcon(status);
	const { tabInfo, pausedTabs } = await tabs();
	const s = await getSettings();
	const ids = new Set([...Object.keys(tabInfo).map(Number), ...pausedTabs]);
	for (const id of ids) await setTabIcon(id, await tabPaused(id, tabInfo[id]?.platform, s), status, tabInfo[id]?.count ?? 0);
}

async function setCounts(tabId: number, platform: Platform, counts: PageCounts) {
	const { tabInfo } = await tabs();
	const count = counts.hidden + counts.collapsed;
	tabInfo[tabId] = { platform, count };
	await chrome.storage.session.set({ tabInfo });
	await setTabIcon(tabId, await tabPaused(tabId, platform), await getStatus(), count);
}

export async function setTabPause(tabId: number, paused: boolean): Promise<void> {
	const { pausedTabs, tabInfo } = await tabs();
	const next = paused ? [...new Set([...pausedTabs, tabId])] : pausedTabs.filter((t) => t !== tabId);
	await chrome.storage.session.set({ pausedTabs: next });
	await chrome.tabs.sendMessage(tabId, { type: 'tab-paused', paused } satisfies ToPage).catch(() => undefined);
	await setTabIcon(tabId, paused || (!!tabInfo[tabId] && (await getSettings()).pausedSites.includes(tabInfo[tabId]!.platform)), await getStatus(), tabInfo[tabId]?.count ?? 0);
}

async function logActivity(entries: ActivityEntry[]) {
	for (const e of entries) await db.put('activity', e);
	await db.trim('activity', 1000);
	const got = (await chrome.storage.local.get(K.stats))[K.stats] as Stats | undefined;
	const stats: Stats = got ?? { firstRunAt: Date.now(), days: {} };
	const day = (stats.days[dayKey()] ??= { hidden: 0, collapsed: 0, labeled: 0 });
	for (const e of entries) {
		if (e.action === 'hide') day.hidden++;
		else if (e.action === 'collapse') day.collapsed++;
		else if (e.action === 'label') day.labeled++;
	}
	const keep = Object.keys(stats.days).sort().slice(-60);
	stats.days = Object.fromEntries(keep.map((k) => [k, stats.days[k]!]));
	await chrome.storage.local.set({ [K.stats]: stats });
}

// ---- First run ------------------------------------------------------------------------------------

async function ensureInstall() {
	await installId();
	const got = (await chrome.storage.local.get(K.stats))[K.stats] as Stats | undefined;
	if (!got) await chrome.storage.local.set({ [K.stats]: { firstRunAt: Date.now(), days: {} } satisfies Stats });
	const t = (await chrome.storage.local.get(K.planToken))[K.planToken] as string | undefined;
	if (t) await applyPlanToken(t);
}

// ---- Wiring ------------------------------------------------------------------------------------------

export function startWorker(): void {
	chrome.runtime.onInstalled.addListener(async ({ reason }) => {
		await ensureInstall();
		await chrome.alarms.create('sync', { periodInMinutes: 60, delayInMinutes: 60 });
		if (reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('/welcome.html') });
		await reconcileScripts();
		await syncAll();
	});

	chrome.runtime.onStartup.addListener(async () => {
		await ensureInstall();
		if (!(await chrome.alarms.get('sync'))) await chrome.alarms.create('sync', { periodInMinutes: 60 });
		await reconcileScripts();
		await syncAll();
	});

	chrome.alarms.onAlarm.addListener(async (a) => {
		if (a.name === 'sync') await syncAll();
		else if (a.name === 'tags') await flushTags();
	});

	chrome.permissions.onAdded.addListener(() => void reconcileScripts());
	chrome.permissions.onRemoved.addListener(() => void reconcileScripts());

	chrome.tabs.onRemoved.addListener(async (tabId) => {
		const { pausedTabs, tabInfo } = await tabs();
		delete tabInfo[tabId];
		await chrome.storage.session.set({ pausedTabs: pausedTabs.filter((t) => t !== tabId), tabInfo });
	});
	chrome.tabs.onUpdated.addListener(async (tabId, info) => {
		// A full navigation starts a new page; its content script reports fresh counts.
		if (info.status === 'loading') await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
	});

	chrome.storage.onChanged.addListener(async (changes, area) => {
		if (area === 'local' && changes[K.settings]) {
			const before = withDefaults(changes[K.settings]!.oldValue as Partial<Settings>);
			const after = withDefaults(changes[K.settings]!.newValue as Partial<Settings>);
			if (PLATFORMS.some((p) => before.platforms[p] !== after.platforms[p])) await reconcileScripts();
			if (before.pausedSites.join() !== after.pausedSites.join()) await refreshIcons();
			if (SYNCED.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
				await chrome.storage.local.set({ [K.syncState]: { ...(await syncState()), dirty: true } });
				void pushSettings();
			}
		}
		if (area === 'local' && changes[K.status]) await refreshIcons();
		if (area === 'local' && (changes[K.entitlement] || changes[K.adapterConfig])) await reconcileScripts();
	});

	chrome.runtime.onMessage.addListener((m: ToWorker, sender, reply) => {
		void handle(m, sender).then(reply, (e) => reply({ ok: false, error: String(e) }));
		return true;
	});

	chrome.runtime.onMessageExternal.addListener((m: { type?: string; token?: unknown }, sender, reply) => {
		void (async () => {
			if (sender.origin !== new URL(SITE).origin) return reply({ ok: false, error: 'origin_not_allowed' });
			switch (m?.type) {
				case 'colander:ping':
					return reply({ ok: true, version: VERSION });
				case 'colander:plan-token':
					return reply(typeof m.token === 'string' && (await applyPlanToken(m.token)) ? { ok: true } : { ok: false, error: 'invalid_token' });
				case 'colander:reviewer-token':
					if (typeof m.token !== 'string' || !m.token || m.token.length > 512) return reply({ ok: false, error: 'invalid_token' });
					await chrome.storage.local.set({ [K.reviewerToken]: m.token });
					return reply({ ok: true });
				default:
					return reply({ ok: false, error: 'unknown_message' });
			}
		})();
		return true;
	});
}

async function handle(m: ToWorker, sender: chrome.runtime.MessageSender): Promise<unknown> {
	const tabId = sender.tab?.id;
	switch (m.type) {
		case 'hello': {
			const { pausedTabs } = await tabs();
			return { tabPaused: tabId !== undefined && pausedTabs.includes(tabId) } satisfies HelloReply;
		}
		case 'counts':
			if (tabId !== undefined) await setCounts(tabId, m.platform, m.counts);
			return { ok: true };
		case 'settings':
			await updateSettings((s) => withDefaults({ ...s, ...m.patch }));
			return { ok: true };
		case 'delete-data':
			await deleteLocalData();
			await ensureInstall();
			await refreshIcons();
			return { ok: true };
		case 'activity':
			await logActivity(m.entries);
			return { ok: true };
		case 'tag':
			await addTag(m.tag, m.hold);
			return { ok: true };
		case 'report':
			return submitReport(m.report);
		case 'allow':
			await updateSettings((s) => ({ ...s, allows: upsert(s.allows, m.key, m.name), blocks: s.blocks.filter((e) => e.key !== m.key) }));
			return { ok: true };
		case 'block':
			await updateSettings((s) => ({ ...s, blocks: upsert(s.blocks, m.key, m.name), allows: s.allows.filter((e) => e.key !== m.key) }));
			return { ok: true };
		case 'unlist':
			await updateSettings((s) => ({ ...s, [m.list]: s[m.list].filter((e) => e.key !== m.key) }));
			return { ok: true };
		case 'pause-tab':
			await setTabPause(m.tabId, m.paused);
			return { ok: true };
		case 'sync-now':
			await syncAll();
			return { ok: true, status: await getStatus() };
		case 'start-trial':
			return startTrial();
		case 'refresh-reports': {
			const reports = await refreshReports();
			await setStatus({ reportsUpdated: false, reportsClosed: false });
			return { ok: reports !== null, reports };
		}
		case 'set-platform':
			await updateSettings((s) => ({ ...s, platforms: { ...s.platforms, [m.platform]: m.on } }));
			await reconcileScripts();
			return { ok: true };
		case 'open': {
			const url = chrome.runtime.getURL(m.page === 'options' ? `/options.html${m.section ? '#' + m.section : ''}` : '/welcome.html');
			await chrome.tabs.create({ url });
			return { ok: true };
		}
	}
}

/** Erases every local trace: lists, tags, activity, settings and the install ID. */
export async function deleteLocalData(): Promise<void> {
	await chrome.storage.local.clear();
	await chrome.storage.session.clear();
	await db.clear('kv');
	await db.clear('tags');
	await db.clear('activity');
	await clearList();
	await chrome.scripting.unregisterContentScripts().catch(() => undefined);
}

export type { Status };
