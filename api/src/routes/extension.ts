// The routes the extension calls with its install ID (contracts 6.2, 6.3 and 6.8; Go's
// internal/api/extension.go): tags, reports and the Plus trial. Quotas are taken in the same
// transaction as the write they guard.
import { issuePlanToken } from '@colander/shared/signing';
import type { PlanTokenPayload, Report, ReportStatus } from '@colander/shared/api';
import type { Platform, Verdict } from '@colander/shared/verdicts';
import { utf8 } from '@colander/shared/bytes';
import { json, jsonError, tooMany } from '../http';
import { allow } from '../limits';
import { unix } from '../scoring/engine';
import { slopTypeCode } from '../scoring/rules';
import { ConflictError, newId } from '../store/db';
import { startTrial } from '../store/misc';
import { createReport, reportsByInstall, saveTags, type Report as StoredReport, type ReportInput, type TagInput } from '../store/tags';
import { hashInstall } from '../auth';
import { canonicalItem, canonicalSource, validPlatform } from './ids';
import { activeInstalls } from './list';
import { decode, optString, parseRFC3339, rfc3339, runeCount, testBits, trimSpace, type Decoded } from './respond';
import type { Api } from './server';

/** Reads "Authorization: Install <id>" and returns the hashed install ID, or the error response. */
function installHash(request: Request): string | Response {
	const auth = request.headers.get('Authorization') ?? '';
	if (!auth.startsWith('Install ')) return jsonError(401, 'install_required', 'Send the install ID as Authorization: Install <id>.');
	return hashInstall(trimSpace(auth.slice('Install '.length))) ?? jsonError(401, 'invalid_install', 'The install ID is not valid.');
}

const clientIDPattern = /^[A-Za-z0-9-]{1,64}$/;
const uuidPattern = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const tagSchema = {
	client_id: 'string',
	platform: 'string',
	target_type: 'string',
	target_id: 'string',
	source_id: 'string',
	verdict: 'string',
	slop_type: 'string?',
	tests: 'strings',
	platform_label: 'bool',
	created_at: 'string',
	ext_version: 'string'
} as const;

/**
 * The stored form of a tag, or a machine-readable rejection code. invalid_field marks a field the
 * contract forbids in that place (6.2). now is unix milliseconds.
 */
export function validateTag(t: Decoded<typeof tagSchema>, now: number): TagInput | string {
	const nowS = unix(now);
	const input: TagInput = {
		clientId: t.client_id,
		platform: t.platform,
		targetType: t.target_type,
		targetId: '',
		sourceId: '',
		verdict: t.verdict,
		slopType: '',
		tests: 0,
		platformLabel: t.platform_label,
		createdAt: nowS,
		extVersion: t.ext_version
	};
	if (!uuidPattern.test(t.client_id)) return 'invalid_field';
	if (!validPlatform(t.platform)) return 'invalid_platform';
	switch (t.target_type) {
		case 'source': {
			const id = canonicalSource(t.platform, t.target_id);
			if (id === undefined) return 'invalid_target';
			if (t.source_id !== '') return 'invalid_field';
			[input.targetId, input.sourceId] = [id, id];
			break;
		}
		case 'item': {
			const id = canonicalItem(t.platform, t.target_id);
			if (id === undefined) return 'invalid_target';
			input.targetId = id;
			// Without a source (the card did not show it) the item is scored on its own and rolls up nowhere.
			if (t.source_id !== '') {
				const source = canonicalSource(t.platform, t.source_id);
				if (source === undefined) return 'invalid_source';
				input.sourceId = source;
			}
			break;
		}
		default:
			return 'invalid_target';
	}
	switch (t.verdict) {
		case 'slop': {
			if (t.slop_type) {
				if (slopTypeCode(t.slop_type) === 0) return 'invalid_slop_type';
				input.slopType = t.slop_type;
			}
			const tests = testBits(t.tests);
			if (tests === undefined) return 'invalid_tests';
			input.tests = tests;
			break;
		}
		case 'ai_fine':
		case 'not_slop':
			// Type and tests only mean something on a slop tag.
			if (t.slop_type || (t.tests?.length ?? 0) > 0) return 'invalid_field';
			break;
		default:
			return 'invalid_verdict';
	}
	if (t.created_at !== '') {
		const at = parseRFC3339(t.created_at);
		if (at === undefined) return 'invalid_created_at';
		input.createdAt = Math.min(Math.floor(at), nowS);
	}
	if (utf8(t.ext_version).length > 32) return 'invalid_ext_version';
	return input;
}

/** POST /v1/tags (contract 6.2). */
export async function postTags(api: Api, request: Request): Promise<Response> {
	const install = installHash(request);
	if (install instanceof Response) return install;
	const body = await decode(request, 128 << 10, { tags: [tagSchema] } as const);
	if (body instanceof Response) return body;
	const tags = body.tags ?? [];
	if (tags.length < 1 || tags.length > 50) return jsonError(400, 'invalid_batch', 'Send between 1 and 50 tags at a time.');
	const { db } = api.store;
	const now = api.store.now();
	const resp = { accepted: [] as string[], rejected: [] as { client_id: string; error: string }[] };
	const valid: TagInput[] = [];
	for (const t of tags) {
		const v = validateTag(t, now);
		if (typeof v === 'string') {
			resp.rejected.push({ client_id: t.client_id, error: v });
			continue;
		}
		valid.push(v);
		resp.accepted.push(t.client_id);
	}
	// Tags wait for the next scoring pass, as in Go.
	const wait = db.tx(() => {
		const w = allow(db, now, install, tags.length, 'tags_minute', 'tags_day');
		if (w === 0 && valid.length > 0) saveTags(db, install, valid, unix(now));
		return w;
	});
	if (wait > 0) return tooMany(wait / 1000);
	return json(200, resp);
}

/** A stored report on the wire; a decided report shows its verdict and the installs it protects. */
export function toReport(rp: StoredReport, activeInstalls: number): Report {
	const out: Report = {
		id: rp.id,
		platform: rp.platform as Platform,
		source_id: rp.reportedId,
		source_name: optString(rp.sourceName),
		status: 'under_review',
		verdict: null,
		protects: 0,
		created_at: rfc3339(rp.createdAt),
		updated_at: rfc3339(rp.updatedAt)
	};
	if (rp.status === 'dismissed') out.status = 'dismissed';
	else if (rp.status === 'decided') [out.status, out.verdict, out.protects] = [rp.verdict as ReportStatus, optString<Verdict>(rp.verdict), activeInstalls];
	return out;
}

const reportSchema = {
	client_id: 'string',
	platform: 'string',
	source_id: 'string',
	source_name: 'string',
	examples: 'strings',
	reason: 'string',
	slop_type: 'string?',
	tests: 'strings',
	ext_version: 'string'
} as const;

/** POST /v1/reports (contract 6.3). */
export async function postReport(api: Api, request: Request): Promise<Response> {
	const install = installHash(request);
	if (install instanceof Response) return install;
	const body = await decode(request, 16 << 10, reportSchema);
	if (body instanceof Response) return body;
	const input: ReportInput = {
		installHash: install,
		clientId: body.client_id,
		platform: body.platform,
		sourceId: '',
		sourceName: trimSpace(body.source_name),
		examples: [],
		reason: trimSpace(body.reason),
		slopType: '',
		tests: 0,
		extVersion: body.ext_version
	};
	const bad = (code: string, message: string) => jsonError(400, code, message);
	const examples = body.examples ?? [];
	if (!clientIDPattern.test(body.client_id)) return bad('invalid_client_id', "client_id must be the client's UUID.");
	if (!validPlatform(body.platform)) return bad('invalid_platform', 'platform must be yt, tt, ig or fb.');
	const reasonLength = runeCount(input.reason);
	if (reasonLength < 1 || reasonLength > 500) return bad('invalid_reason', 'The reason must be 1 to 500 characters.');
	if (runeCount(input.sourceName) > 120) return bad('invalid_source_name', 'The source name must be at most 120 characters.');
	if (examples.length > 3) return bad('invalid_examples', 'Send at most three example items.');
	if (utf8(body.ext_version).length > 32) return bad('invalid_ext_version', 'ext_version is too long.');
	const sourceId = canonicalSource(body.platform, body.source_id);
	if (sourceId === undefined) return bad('invalid_source', 'source_id is not a canonical source ID for this platform.');
	input.sourceId = sourceId;
	for (const e of examples) {
		const id = canonicalItem(body.platform, e);
		if (id === undefined) return bad('invalid_examples', 'Each example must be a canonical item ID for this platform.');
		input.examples!.push(id);
	}
	if (body.slop_type) {
		if (slopTypeCode(body.slop_type) === 0) return bad('invalid_slop_type', 'slop_type must be filler, bait or deceptive.');
		input.slopType = body.slop_type;
	}
	const tests = testBits(body.tests);
	if (tests === undefined) return bad('invalid_tests', 'tests may hold low_effort, mass_produced and hollow.');
	input.tests = tests;

	const { db, jobs } = api.store;
	const now = api.store.now();
	const res = db.tx(() => {
		const wait = allow(db, now, install, 1, 'reports');
		if (wait > 0) return wait;
		const { report } = createReport(db, input, unix(now));
		jobs.touch([report.sourceRef], now);
		return report;
	});
	if (typeof res === 'number') return tooMany(res / 1000);
	return json(201, { report: toReport(res, 0) });
}

/** GET /v1/reports (contract 6.3): the install's reports, newest first. */
export function getReports(api: Api, request: Request): Response {
	const install = installHash(request);
	if (install instanceof Response) return install;
	const { db } = api.store;
	const list = reportsByInstall(db, install);
	const active = activeInstalls(db, api.store.now());
	return json(200, { reports: list.map((rp) => toReport(rp, active)) });
}

const TRIAL_LENGTH = 14 * 24 * 3600;

/** The ID prefix of every install trial token's sub; paid tokens carry an account ID. */
export const trialPrefix = 'trl';

/** POST /v1/trial (contract 6.8): a 14-day Plus trial token, once per install. */
export async function postTrial(api: Api, request: Request): Promise<Response> {
	const install = installHash(request);
	if (install instanceof Response) return install;
	const now = unix(api.store.now());
	const claims: PlanTokenPayload = { v: 1, sub: newId(trialPrefix), plan: 'plus', trial: true, iat: now, exp: now + TRIAL_LENGTH };
	try {
		startTrial(api.store.db, install, claims.sub, claims.iat, claims.exp);
	} catch (err) {
		if (err instanceof ConflictError) return jsonError(409, 'trial_used', 'This install has already used its free trial.');
		throw err;
	}
	return json(200, { token: await issuePlanToken(await api.key(), claims) });
}
