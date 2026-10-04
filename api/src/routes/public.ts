// The public source pages, the decision log and the website's counts (contracts 6.4; Go's
// internal/api/public.go). Their answers are the same for every viewer, so they carry the 60 s
// `public` cache policy, and these handlers never read the session: Workers Cache does not bypass
// cookie-only requests (hosting plan section 2). Errors stay no-store.
import type { Actor, LogEntry as WireLogEntry, Source as WireSource, Stats } from '@colander/shared/api';
import type { Platform, SlopType, Verdict } from '@colander/shared/verdicts';
import { json, jsonError, setCache } from '../http';
import { evidence, unix, type Evaluation } from '../scoring/engine';
import { SlopTypes } from '../scoring/rules';
import { appealStats } from '../store/appeals';
import { latestSequence } from '../store/list';
import { logCountSince, verdictCounts } from '../store/misc';
import { findSource as storeFindSource } from '../store/sources';
import { log, type LogEntry, type LogFilter } from '../store/verdicts';
import { canonicalSource, validPlatform } from './ids';
import { activeInstalls } from './list';
import { optString, optTime, parseInt64, pathValue, rfc3339, signalNames, testNames, verdictCode } from './respond';
import type { Api, Params } from './server';

/** A decision log entry on the wire. */
export function toLog(e: LogEntry): WireLogEntry {
	return {
		id: 'log_' + e.id,
		at: rfc3339(e.at),
		platform: e.platform as Platform,
		target_type: e.targetType as 'source' | 'item',
		target_id: e.targetId,
		source_id: e.sourceKey,
		source_name: optString(e.sourceName),
		from: optString<Verdict>(e.from),
		to: optString<Verdict>(e.to),
		reason: e.reason,
		signals: signalNames(e.signals),
		actor: e.actor as Actor,
		actor_name: optString(e.actorName)
	};
}

/** Go's round2: two decimals, halves up. */
export const round2 = (f: number): number => Math.trunc(f * 100 + 0.5) / 100;

/**
 * A scored source on the wire, with its public evidence summary. Public pages never name a data
 * source and never show YouTube Data API figures: `imported` is false, `attribution` and
 * `uploads_per_day` are null (contracts 6.4). The review API fills in the seed provenance.
 */
export function toSource(ev: Evaluation): WireSource {
	const src = ev.data.source;
	const st = src.state;
	const e = evidence(ev);
	return {
		platform: src.platform as Platform,
		id: src.canonicalId,
		aliases: src.aliases,
		name: optString(src.name),
		verdict: optString<Verdict>(st.verdict),
		signals: signalNames(st.signals),
		slop_type: optString<SlopType>(SlopTypes[st.detail & 3]!),
		tests: testNames(st.detail),
		large: ev.input.large,
		audience_known: ev.input.audienceKnown,
		imported: false,
		attribution: null,
		appeal_open: ev.data.appealOpen,
		updated_at: optTime(st.changedAt),
		rescore_at: optTime(st.rescoreAt),
		evidence: {
			taggers: e.taggers,
			tags: { slop: e.slop, ai_fine: e.aiFine, not_slop: e.notSlop },
			items_seen: e.itemsSeen,
			ai_item_share: e.itemsSeen > 0 ? round2(e.aiItemShare) : null,
			uploads_per_day: null
		}
	};
}

/** Resolves a platform and any alias to a source ref, or answers 404 not_rated (Go's findSource). */
export function findSource(api: Api, platform: string, alias: string): number | Response {
	const id = canonicalSource(platform, alias);
	const ref = id === undefined ? undefined : storeFindSource(api.store.db, platform, id);
	return ref ?? jsonError(404, 'not_rated', 'Colander has no information about this source.');
}

/** Resolves the {platform} and {source_id} path values (Go's lookupSource). */
export const lookupSource = (api: Api, params: Params): number | Response =>
	findSource(api, pathValue(params, 'platform'), pathValue(params, 'source_id'));

/** Scores a source for display; it was just looked up, so it exists. */
export function explain(api: Api, ref: number): Evaluation {
	const ev = api.store.engine.explain(ref);
	if (!ev) throw new Error(`source ${ref} vanished`);
	return ev;
}

const publicJSON = (body: unknown): Response => json(200, body, setCache(new Headers(), 'public'));

/** GET /v1/sources/{platform}/{source_id} (contract 6.4). */
export function getSource(api: Api, _request: Request, _url: URL, params: Params): Response {
	const ref = lookupSource(api, params);
	if (ref instanceof Response) return ref;
	const ev = explain(api, ref);
	const history = log(api.store.db, { sourceRef: ref, limit: 50 });
	return publicJSON({ source: toSource(ev), history: history.map(toLog) });
}

/** GET /v1/log?cursor=&platform=&verdict=&limit= (contract 6.4), newest first. */
export function getLog(api: Api, _request: Request, url: URL): Response {
	const q = url.searchParams;
	const f: LogFilter = { platform: q.get('platform') ?? '', verdict: q.get('verdict') ?? '', limit: 50 };
	if (f.platform && !validPlatform(f.platform)) return jsonError(400, 'invalid_platform', 'platform must be yt, tt, ig or fb.');
	if (f.verdict && verdictCode(f.verdict) === 0) return jsonError(400, 'invalid_verdict', 'verdict must be one of the five verdicts.');
	const c = q.get('cursor') ?? '';
	if (c !== '') {
		const id = parseInt64(c.startsWith('log_') ? c.slice('log_'.length) : c);
		if (id === undefined || id <= 0) return jsonError(400, 'invalid_cursor', 'The cursor is not valid.');
		f.before = id;
	}
	const l = q.get('limit') ?? '';
	if (l !== '') {
		const n = parseInt64(l);
		if (n === undefined || n < 1) return jsonError(400, 'invalid_limit', 'limit must be a number from 1 to 200.');
		f.limit = Math.min(n, 200);
	}
	const limit = f.limit;
	let list = log(api.store.db, { ...f, limit: limit + 1 });
	let next: string | null = null;
	if (list.length > limit) {
		list = list.slice(0, limit);
		next = 'log_' + list[limit - 1]!.id;
	}
	return publicJSON({ entries: list.map(toLog), next_cursor: next });
}

/** GET /v1/stats (contract 6.4): public counts for the website. */
export function getStats(api: Api): Response {
	const { db } = api.store;
	const now = api.store.now();
	const { counts, items } = verdictCounts(db);
	const { open, medianDays } = appealStats(db);
	const seq = latestSequence(db);
	const stats: Stats = {
		sources: counts as Record<Verdict, number>,
		items,
		decisions_7d: logCountSince(db, unix(now) - 7 * 24 * 3600),
		appeals: { open, median_days: medianDays === null ? null : round2(medianDays) },
		active_installs: activeInstalls(api.store),
		list_sequence: seq.seq,
		list_updated_at: optTime(seq.createdAt)
	};
	return publicJSON(stats);
}
