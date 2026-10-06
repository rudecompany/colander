// The review API for curators and staff (contract 6.7; Go's internal/api/review.go), used by the
// review console with the session cookie and CSRF header and by the extension side panel with a
// reviewer bearer token. Each decision and appeal action is one transaction with its inline
// rescore and decision log entry (src/scoring/actions.ts).
import { CALIBRATION_KINDS, CALIBRATION_LANGUAGES, type ItemSummary, type Layer, type Layers, type QueueItem, type ReportDetail, type SeedProvenance } from '@colander/shared/api';
import type { Platform, SlopType, Verdict } from '@colander/shared/verdicts';
import { FLAG_LARGE } from '@colander/shared/list';
import { json, jsonError } from '../http';
import {
	AIEvidenceRequiredError,
	decide as engineDecide,
	resolveAppeal,
	StaffRequiredError,
	verifyAppeal,
	type DecisionInput
} from '../scoring/actions';
import { unix, type Evaluation } from '../scoring/engine';
import { BehaviorSignals, ProvenanceSignals, slopTypeCode } from '../scoring/rules';
import { csrfOk, csrfRequired, hostOf, signedIn, TTL } from '../auth';
import { authority as rolesAuthority, rank, type Role } from '../permissions';
import type { Account } from '../store/accounts';
import { staffOf } from '../staff';
import { AppealPendingManual, AppealUnderReview, appealsBySource, appealsWithStatus, getAppeal, type Appeal } from '../store/appeals';
import { addLabel, LABELS, nextCalibration, type CalibrationTask, type Label } from '../store/calibration';
import { ConflictError, NotFoundError } from '../store/db';
import { leadSummaries, namedDataset, recordProvenanceRead, seedLeads, setSeedSuppression, type SeedLead } from '../store/seeds';
import { ensureItem, ensureSource, findItem, findSource, getSource, namedSeedList, type Source } from '../store/sources';
import { dismissReport, getReport, openReports, reportsBySource, type Report } from '../store/tags';
import { log, openEscalations } from '../store/verdicts';
import { toAppeal } from './appeals';
import { toReport } from './extension';
import { canonicalItem, canonicalSource, validPlatform } from './ids';
import { activeInstalls } from './list';
import { explain, lookupSource, toLog, toSource } from './public';
import { decode, fields, goFixed, optString, parseInt64, pathValue, rfc3339, runeCount, signalMask, signalNames, testBits, testNames, trimSpace, verdictCode } from './respond';
import type { Api, Params } from './server';

/** A reviewer and the authority this request gives them (src/permissions.ts). */
interface Reviewer {
	account: Account;
	authority: Role;
}

/**
 * Authenticates a reviewer (contracts 6.7). On the admin host: the staff member Access let in,
 * with their full role. On the main host: a reviewer token, or a session that signed in with a
 * passkey within 12 hours (else 403 passkey_required), and curator authority at most. A reviewer
 * token works in any browser on any device, so it carries curator authority also for staff.
 */
function reviewer(api: Api, request: Request): Reviewer | Response {
	const { store } = api;
	if (hostOf(request) === 'admin') {
		if (!csrfOk(request)) return csrfRequired();
		const st = staffOf(store, request);
		return st instanceof Response ? st : { account: st.account, authority: st.actor.authority };
	}
	const auth = request.headers.get('Authorization') ?? '';
	let a: Account;
	if (auth.startsWith('Bearer ')) {
		const t = store.auth.reviewerAccount(trimSpace(auth.slice('Bearer '.length)));
		if (t === 'expired') return jsonError(401, 'token_expired', 'The reviewer token expired after 7 days. Connect the side panel again from your account page.');
		if (!t) return jsonError(401, 'invalid_token', 'The reviewer token is not valid. Connect the side panel again from your account page.');
		a = t;
	} else {
		const ses = signedIn(store.auth, request);
		if (ses instanceof Response) return ses;
		a = ses.account;
		if (rank(a.role) >= rank('curator') && (!store.auth.passkey(ses) || unix(store.now()) - ses.authenticatedAt > TTL.curatorFresh)) {
			return jsonError(403, 'passkey_required', 'Review needs a passkey sign-in from the last 12 hours. Confirm it is you with your passkey.');
		}
	}
	const authority = rolesAuthority(a.role, 'main');
	if (!authority) return jsonError(403, 'forbidden', 'Only curators and staff can review.');
	return { account: a, authority };
}

const staffRequired = (what: string): Response =>
	jsonError(403, 'staff_required', `${what} need staff review. Staff decide them in the admin console.`);

/** Collapses whitespace and cuts s to n characters with an ellipsis. */
function clip(s: string, n: number): string {
	s = fields(s).join(' ');
	const chars = [...s];
	return chars.length <= n ? s : chars.slice(0, n - 1).join('') + '…';
}

/** GET /v1/review/queue?kind=all|reports|appeals|escalations|leads&cursor= */
export function reviewQueue(api: Api, request: Request, url: URL): Response {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const { db } = api.store;
	const kind = url.searchParams.get('kind') || 'all';
	if (!['all', 'reports', 'appeals', 'escalations', 'leads'].includes(kind)) {
		return jsonError(400, 'invalid_kind', 'kind must be all, reports, appeals, escalations or leads.');
	}
	let offset = 0;
	const c = url.searchParams.get('cursor') ?? '';
	if (c !== '') {
		const n = parseInt64(c);
		if (n === undefined || n < 0) return jsonError(400, 'invalid_cursor', 'The cursor is not valid.');
		offset = n;
	}

	const bySource = new Map<number, Report[]>();
	for (const rp of openReports(db)) {
		const list = bySource.get(rp.sourceRef);
		if (list) list.push(rp);
		else bySource.set(rp.sourceRef, [rp]);
	}
	const sources = new Map<number, Source>();
	const items: (QueueItem & { created: number })[] = [];
	const add = (ref: number, q: { id: string; kind: QueueItem['kind']; priority: number; summary: string; created: number; lead?: boolean }): void => {
		let src = sources.get(ref);
		if (!src) {
			src = getSource(db, ref);
			if (!src) throw new Error(`source ${ref} vanished`);
			sources.set(ref, src);
		}
		const large = (src.state.flags & FLAG_LARGE) !== 0 || src.largeStaff;
		items.push({
			id: q.id,
			kind: q.kind,
			// Triage by audience size.
			priority: large && q.priority > 1 ? q.priority - 1 : q.priority,
			created_at: rfc3339(q.created),
			platform: src.platform as Platform,
			source_id: src.canonicalId,
			source_name: optString(src.name),
			summary: q.summary,
			large,
			verdict: optString<Verdict>(src.state.verdict),
			computed_verdict: optString<Verdict>(src.state.computed),
			report_count: bySource.get(ref)?.length ?? 0,
			lead: q.lead ?? false,
			created: q.created
		});
	};

	if (kind === 'all' || kind === 'appeals') {
		for (const ap of appealsWithStatus(db, AppealPendingManual, AppealUnderReview)) {
			const summary =
				ap.status === AppealPendingManual ? 'Appeal waiting for a manual check of code ' + ap.code : 'Appeal under review: ' + clip(ap.statement, 80);
			add(ap.sourceRef, { id: 'q_' + ap.id, kind: 'appeal', priority: 1, summary, created: ap.createdAt });
		}
	}
	if (kind === 'all' || kind === 'escalations' || kind === 'leads') {
		// ponytail: loads every open escalation's source per request, seed leads included; page in SQL
		// once imports put tens of thousands of leads in the queue.
		const leads = leadSummaries(db, api.store.engine.seeds, unix(api.store.now()));
		for (const e of openEscalations(db)) {
			if (kind === 'leads' && e.kind !== 'seed') continue;
			if (e.kind !== 'seed') {
				// An appeal staff have left waiting comes first.
				add(e.sourceRef, { id: 'q_esc_' + e.id, kind: 'escalation', priority: e.kind === 'appeal' ? 1 : 2, summary: e.summary, created: e.createdAt });
				continue;
			}
			// A seed lead is not evidence and comes last, unless a report or a slop tag backs it or a
			// calibrated seed list names its channel ID. The summary names no list: curators see it.
			// kind=all carries only the backed ones, so thousands of leads do not bury the reports.
			const l = leads.get(e.sourceRef);
			if (!l) continue; // its entries expired since the last pass, which closes it
			const backed = l.calibrated || bySource.has(e.sourceRef) || db.get("SELECT 1 FROM tags WHERE source_id = ? AND verdict = 'slop' LIMIT 1", e.sourceRef) !== undefined;
			if (kind === 'all' && !backed) continue;
			const lists = l.lists === 1 ? '1 seed list' : `${l.lists} seed lists`;
			add(e.sourceRef, { id: 'q_esc_' + e.id, kind: 'escalation', priority: backed ? 3 : 4, summary: `Seed lead on ${lists}, not evidence`, created: e.createdAt, lead: true });
		}
	}
	if (kind === 'all' || kind === 'reports') {
		for (const [ref, list] of bySource) {
			const first = list[0]!;
			const summary = list.length === 1 ? '1 report: ' + clip(first.reason, 60) : `${list.length} reports: ${clip(first.reason, 60)}`;
			add(ref, { id: 'q_rpt_' + ref, kind: 'report', priority: 3, summary, created: first.createdAt });
		}
	}
	items.sort((x, y) => x.priority - y.priority || x.created - y.created || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
	const PAGE = 50;
	offset = Math.min(offset, items.length);
	const end = Math.min(offset + PAGE, items.length);
	const page = items.slice(offset, end).map(({ created: _, ...q }) => q);
	return json(200, { items: page, next_cursor: end < items.length ? String(end) : null });
}

/**
 * How a source's seed leads read in the provenance layer: the lists by name, license and use for
 * staff, a count for curators. Either way they are review leads, never evidence.
 */
function leadText(leads: SeedLead[], staff: boolean): string | undefined {
	const lists = [...new Map(leads.map((l) => [l.entry.id, l.entry])).values()];
	if (lists.length === 0) return undefined;
	if (!staff) return `on ${lists.length === 1 ? '1 seed list' : `${lists.length} seed lists`}, a review lead that is not evidence`;
	return `listed on ${lists.map((e) => `${e.name} (${e.license}${e.use === 'seed' ? ', calibrated' : ''})`).join(' and ')}, a review lead that is not evidence`;
}

/** Explains each evidence layer in one plain sentence for the review console. */
function layers(ev: Evaluation, leads: SeedLead[], staff: boolean): Layers {
	const { result: r, input: inp } = ev;
	const src = ev.data.source;
	const prov: string[] = [];
	const labels = r.mixed ? inp.labelInstalls : inp.rollupLabelInstalls;
	if (labels > 0) prov.push(`${labels} installs saw a platform AI label`);
	if (r.mixed && inp.rollupLabelInstalls > inp.labelInstalls) prov.push('labels on its items do not count, because the source is mixed');
	if (r.provenance.met && r.provenance.signals === 0) prov.push('taggers agree it is AI-made');
	const lead = leadText(leads, staff);
	if (lead) prov.push(lead);
	const beh: string[] = [];
	if (inp.uploadsPerDay >= 0) beh.push(`about ${goFixed(inp.uploadsPerDay, 1)} uploads a day over the last 14 days`);
	if (inp.itemsSeen > 0) beh.push(`${inp.aiItems} of ${inp.itemsSeen} items with evidence carry AI evidence`);
	if (r.mixed) beh.push('mixed source, so items are judged one by one');
	const sums = r.sums;
	let cons = `weighted tags: slop ${goFixed(sums.s, 1)}, AI-made but fine ${goFixed(sums.a, 1)}, not slop ${goFixed(sums.n, 1)} from ${sums.installs} installs`;
	if (inp.frozen) cons += '; frozen after a burst of tags from new installs';
	let rub = 'needs slop tags with at least two tests chosen by half the weight';
	const tests = testNames(r.tests);
	if (tests.length > 0 && sums.s >= 1) rub = 'tests chosen: ' + tests.join(', ').replaceAll('_', ' ');
	const sentence = (parts: string[], none: string): string => {
		if (parts.length === 0) return none;
		const s = parts.join('; ');
		return s[0]!.toUpperCase() + s.slice(1) + '.';
	};
	const layer = (met: boolean, signals: number, detail: string): Layer => ({ met, signals: signalNames(signals), detail });
	return {
		provenance: layer(r.provenance.met, r.provenance.signals, sentence(prov, 'No AI evidence yet.')),
		behavior: layer(r.behavior.met, r.behavior.signals, sentence(beh, 'No sign of mass production yet.')),
		rubric: layer(r.rubric.met, r.rubric.signals, sentence([rub], '')),
		consensus: layer(r.consensus.met, r.consensus.signals, sentence([cons], ''))
	};
}

function toReportDetail(rp: Report, active: number): ReportDetail {
	return {
		...toReport(rp, active),
		reason: rp.reason,
		examples: rp.examples as string[],
		slop_type: optString<SlopType>(rp.slopType),
		tests: testNames(rp.tests)
	};
}

function toItems(ev: Evaluation): ItemSummary[] {
	return ev.items.map((it) => {
		const tags = { slop: 0, ai_fine: 0, not_slop: 0 };
		for (const v of it.input.votes) if (Object.hasOwn(tags, v.verdict)) tags[v.verdict as keyof typeof tags]++;
		return {
			platform: it.item.platform as Platform,
			id: it.item.itemId,
			verdict: optString<Verdict>(it.item.state.verdict),
			signals: signalNames(it.item.state.signals),
			tags,
			platform_label_reports: it.input.labelInstalls
		};
	});
}

/** A seed lead with its full provenance, for staff only. */
function toProvenance(l: SeedLead): SeedProvenance {
	return {
		seed: l.entry.id,
		name: l.entry.name,
		license: l.entry.license,
		use: l.entry.use,
		platform: l.platform as Platform,
		alias: l.alias,
		batch: l.batch,
		imported_at: rfc3339(l.importedAt),
		listed_at: rfc3339(l.listedAt),
		expires_at: rfc3339(l.expiresAt),
		note: l.note
	};
}

/** Whether this request acts with staff authority: only staff and admins on the admin host do. */
const staffAuthority = (r: Reviewer): boolean => rank(r.authority) >= rank('staff');

/**
 * The review console's view of a source: what the public sees, layers, reports, appeals and
 * items, and its seed leads. Every reviewer sees whether seed lists name it and how many; only
 * staff authority, which exists on the admin host alone, sees which lists, with their license,
 * the batch and the line (contracts 6.7), and each such read is recorded (seed list review 30).
 */
function writeReviewSource(api: Api, ref: number, r: Reviewer): Response {
	const { db } = api.store;
	const ev = explain(api, ref);
	const src = ev.data.source;
	const staff = staffAuthority(r);
	const now = unix(api.store.now());
	const leads = seedLeads(db, api.store.engine.seeds, ref, now);
	if (staff && leads.length > 0) recordProvenanceRead(db, r.account.id, src.platform, src.canonicalId, [...new Set(leads.map((l) => l.entry.id))], now);
	const reports = reportsBySource(db, ref);
	const appeals = appealsBySource(db, ref);
	const history = log(db, { sourceRef: ref, limit: 100 });
	const active = activeInstalls(api.store);
	const lists = new Set(leads.map((l) => l.entry.id)).size;
	return json(200, {
		source: {
			...toSource(ev),
			imported: lists > 0,
			attribution: staff && lists > 0 ? leads.map((l) => `${l.entry.name} (${l.entry.license}), ${l.entry.use}`).filter((x, i, all) => all.indexOf(x) === i).join('; ') : null
		},
		seed_lists: lists,
		...(staff
			? {
					seeds: leads.map(toProvenance),
					seed_suppression: src.seedSuppressedAt ? { at: rfc3339(src.seedSuppressedAt), reason: src.seedSuppressReason } : null
				}
			: {}),
		layers: layers(ev, leads, staff),
		reports: reports.map((rp) => toReportDetail(rp, active)),
		appeals: appeals.map(toAppeal),
		items: toItems(ev),
		history: history.map(toLog)
	});
}

/** GET /v1/review/sources/{platform}/{source_id} */
export function reviewSource(api: Api, request: Request, _url: URL, params: Params): Response {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const ref = lookupSource(api, params);
	if (ref instanceof Response) return ref;
	return writeReviewSource(api, ref, a);
}

/**
 * POST /v1/review/sources/{platform}/{source_id}/suppress-seeds {"reason", "lift"?}: staff authority only.
 * Suppresses seed lists on a source (a GDPR Article 21 objection, or a case staff closed): its
 * entries and calibration item go and no import lists it again. "lift": true lifts it.
 */
export async function reviewSuppressSeeds(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	if (!staffAuthority(a)) return staffRequired('Seed list suppressions');
	const body = await decode(request, 4 << 10, { reason: 'string', lift: 'bool?' } as const);
	if (body instanceof Response) return body;
	const reason = trimSpace(body.reason);
	if (runeCount(reason) < 1 || runeCount(reason) > 500) return jsonError(400, 'invalid_reason', 'The reason must be 1 to 500 characters. Only staff see it.');
	const ref = lookupSource(api, params);
	if (ref instanceof Response) return ref;
	const { store } = api;
	const now = store.now();
	setSeedSuppression(store.db, ref, body.lift !== true, reason, unix(now));
	store.jobs.touch([ref], now);
	return writeReviewSource(api, ref, a);
}

/** The calibration item on the wire: only what the labeler needs to find it, nothing about its verdict, tags or lists. */
const toTask = (t: CalibrationTask | undefined) => ({ item: t ? { platform: t.platform as Platform, source_id: t.canonicalId, labels: t.labels } : null });

/**
 * GET /v1/review/calibration/next: the next source this reviewer has not labeled, blind (seed
 * design section 8). Staff authority (the admin host) also gets items whose two labels disagree,
 * for a third.
 */
export function reviewCalibrationNext(api: Api, request: Request): Response {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	return json(200, toTask(nextCalibration(api.store.db, a.account.id, staffAuthority(a))));
}

const labelSchema = { label: 'string', tests: 'strings', evidence: 'strings', note: 'string?', language: 'string?', kind: 'string?' } as const;

/**
 * POST /v1/review/calibration/{platform}/{source_id}/label {"label", "tests", "evidence", "note",
 * "language", "kind"}: records this reviewer's blind label and answers the next item.
 */
export async function reviewCalibrationLabel(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 4 << 10, labelSchema);
	if (body instanceof Response) return body;
	if (!(LABELS as readonly string[]).includes(body.label)) return jsonError(400, 'invalid_label', `label must be one of ${LABELS.join(', ')}.`);
	const tests = testBits(body.tests);
	if (tests === undefined) return jsonError(400, 'invalid_tests', 'tests may hold low_effort, mass_produced and hollow.');
	if (tests !== 0 && body.label !== 'slop') return jsonError(400, 'invalid_tests', 'Tests go with the label slop only.');
	const evidence = signalMask(body.evidence ?? []);
	if (evidence instanceof Error || (evidence & ~ProvenanceSignals) !== 0) {
		return jsonError(400, 'invalid_evidence', 'evidence may hold platform_label, content_credentials, creator_statement and watermark.');
	}
	const note = trimSpace(body.note ?? '');
	if (runeCount(note) > 500) return jsonError(400, 'invalid_note', 'The note must be at most 500 characters.');
	// The report groups every judged source by language and by music or video (seed list review 16).
	const judged = body.label !== 'gone' && body.label !== 'unsure';
	const language = judged ? (body.language ?? '') : '';
	const kind = judged ? (body.kind ?? '') : '';
	if (judged && !(CALIBRATION_LANGUAGES as readonly string[]).includes(language)) {
		return jsonError(400, 'invalid_language', `language must be one of ${CALIBRATION_LANGUAGES.join(', ')}.`);
	}
	if (judged && !(CALIBRATION_KINDS as readonly string[]).includes(kind)) return jsonError(400, 'invalid_kind', 'kind must be music or video.');
	const platform = pathValue(params, 'platform');
	const id = canonicalSource(platform, pathValue(params, 'source_id'));
	const { db } = api.store;
	const ref = validPlatform(platform) && id !== undefined ? findSource(db, platform, id) : undefined;
	if (ref === undefined) return jsonError(404, 'not_in_calibration', 'This source is not in the calibration set.');
	try {
		addLabel(db, ref, a.account.id, staffAuthority(a), { label: body.label as Label, tests, evidence, note, language, kind }, unix(api.store.now()));
	} catch (err) {
		if (err instanceof NotFoundError) return jsonError(404, 'not_in_calibration', 'This source is not in the calibration set.');
		if (err instanceof ConflictError) return jsonError(409, 'already_labeled', 'You labeled this source already, or it has all the labels it needs.');
		throw err;
	}
	return json(200, toTask(nextCalibration(db, a.account.id, staffAuthority(a))));
}

const decisionSchema = {
	verdict: 'string',
	reason: 'string',
	signals: 'strings',
	slop_type: 'string?',
	tests: 'strings',
	large: 'bool?',
	source_id: 'string'
} as const;

type DecisionBody = { verdict: string; reason: string; signals?: string[]; slop_type?: string; tests?: string[]; large?: boolean };

/**
 * Answers 400 source_named when text for the public decision log names a seed list, which it never
 * may: any list Colander imported, and any dataset in the registry, by name or ID.
 */
function namesSeedList(api: Api, text: string): Response | undefined {
	const name = namedSeedList(api.store.db, text) ?? namedDataset(api.store.engine.seeds, text);
	if (name === undefined) return undefined;
	return jsonError(400, 'source_named', `The text names the seed list ${name}. The decision log is public and never names a data source.`);
}

/**
 * Validates a decision body. Only provenance and behavior signals are recorded; the other signals
 * are computed and never set by hand.
 */
function decisionInput(api: Api, b: DecisionBody, r: Reviewer): Omit<DecisionInput, 'sourceRef'> | Response {
	const a = r.account;
	const reason = trimSpace(b.reason);
	if (b.verdict !== 'none' && verdictCode(b.verdict) === 0) {
		return jsonError(400, 'invalid_verdict', 'verdict must be one of the five verdicts or none.');
	}
	const n = runeCount(reason);
	if (n < 1 || n > 500) {
		return jsonError(400, 'invalid_reason', 'The reason must be 1 to 500 characters. It is published in the decision log.');
	}
	const named = namesSeedList(api, reason);
	if (named) return named;
	const signals = signalMask(b.signals ?? []);
	if (signals instanceof Error) return jsonError(400, 'invalid_signals', signals.message);
	let slopType = '';
	if (b.slop_type) {
		if (slopTypeCode(b.slop_type) === 0) return jsonError(400, 'invalid_slop_type', 'slop_type must be filler, bait or deceptive.');
		slopType = b.slop_type;
	}
	const tests = testBits(b.tests);
	if (tests === undefined) return jsonError(400, 'invalid_tests', 'tests may hold low_effort, mass_produced and hollow.');
	return {
		verdict: b.verdict,
		reason,
		signals: signals & (ProvenanceSignals | BehaviorSignals),
		slopType,
		tests,
		large: b.large,
		// Admins decide as staff in the public log.
		actor: r.authority === 'curator' ? 'curator' : 'staff',
		accountId: a.id,
		actorName: a.displayName
	};
}

/**
 * Applies a reviewer decision, answering 403 staff_required for the curator limits and 400
 * ai_evidence_required for Slop or Likely slop without AI evidence. Returns null when it applied.
 */
function decide(api: Api, input: DecisionInput): Response | null {
	try {
		engineDecide(api.store.engine, input);
		return null;
	} catch (err) {
		if (err instanceof StaffRequiredError) return staffRequired(err.what);
		if (err instanceof AIEvidenceRequiredError) {
			return jsonError(
				400,
				'ai_evidence_required',
				'Slop and Likely slop need AI evidence. Record a provenance signal: platform_label, content_credentials, creator_statement or watermark.'
			);
		}
		throw err;
	}
}

/** POST /v1/review/sources/{platform}/{source_id}/decision */
export async function reviewSourceDecision(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 16 << 10, decisionSchema);
	if (body instanceof Response) return body;
	const input = decisionInput(api, body, a);
	if (input instanceof Response) return input;
	const platform = pathValue(params, 'platform');
	const id = canonicalSource(platform, pathValue(params, 'source_id'));
	if (!validPlatform(platform) || id === undefined) {
		return jsonError(400, 'invalid_source', 'That is not a canonical source ID for this platform.');
	}
	const { store } = api;
	const ref = ensureSource(store.db, platform, id, '', unix(store.now()));
	return decide(api, { ...input, sourceRef: ref }) ?? writeReviewSource(api, ref, a);
}

/** POST /v1/review/items/{platform}/{item_id}/decision: the decision body plus source_id. */
export async function reviewItemDecision(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 16 << 10, decisionSchema);
	if (body instanceof Response) return body;
	const input = decisionInput(api, body, a);
	if (input instanceof Response) return input;
	if (body.large !== undefined) return jsonError(400, 'invalid_large', 'large applies to sources, not items.');
	const platform = pathValue(params, 'platform');
	const itemId = canonicalItem(platform, pathValue(params, 'item_id'));
	if (!validPlatform(platform) || itemId === undefined) {
		return jsonError(400, 'invalid_target', 'That is not a canonical item ID for this platform.');
	}
	const { db } = api.store;
	const now = unix(api.store.now());
	let item = findItem(db, platform, itemId);
	if (!item) {
		const sourceId = canonicalSource(platform, body.source_id);
		if (sourceId === undefined) return jsonError(400, 'missing_source', 'source_id is required for an item Colander has not seen.');
		ensureItem(db, platform, itemId, ensureSource(db, platform, sourceId, '', now), now);
		item = findItem(db, platform, itemId)!;
	}
	return decide(api, { ...input, sourceRef: item.sourceRef, itemRef: item.ref }) ?? writeReviewSource(api, item.sourceRef, a);
}

/** POST /v1/review/reports/{id}/dismiss {"reason"}: closes a report with no verdict change. */
export async function reviewDismissReport(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const a = reviewer(api, request);
	if (a instanceof Response) return a;
	const body = await decode(request, 4 << 10, { reason: 'string' } as const);
	if (body instanceof Response) return body;
	const reason = trimSpace(body.reason);
	const n = runeCount(reason);
	if (n < 1 || n > 500) return jsonError(400, 'invalid_reason', 'The reason must be 1 to 500 characters.');
	const { db, jobs } = api.store;
	const id = pathValue(params, 'id');
	const now = api.store.now();
	try {
		db.tx(() => {
			dismissReport(db, id, reason, unix(now));
			jobs.touch([getReport(db, id)!.sourceRef], now);
		});
	} catch (err) {
		if (err instanceof NotFoundError) return jsonError(404, 'not_found', 'No report has this ID.');
		if (err instanceof ConflictError) return jsonError(409, 'report_closed', 'This report is already closed.');
		throw err;
	}
	return json(200, { report: toReportDetail(getReport(db, id)!, 0) });
}

/** Loads the appeal for a staff-only appeal route, or answers the error. */
function staffAppeal(api: Api, request: Request, params: Params): [Account, Appeal] | Response {
	const r = reviewer(api, request);
	if (r instanceof Response) return r;
	if (rank(r.authority) < rank('staff')) return staffRequired('Appeals');
	const ap = getAppeal(api.store.db, pathValue(params, 'id'));
	if (!ap) return jsonError(404, 'not_found', 'No appeal has this ID.');
	return [r.account, ap];
}

/** Runs an appeal action and answers with the appeal, or 409 when its state does not allow it. */
function appealAction(api: Api, id: string, action: () => void): Response {
	try {
		action();
	} catch (err) {
		if (err instanceof ConflictError) return jsonError(409, 'appeal_state', 'The appeal is not in a state that allows this.');
		throw err;
	}
	return json(200, { appeal: toAppeal(getAppeal(api.store.db, id)!) });
}

/** POST /v1/review/appeals/{id}/verify: staff confirm the code is on the account. */
export async function reviewVerifyAppeal(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const found = staffAppeal(api, request, params);
	if (found instanceof Response) return found;
	const [, ap] = found;
	// Go decoded a body only when it had a Content-Length above zero; it must be an empty object.
	if (Number(request.headers.get('Content-Length') ?? 0) > 0) {
		const body = await decode(request, 1 << 10, {} as const);
		if (body instanceof Response) return body;
	}
	return appealAction(api, ap.id, () => verifyAppeal(api.store.engine, ap));
}

/** POST /v1/review/appeals/{id}/resolve {"outcome": "upheld" | "denied", "reasoning"} */
export async function reviewResolveAppeal(api: Api, request: Request, _url: URL, params: Params): Promise<Response> {
	const found = staffAppeal(api, request, params);
	if (found instanceof Response) return found;
	const [a, ap] = found;
	const body = await decode(request, 8 << 10, { outcome: 'string', reasoning: 'string' } as const);
	if (body instanceof Response) return body;
	const reasoning = trimSpace(body.reasoning);
	if (body.outcome !== 'upheld' && body.outcome !== 'denied') return jsonError(400, 'invalid_outcome', 'outcome must be upheld or denied.');
	const n = runeCount(reasoning);
	if (n < 1 || n > 1000) {
		return jsonError(400, 'invalid_reasoning', 'The reasoning must be 1 to 1,000 characters. It is published in the decision log.');
	}
	const named = namesSeedList(api, reasoning);
	if (named) return named;
	return appealAction(api, ap.id, () => resolveAppeal(api.store.engine, ap, body.outcome, reasoning, a));
}
