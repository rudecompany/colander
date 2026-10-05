// The background: list and config sync, the tag queue, reports, plan tokens and Plus settings
// sync, content script registration, the toolbar badge, and pairing codes from the website. A
// service worker in Chromium and an event page in Firefox: all state lives in storage and
// IndexedDB, and module variables are only queues and caches.
import { normalizePairCode, type PairBrowser, type PairClaimed, type Report, type Tag } from '@colander/shared/api';
import { PLATFORMS, type Platform } from '@colander/shared/verdicts';
import defaults from '../adapters/default-config.json';
import { validateConfig, type AdapterConfig } from '../adapters/schema';
import * as db from '../lib/db';
import { allowed } from '../lib/consent';
import { PUBLIC_KEYS } from '../lib/env';
import { targetKey } from '@colander/shared/ids';
import type { ActivityEntry, HelloReply, PageCounts, PairReply, ReportReply, ReportRequest, TagRequest, ToPage, ToWorker } from '../lib/messages';
import { offered, ORIGINS } from '../lib/platforms';
import {
	dayKey,
	isPlus,
	K,
	level,
	withDefaults,
	type Entitlement,
	type MyListEntry,
	type OwnTag,
	type Settings,
	type Stats,
	type Status
} from '../lib/settings';
import { CONFIG_CONTEXT, importKeys, verifyEnvelope, verifyPlanToken, type TrustedKey } from '@colander/shared/signing';
import { setGlobalIcon, setTabIcon, type PauseScope } from './icons';
import { clearList, getStatus, setStatus, syncList } from './listsync';
import { ApiError, ConsentError, installId, json, request } from './net';
import { dueBatch, enqueue, nextDue, settle, type Outcome, type Queued } from './queue';
import { browser, type Browser } from 'wxt/browser';

const VERSION = browser.runtime.getManifest().version;
let keysP: Promise<TrustedKey[]> | null = null;
const keys = () => (keysP ??= importKeys(PUBLIC_KEYS));

// ---- Settings ------------------------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
	const got = await browser.storage.local.get(K.settings);
	return withDefaults(got[K.settings] as Partial<Settings>);
}

/** Serialized read-modify-write, so two quick changes never overwrite each other. */
let settingsChain: Promise<unknown> = Promise.resolve();
export function updateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
	const next = settingsChain.then(async () => {
		const s = fn(await getSettings());
		await browser.storage.local.set({ [K.settings]: s });
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
	const got = await browser.storage.local.get([K.adapterConfig, K.entitlement]);
	const plus = isPlus(got[K.entitlement] as Entitlement | undefined);
	const registered = new Set((await browser.scripting.getRegisteredContentScripts()).map((r) => r.id));
	for (const p of PLATFORMS) {
		const granted = await browser.permissions.contains({ origins: ORIGINS[p] });
		const want = s.platforms[p] && granted && offered(p, got[K.adapterConfig] as AdapterConfig | undefined, plus);
		const ids = [`cl-${p}`, `cl-${p}-bridge`];
		if (want) {
			const missing = ids.filter((id) => !registered.has(id));
			if (!missing.length) continue;
			// Careful: an empty `ids` list unregisters every script, not none.
			const stale = ids.filter((id) => registered.has(id));
			if (stale.length) await browser.scripting.unregisterContentScripts({ ids: stale });
			await browser.scripting.registerContentScripts([
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
			if (present.length) await browser.scripting.unregisterContentScripts({ ids: present });
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
		const got = await browser.storage.local.get(K.adapterConfig);
		const cached = got[K.adapterConfig] as AdapterConfig | undefined;
		const have = Math.max((defaults as AdapterConfig).version, cached?.version ?? 0);
		if (payload.version > have) {
			await browser.storage.local.set({ [K.adapterConfig]: payload });
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

/**
 * Tag work runs one step at a time. Adding and flushing both read the queue (and adding reads
 * own tags) and write it back, so overlapping steps lose updates: a tag added while a flush was
 * sending was missed, and the alarm was set from the stale queue, so it waited until a later sync.
 */
let tagWork: Promise<void> = Promise.resolve();
function serialTags(step: () => Promise<void>): Promise<void> {
	const run = tagWork.then(step, step);
	tagWork = run.catch(() => undefined);
	return run;
}

export async function addTag(req: TagRequest, hold = false): Promise<void> {
	await serialTags(() => queueTag(req, hold));
	// A held tag is not due yet: this sends any other due tags and sets the alarm for it.
	await flushTags();
}

async function queueTag(req: TagRequest, hold: boolean): Promise<void> {
	const key = targetKey(req.platform, req.targetType, req.targetId);
	const own = (await browser.storage.local.get(K.ownTags))[K.ownTags] as Record<string, OwnTag> | undefined;
	await browser.storage.local.set({ [K.ownTags]: { ...own, [key]: { verdict: req.verdict, at: Date.now() } } });
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
}

/** Undo: the own tag goes, and so does its queued tag while it is still held or waiting. */
export async function removeTag(key: string): Promise<void> {
	// A tag step like adding, so a flush that is sending cannot write the undone tag back.
	await serialTags(async () => {
		const own = { ...((await browser.storage.local.get(K.ownTags))[K.ownTags] as Record<string, OwnTag> | undefined) };
		delete own[key];
		await browser.storage.local.set({ [K.ownTags]: own });
		for (const q of await db.all<Queued>('tags')) if (q.target === key) await db.del('tags', q.client_id);
	});
	await flushTags();
}

export function flushTags(): Promise<void> {
	return serialTags(flushOnce);
}

async function flushOnce(): Promise<void> {
	// Firefox: tags wait on the device until sending them is allowed; they apply here at once.
	// Once one is due (its toast has closed), Options opens at Sharing, where allowing it sends them
	// through permissions.onAdded.
	if (!(await allowed('websiteContent'))) {
		await browser.alarms.clear('tags');
		if (dueBatch(await db.all<Queued>('tags'), Date.now()).length) await openSharing(false);
		return;
	}
	try {
		for (;;) {
			const now = Date.now();
			const batch = dueBatch(await db.all<Queued>('tags'), now);
			if (!batch.length) break;
			let outcome: Outcome;
			try {
				const res = await request('/v1/tags', { body: { tags: batch.map((q) => q.tag) }, auth: { install: true }, consent: 'websiteContent' });
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
		if (due === null) await browser.alarms.clear('tags');
		else await browser.alarms.create('tags', { when: Math.max(due, Date.now() + 30_000) });
	}
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
		const { report } = await json<{ report: Report }>(await request('/v1/reports', { body, auth: { install: true }, consent: 'websiteContent' }));
		const cached = ((await browser.storage.local.get(K.reports))[K.reports] as Report[] | undefined) ?? [];
		await browser.storage.local.set({ [K.reports]: [report, ...cached.filter((x) => x.id !== report.id)] });
		return { ok: true, report };
	} catch (e) {
		if (e instanceof ConsentError) {
			await openSharing(true);
			return { ok: false, error: 'Firefox asks you first. Allow Colander to send tags and reports in the tab that opened, then send this report again.' };
		}
		if (e instanceof ApiError) return { ok: false, error: e.message };
		return { ok: false, error: 'Could not reach Colander. Check your connection and try again.' };
	}
}

async function cachedReports(): Promise<Report[]> {
	return ((await browser.storage.local.get(K.reports))[K.reports] as Report[] | undefined) ?? [];
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
		const { reports } = await json<{ reports: Report[] }>(await request('/v1/reports', { auth: { install: true }, consent: 'websiteContent' }));
		const before = new Map(cached.map((r) => [r.id, r.status]));
		const landed = reports.filter((r) => before.has(r.id) && before.get(r.id) !== r.status && r.status !== 'under_review');
		await browser.storage.local.set({ [K.reports]: reports });
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

/**
 * Stores a verified plan token. Every token arrives fresh from the server (pairing code, trial
 * or refresh), so the plan counts as checked now and the daily refresh starts from here.
 */
export async function applyPlanToken(token: string): Promise<boolean> {
	const p = await verifyPlanToken(token, await keys());
	if (!p) return false;
	const ent: Entitlement = { plus: true, trial: p.trial, exp: p.exp };
	await browser.storage.local.set({ [K.planToken]: token, [K.entitlement]: ent, [K.planCheckedAt]: Date.now() });
	return true;
}

async function planToken(): Promise<string | null> {
	const t = (await browser.storage.local.get(K.planToken))[K.planToken] as string | undefined;
	if (!t) return null;
	const p = await verifyPlanToken(t, await keys());
	return p && Date.now() / 1000 < p.exp ? t : null;
}

export async function startTrial(): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const { token } = await json<{ token: string }>(await request('/v1/trial', { method: 'POST', auth: { install: true }, consent: 'authenticationInfo' }));
		if (!(await applyPlanToken(token))) return { ok: false, error: 'The trial token could not be verified.' };
		return { ok: true };
	} catch (e) {
		if (e instanceof ConsentError) return { ok: false, error: CONSENT_PLUS };
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
	const got = await browser.storage.local.get([K.planToken, K.planCheckedAt]);
	const t = got[K.planToken] as string | undefined;
	if (!t) return;
	const p = await verifyPlanToken(t, await keys());
	if (!p) {
		await browser.storage.local.remove([K.planToken, K.entitlement]);
		return;
	}
	if (p.trial || Date.now() - ((got[K.planCheckedAt] as number | undefined) ?? 0) < 86_400_000) return;
	try {
		const { token } = await json<{ token: string }>(await request('/v1/entitlement/refresh', { body: { token: t }, consent: 'authenticationInfo' }));
		await applyPlanToken(token);
	} catch (e) {
		if (e instanceof ApiError && e.status === 404 && e.code === 'no_plan') {
			await browser.storage.local.remove([K.planToken, K.planCheckedAt]);
			await browser.storage.local.set({ [K.entitlement]: { plus: false, trial: false, exp: p.exp } satisfies Entitlement });
		}
		// Offline or a server error: keep the token and try again on the next hourly sync.
	}
}

const SYNCED = ['strictness', 'perPlatform', 'topics', 'allows', 'blocks', 'plainChips'] as const;
type SyncState = { version: number; dirty: boolean };
/** Synced settings just taken from the server, so the change listener does not echo them back. */
let pulled = '';

async function syncState(): Promise<SyncState> {
	return { version: 0, dirty: false, ...((await browser.storage.local.get(K.syncState))[K.syncState] as Partial<SyncState>) };
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
	const put = (version: number, data: unknown) => request('/v1/sync', { method: 'PUT', body: { version, data }, auth: { plan: token }, consent: 'authenticationInfo' });
	try {
		let res = await put(st.version, pick(s));
		if (res.status === 409) {
			// A server with no copy yet answers data: null, version 0 (for example after its data was reset).
			const remote = (await res.json()) as { version: number; data: Partial<Settings> | null };
			const merged = await updateSettings((cur) => mergeRemote(cur, remote.data ?? {}, true));
			res = await put(remote.version, pick(merged));
		}
		const out = await json<{ version?: number }>(res);
		await browser.storage.local.set({ [K.syncState]: { version: out?.version ?? st.version + 1, dirty: false } });
	} catch {
		await browser.storage.local.set({ [K.syncState]: { ...st, dirty: true } });
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
	// Through withDefaults, so a level another browser still syncs, such as the removed Strict, arrives as Standard.
	return withDefaults({ ...local, ...scalars, allows: union(local.allows, remote.allows), blocks: union(local.blocks, remote.blocks) });
}

/**
 * Once, after an update: levels an older version stored, such as the removed Strict, are rewritten
 * as Standard, and the synced copy is marked to go out again, so other browsers get them too.
 */
export async function migrateSettings(): Promise<void> {
	const raw = (await browser.storage.local.get(K.settings))[K.settings] as Partial<Settings> | undefined;
	if (!raw) return;
	const levels = [raw.strictness, ...Object.values(raw.perPlatform ?? {}), ...(raw.topics ?? []).map((t) => t.strictness)];
	if (levels.every((v) => v === undefined || level(v) === v)) return;
	await browser.storage.local.set({ [K.settings]: withDefaults(raw), [K.syncState]: { ...(await syncState()), dirty: true } });
}

export async function pullSettings(): Promise<void> {
	const token = await planToken();
	if (!token) return;
	const st = await syncState();
	if (st.dirty) return pushSettings();
	try {
		const res = await request('/v1/sync', { auth: { plan: token }, consent: 'authenticationInfo' });
		if (res.status === 404) return pushSettings();
		const remote = await json<{ version: number; data: Partial<Settings> | null }>(res);
		// An empty blob ({"version": 0, "data": null}) means this account has not synced yet.
		if (!remote?.data) return pushSettings();
		if (remote.version > st.version) {
			const merged = await updateSettings((cur) => {
				const m = mergeRemote(cur, remote.data ?? {}, false);
				pulled = JSON.stringify(pick(m));
				return m;
			});
			// Send back only what this browser adds, such as allows the server did not have yet.
			const ahead = SYNCED.some((k) => JSON.stringify(merged[k]) !== JSON.stringify(remote.data?.[k]));
			await browser.storage.local.set({ [K.syncState]: { version: remote.version, dirty: ahead } });
			if (ahead) await pushSettings();
		}
	} catch {
		// Offline: try again on the next hourly sync.
	}
}

const CONSENT_PLUS = 'Firefox asks you first. Allow Colander to use your Plus or reviewer sign-in, then try again.';

// ---- Pairing codes and consent ------------------------------------------------------------------

/** Which browser this is, for the website's "Connected" line (contracts 7). */
function pairBrowser(): PairBrowser {
	if (import.meta.env.FIREFOX) return 'firefox';
	if (import.meta.env.SAFARI) return 'safari';
	const ua = navigator.userAgent;
	const brands = ((navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand).join();
	if (/Brave/.test(brands) || 'brave' in navigator) return 'brave';
	if (/Microsoft Edge/.test(brands) || /\bEdg\//.test(ua)) return 'edge';
	if (/Opera/.test(brands) || /\bOPR\//.test(ua)) return 'opera';
	return /Google Chrome/.test(brands) ? 'chrome' : 'chromium';
}

/**
 * Takes a code the website showed (contracts 7): the claim answers with a plan token, which is
 * verified and stored, or a reviewer token for the side panel, which replaces any earlier one.
 */
export async function pair(input: string): Promise<PairReply> {
	const code = normalizePairCode(input);
	if (!code) return { ok: false, error: 'Enter the 8 characters of the code, for example KXQ4-JP7M.' };
	try {
		const body = { code, ext_version: VERSION, browser: pairBrowser() };
		const got = await json<PairClaimed>(await request('/v1/pair/claim', { body, consent: 'authenticationInfo' }));
		if (got.kind === 'reviewer') {
			await browser.storage.local.set({ [K.reviewerToken]: got.token });
			return { ok: true, kind: 'reviewer' };
		}
		if (!(await applyPlanToken(got.token))) return { ok: false, error: 'Colander could not verify this plan. Update Colander, then make a new code.' };
		void pullSettings();
		return { ok: true, kind: 'plan' };
	} catch (e) {
		if (e instanceof ConsentError) return { ok: false, error: CONSENT_PLUS };
		if (e instanceof ApiError) return { ok: false, error: e.message };
		return { ok: false, error: 'Could not reach Colander. Check your connection and try again.' };
	}
}

/**
 * Firefox: opens Options at Sharing, where one click allows sending tags and reports. A tag that
 * waits opens it once per browser session; a report the person just sent always does.
 */
async function openSharing(always: boolean): Promise<void> {
	if (!always) {
		if ((await browser.storage.session.get('sharingAsked')).sharingAsked) return;
		await browser.storage.session.set({ sharingAsked: true });
	}
	await browser.tabs.create({ url: browser.runtime.getURL('/options.html#sharing') });
}

// ---- Toolbar, tabs and activity ----------------------------------------------------------------

type TabInfo = { platform: Platform; count: number };

async function tabs(): Promise<{ pausedTabs: number[]; tabInfo: Record<string, TabInfo> }> {
	const got = await browser.storage.session.get(['pausedTabs', 'tabInfo']);
	return { pausedTabs: (got.pausedTabs as number[]) ?? [], tabInfo: (got.tabInfo as Record<string, TabInfo>) ?? {} };
}

/** Whether the tab is paused, and by what: the tab, or its site. */
async function tabPaused(tabId: number, platform: Platform | undefined, s?: Settings): Promise<PauseScope> {
	const { pausedTabs } = await tabs();
	const settings = s ?? (await getSettings());
	return pausedTabs.includes(tabId) ? 'tab' : !!platform && settings.pausedSites.includes(platform) ? 'site' : null;
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
	const count = counts.hidden;
	tabInfo[tabId] = { platform, count };
	await browser.storage.session.set({ tabInfo });
	await setTabIcon(tabId, await tabPaused(tabId, platform), await getStatus(), count);
}

export async function setTabPause(tabId: number, paused: boolean): Promise<void> {
	const { pausedTabs, tabInfo } = await tabs();
	const next = paused ? [...new Set([...pausedTabs, tabId])] : pausedTabs.filter((t) => t !== tabId);
	await browser.storage.session.set({ pausedTabs: next });
	await browser.tabs.sendMessage(tabId, { type: 'tab-paused', paused } satisfies ToPage).catch(() => undefined);
	const site = !!tabInfo[tabId] && (await getSettings()).pausedSites.includes(tabInfo[tabId]!.platform);
	await setTabIcon(tabId, paused ? 'tab' : site ? 'site' : null, await getStatus(), tabInfo[tabId]?.count ?? 0);
}

async function logActivity(entries: ActivityEntry[]) {
	for (const e of entries) await db.put('activity', e);
	await db.trim('activity', 1000);
	const got = (await browser.storage.local.get(K.stats))[K.stats] as Stats | undefined;
	const stats: Stats = got ?? { firstRunAt: Date.now(), days: {} };
	const day = (stats.days[dayKey()] ??= { hidden: 0, labeled: 0 });
	for (const e of entries) {
		if (e.action === 'hide') day.hidden++;
		else if (e.action === 'label') day.labeled++;
	}
	const keep = Object.keys(stats.days).sort().slice(-60);
	stats.days = Object.fromEntries(keep.map((k) => [k, stats.days[k]!]));
	await browser.storage.local.set({ [K.stats]: stats });
}

// ---- First run ------------------------------------------------------------------------------------

async function ensureInstall() {
	await installId();
	const got = (await browser.storage.local.get(K.stats))[K.stats] as Stats | undefined;
	if (!got) await browser.storage.local.set({ [K.stats]: { firstRunAt: Date.now(), days: {} } satisfies Stats });
	const t = (await browser.storage.local.get(K.planToken))[K.planToken] as string | undefined;
	if (t) await applyPlanToken(t);
}

// ---- Wiring ------------------------------------------------------------------------------------------

export function startWorker(): void {
	browser.runtime.onInstalled.addListener(async ({ reason }) => {
		await ensureInstall();
		if (reason === 'update') await migrateSettings();
		await browser.alarms.create('sync', { periodInMinutes: 60, delayInMinutes: 60 });
		if (reason === 'install') await browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
		await reconcileScripts();
		await syncAll();
	});

	browser.runtime.onStartup.addListener(async () => {
		await ensureInstall();
		if (!(await browser.alarms.get('sync'))) await browser.alarms.create('sync', { periodInMinutes: 60 });
		await reconcileScripts();
		await syncAll();
	});

	browser.alarms.onAlarm.addListener(async (a) => {
		if (a.name === 'sync') await syncAll();
		else if (a.name === 'tags') await flushTags();
	});

	browser.permissions.onAdded.addListener(() => {
		void reconcileScripts();
		// Firefox: allowing data collection sends the tags that waited for it.
		void flushTags();
	});
	browser.permissions.onRemoved.addListener(() => void reconcileScripts());

	browser.tabs.onRemoved.addListener(async (tabId) => {
		const { pausedTabs, tabInfo } = await tabs();
		delete tabInfo[tabId];
		await browser.storage.session.set({ pausedTabs: pausedTabs.filter((t) => t !== tabId), tabInfo });
	});
	browser.tabs.onUpdated.addListener(async (tabId, info) => {
		// A full navigation starts a new page; its content script reports fresh counts.
		if (info.status === 'loading') await browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
	});

	browser.storage.onChanged.addListener(async (changes, area) => {
		if (area === 'local' && changes[K.settings]) {
			const before = withDefaults(changes[K.settings]!.oldValue as Partial<Settings>);
			const after = withDefaults(changes[K.settings]!.newValue as Partial<Settings>);
			if (PLATFORMS.some((p) => before.platforms[p] !== after.platforms[p])) await reconcileScripts();
			if (before.pausedSites.join() !== after.pausedSites.join()) await refreshIcons();
			if (SYNCED.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
				const fromServer = JSON.stringify(pick(after)) === pulled;
				pulled = '';
				if (!fromServer) {
					await browser.storage.local.set({ [K.syncState]: { ...(await syncState()), dirty: true } });
					void pushSettings();
				}
			}
		}
		if (area === 'local' && changes[K.status]) await refreshIcons();
		if (area === 'local' && (changes[K.entitlement] || changes[K.adapterConfig])) await reconcileScripts();
	});

	browser.runtime.onMessage.addListener((m: ToWorker, sender, reply) => {
		void handle(m, sender).then(reply, (e) => reply({ ok: false, error: String(e) }));
		return true;
	});
}

async function handle(m: ToWorker, sender: Browser.runtime.MessageSender): Promise<unknown> {
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
		case 'untag':
			await removeTag(m.key);
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
		case 'pair':
			return pair(m.code);
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
			const url = browser.runtime.getURL(m.page === 'options' ? `/options.html${m.section ? '#' + m.section : ''}` : '/welcome.html');
			await browser.tabs.create({ url });
			return { ok: true };
		}
	}
}

/**
 * Erases every local trace: lists, tags, activity, settings and the install ID. Runs as a tag
 * step, so a flush that is sending cannot write its batch back after the clear.
 */
export function deleteLocalData(): Promise<void> {
	return serialTags(async () => {
		await browser.storage.local.clear();
		await browser.storage.session.clear();
		await db.clear('kv');
		await db.clear('tags');
		await db.clear('activity');
		await clearList();
		await browser.scripting.unregisterContentScripts().catch(() => undefined);
	});
}

export type { Status };
