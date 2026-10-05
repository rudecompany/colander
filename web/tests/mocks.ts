// Realistic API fixtures shaped by packages/shared/src/api.ts, and a page.route mock for /v1.
import type { Page, Request } from '@playwright/test';
import type {
	Account,
	Appeal,
	AuditEntry,
	LogEntry,
	Passkey,
	Person,
	QueueItem,
	ReviewSourceResponse,
	Source,
	SourceResponse,
	Stats
} from '@colander/shared/api';

const source = (s: Partial<Source> & Pick<Source, 'platform' | 'id' | 'name' | 'verdict'>): Source => ({
	aliases: [s.id],
	signals: [],
	slop_type: null,
	tests: [],
	large: false,
	audience_known: false,
	imported: false,
	attribution: null,
	appeal_open: false,
	updated_at: '2026-09-28T09:14:00Z',
	rescore_at: '2026-12-27T09:14:00Z',
	evidence: { taggers: 0, tags: { slop: 0, ai_fine: 0, not_slop: 0 }, items_seen: 0, ai_item_share: null, uploads_per_day: null },
	...s
});

export const SOURCES: Record<string, Source> = {
	'yt:UCq3x9Vb2m4LkT7pQe8sW1aZ': source({
		platform: 'yt',
		id: 'UCq3x9Vb2m4LkT7pQe8sW1aZ',
		aliases: ['UCq3x9Vb2m4LkT7pQe8sW1aZ', '@ancientfactsdaily'],
		name: 'Ancient Facts Daily',
		verdict: 'slop',
		signals: ['platform_label', 'high_volume', 'mostly_ai', 'templated', 'rubric_low_effort', 'rubric_hollow', 'community_consensus', 'staff_review'],
		slop_type: 'filler',
		tests: ['low_effort', 'mass_produced', 'hollow'],
		// Staff decided it, and recorded its audience size on the way.
		audience_known: true,
		evidence: { taggers: 41, tags: { slop: 35, ai_fine: 4, not_slop: 2 }, items_seen: 23, ai_item_share: 0.91, uploads_per_day: null }
	}),
	'tt:@historybites247': source({
		platform: 'tt',
		id: '@historybites247',
		name: 'History Bites 24/7',
		verdict: 'likely_slop',
		signals: ['platform_label', 'templated', 'near_duplicates', 'rubric_hollow'],
		slop_type: 'filler',
		tests: ['mass_produced', 'hollow'],
		evidence: { taggers: 9, tags: { slop: 6, ai_fine: 2, not_slop: 1 }, items_seen: 14, ai_item_share: 0.86, uploads_per_day: null }
	}),
	'ig:studiolumen': source({
		platform: 'ig',
		id: 'studiolumen',
		name: 'Studio Lumen',
		verdict: 'ai_made',
		signals: ['creator_statement', 'platform_label'],
		evidence: { taggers: 12, tags: { slop: 2, ai_fine: 9, not_slop: 1 }, items_seen: 8, ai_item_share: 0.75, uploads_per_day: null }
	}),
	'yt:@numisnotes': source({
		platform: 'yt',
		id: '@numisnotes',
		aliases: ['UC7nB2kVq0dLr9XyTt4mE5pQ', '@numisnotes'],
		name: 'Numis Notes',
		verdict: 'disputed',
		signals: ['platform_label', 'open_appeal'],
		appeal_open: true,
		evidence: { taggers: 17, tags: { slop: 8, ai_fine: 3, not_slop: 6 }, items_seen: 11, ai_item_share: 0.45, uploads_per_day: null }
	}),
	'yt:@everydaytrivia': source({
		platform: 'yt',
		id: '@everydaytrivia',
		name: 'Everyday Trivia',
		verdict: null
	}),
	'fb:104729388112': source({
		platform: 'fb',
		id: '104729388112',
		name: 'Coastal Science Club',
		verdict: 'clear',
		signals: ['not_slop_consensus'],
		evidence: { taggers: 22, tags: { slop: 1, ai_fine: 2, not_slop: 19 }, items_seen: 6, ai_item_share: 0, uploads_per_day: null }
	})
};

let n = 0;
const entry = (e: Partial<LogEntry> & Pick<LogEntry, 'platform' | 'source_id' | 'source_name' | 'from' | 'to' | 'reason' | 'actor' | 'at'>): LogEntry => ({
	id: `log_${(++n).toString(36).padStart(6, '0')}`,
	target_type: 'source',
	target_id: e.source_id,
	signals: [],
	actor_name: null,
	...e
});

export const LOG: LogEntry[] = [
	entry({ at: '2026-10-03T08:42:00Z', platform: 'yt', source_id: 'UCq3x9Vb2m4LkT7pQe8sW1aZ', source_name: 'Ancient Facts Daily', from: 'likely_slop', to: 'slop', reason: 'Staff review confirmed mass-produced narration over stock and generated footage, on one title template.', signals: ['mostly_ai', 'high_volume', 'staff_review'], actor: 'staff', actor_name: 'Sam' }),
	entry({ at: '2026-10-02T21:10:00Z', platform: 'yt', source_id: '@numisnotes', source_name: 'Numis Notes', from: 'likely_slop', to: 'disputed', reason: 'The creator verified the channel and opened an appeal. Shown to everyone while staff review.', signals: ['open_appeal'], actor: 'appeal' }),
	entry({ at: '2026-10-02T16:05:00Z', platform: 'tt', source_id: '@historybites247', source_name: 'History Bites 24/7', from: 'ai_made', to: 'likely_slop', reason: 'AI labels on most recent videos, one template across captions, and taggers found the videos hollow.', signals: ['platform_label', 'templated', 'rubric_hollow'], actor: 'community' }),
	entry({ at: '2026-10-01T13:30:00Z', platform: 'fb', source_id: '104729388112', source_name: 'Coastal Science Club', from: 'disputed', to: 'clear', reason: 'Appeal upheld. Original footage and on-camera presenters, with AI used only for captions.', signals: ['not_slop_consensus'], actor: 'appeal', actor_name: 'Ines' }),
	entry({ at: '2026-09-30T10:00:00Z', platform: 'ig', source_id: 'studiolumen', source_name: 'Studio Lumen', from: null, to: 'ai_made', reason: 'The creator states the work is made with AI, and the platform labels it. No sign of mass production.', signals: ['creator_statement', 'platform_label'], actor: 'community' }),
	entry({ at: '2026-09-29T18:22:00Z', platform: 'yt', source_id: 'UCq3x9Vb2m4LkT7pQe8sW1aZ', source_name: 'Ancient Facts Daily', target_type: 'item', target_id: 'kX3v9QwL2pA', from: null, to: 'slop', reason: 'Generated narration over generated images, with a link funnel in the description.', signals: ['platform_label', 'link_funnel'], actor: 'curator', actor_name: 'Priya' }),
	entry({ at: '2026-09-28T09:14:00Z', platform: 'yt', source_id: 'UCq3x9Vb2m4LkT7pQe8sW1aZ', source_name: 'Ancient Facts Daily', from: 'ai_made', to: 'likely_slop', reason: '91% of recent items carry AI evidence, above the 80% bar, and community tags agree.', signals: ['mostly_ai', 'community_consensus'], actor: 'community' }),
	entry({ at: '2026-09-27T07:45:00Z', platform: 'tt', source_id: '@quietcraftsclips', source_name: 'Quiet Crafts Clips', from: 'likely_slop', to: null, reason: 'Verdict expired after 90 days and re-scoring found no AI evidence.', signals: [], actor: 'community' })
];

export const LOG_PAGE_2: LogEntry[] = [
	entry({ at: '2026-09-25T15:00:00Z', platform: 'ig', source_id: 'dailyzenquotes.ai', source_name: 'Daily Zen Quotes', from: 'likely_slop', to: 'slop', reason: 'Near-identical image posts across 6 pages with the same captions. Confirmed by curator review.', signals: ['near_duplicates', 'cross_posting', 'community_consensus'], actor: 'curator', actor_name: 'Priya' }),
	entry({ at: '2026-09-24T11:12:00Z', platform: 'fb', source_id: 'rescuestorieswow', source_name: 'Rescue Stories Wow', from: 'likely_slop', to: 'slop', reason: 'Synthetic rescue videos presented as real, on one title template with a link funnel.', signals: ['platform_label', 'high_volume', 'link_funnel', 'staff_review'], actor: 'staff', actor_name: 'Sam' })
];

export const STATS: Stats = {
	sources: { slop: 12840, likely_slop: 3412, ai_made: 5208, disputed: 37, clear: 911 },
	items: 48310,
	decisions_7d: 1284,
	appeals: { open: 23, median_days: 4.5 },
	active_installs: 18240,
	list_sequence: 1791070723,
	list_updated_at: '2026-10-03T08:42:10Z'
};

/** When the mocked session signed in: now, so a reviewer's passkey sign-in counts as fresh. */
const NOW = new Date().toISOString();

export const ACCOUNT: Account = {
	id: 'acc_7f3k2m',
	email: 'maya@example.com',
	display_name: 'Maya',
	role: 'member',
	plan: null,
	created_at: '2026-09-12T10:00:00Z',
	session: { method: 'email', authenticated_at: NOW },
	passkey_count: 0,
	reviewer_token: null,
	requests: []
};

export const PLUS_ACCOUNT: Account = {
	...ACCOUNT,
	plan: { plan: 'plus', interval: 'year', status: 'active', current_period_end: '2027-09-12T10:00:00Z', cancel_at_period_end: false, refundable: true }
};

/** Reviewers on the main host, signed in with a passkey just now. */
const PASSKEY = { session: { method: 'passkey' as const, authenticated_at: NOW }, passkey_count: 1 };
export const STAFF: Account = { ...ACCOUNT, ...PASSKEY, id: 'acc_sam', email: 'sam@example.com', display_name: 'Sam', role: 'staff' };
export const CURATOR: Account = { ...ACCOUNT, ...PASSKEY, id: 'acc_priya', email: 'priya@example.com', display_name: 'Priya', role: 'curator' };

/** A new curator who signed in with a code and has no passkey yet. */
export const CURATOR_NEW: Account = { ...ACCOUNT, id: 'acc_lee', email: 'lee@example.com', display_name: null, role: 'curator' };

export const PASSKEYS: Passkey[] = [
	{ id: 'pk_laptop', name: 'Work laptop', created_at: '2026-09-12T10:05:00Z', last_used_at: '2026-10-03T08:00:00Z', synced: true },
	{ id: 'pk_key', name: 'Security key', created_at: '2026-09-20T18:30:00Z', last_used_at: null, synced: false }
];

/** WebAuthn options as the Worker sends them, for the web origin http://localhost (rpId localhost). */
export const REQUEST_OPTIONS = { challenge: 'dGVzdC1jaGFsbGVuZ2UtMDEyMzQ1Njc4OQ', rpId: 'localhost', allowCredentials: [], userVerification: 'required', timeout: 300000 };
export const CREATION_OPTIONS = {
	challenge: 'dGVzdC1jaGFsbGVuZ2UtYWJjZGVmZ2hpams',
	rp: { name: 'Colander', id: 'localhost' },
	user: { id: 'YWNjXzdmM2sybQ', name: 'maya@example.com', displayName: 'Maya' },
	pubKeyCredParams: [
		{ type: 'public-key', alg: -7 },
		{ type: 'public-key', alg: -8 },
		{ type: 'public-key', alg: -257 }
	],
	timeout: 300000,
	attestation: 'none',
	excludeCredentials: [],
	authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
};

export const ME = {
	account: { id: 'acc_rae', email: 'rae@example.com', display_name: 'Rae', role: 'admin', created_at: '2026-09-01T09:00:00Z', passkey_count: 0, access_pinned: true },
	authority: 'admin',
	permissions: ['review', 'review.staff', 'people.read', 'role.set', 'invite.issue', 'people.revoke', 'people.email', 'supporters.credit', 'audit.read']
};

export const PEOPLE: Person[] = [
	{ id: 'acc_rae', email: 'rae@example.com', display_name: 'Rae', role: 'admin', created_at: '2026-09-01T09:00:00Z', passkey_count: 0, access_pinned: true },
	{ id: 'acc_sam', email: 'sam@example.com', display_name: 'Sam', role: 'staff', created_at: '2026-09-02T09:00:00Z', passkey_count: 2, access_pinned: true },
	{ id: 'acc_priya', email: 'priya@example.com', display_name: 'Priya', role: 'curator', created_at: '2026-09-10T09:00:00Z', passkey_count: 1, access_pinned: false },
	{ id: 'acc_lee', email: 'lee@example.com', display_name: null, role: 'curator', created_at: '2026-10-02T09:00:00Z', passkey_count: 0, access_pinned: false }
];

export const AUDIT: AuditEntry[] = [
	{ id: 9, at: '2026-10-03T09:12:00Z', actor_id: 'acc_rae', actor_sub: 'a3t:9f1c', actor_email: 'rae@example.com', host: 'admin', action: 'invite_issued', target: 'acc_lee', before: null, after: 'curator', reason: null, request_id: '8c1e0a7b3d2f4e5a' },
	{ id: 8, at: '2026-10-03T09:10:00Z', actor_id: 'acc_rae', actor_sub: 'a3t:9f1c', actor_email: 'rae@example.com', host: 'admin', action: 'role_changed', target: 'acc_lee', before: 'member', after: 'curator', reason: null, request_id: '8c1e0a7b3d2f4e59' },
	{ id: 7, at: '2026-10-02T20:00:00Z', actor_id: null, actor_sub: 'github:slantview', actor_email: null, host: 'ops', action: 'ops:grant-role', target: null, before: null, after: null, reason: '.github/workflows/ops.yml', request_id: '1834567' },
	{ id: 6, at: '2026-10-02T18:44:00Z', actor_id: 'acc_priya', actor_sub: null, actor_email: null, host: 'main', action: 'signed_in', target: 'acc_priya', before: null, after: 'passkey', reason: null, request_id: null }
];

export const APPEAL: Appeal = {
	id: 'apl_4k9x2m',
	platform: 'yt',
	source_id: '@numisnotes',
	source_name: 'Numis Notes',
	code: 'colander-7KQ2M9XD',
	status: 'awaiting_verification',
	statement: 'I film and narrate every lecture myself. I use AI only to dub them into Spanish and Portuguese.',
	outcome: null,
	reasoning: null,
	created_at: '2026-10-02T20:58:00Z',
	verified_at: null,
	resolved_at: null
};

export const QUEUE: QueueItem[] = [
	{ id: 'q_01', kind: 'escalation', priority: 1, created_at: '2026-10-03T07:20:00Z', platform: 'yt', source_id: 'UCq3x9Vb2m4LkT7pQe8sW1aZ', source_name: 'Ancient Facts Daily', summary: 'All three layers met. Large audience, capped at Likely slop.', large: true, verdict: 'likely_slop', computed_verdict: 'slop', report_count: 4 },
	{ id: 'q_02', kind: 'appeal', priority: 1, created_at: '2026-10-02T21:10:00Z', platform: 'yt', source_id: '@numisnotes', source_name: 'Numis Notes', summary: 'Verified appeal: creator says AI is used only for dubbing.', large: false, verdict: 'disputed', computed_verdict: 'likely_slop', report_count: 0 },
	{ id: 'q_03', kind: 'report', priority: 2, created_at: '2026-10-02T16:40:00Z', platform: 'tt', source_id: '@historybites247', source_name: 'History Bites 24/7', summary: '3 reports: mass-produced history narration', large: false, verdict: 'likely_slop', computed_verdict: 'likely_slop', report_count: 3 },
	{ id: 'q_04', kind: 'report', priority: 3, created_at: '2026-10-01T09:05:00Z', platform: 'ig', source_id: 'dailyzenquotes.ai', source_name: 'Daily Zen Quotes', summary: '1 report: same quote images on several pages', large: false, verdict: 'ai_made', computed_verdict: 'ai_made', report_count: 1 }
];

export function reviewSource(key: string): ReviewSourceResponse {
	const base = SOURCES[key] ?? SOURCES['tt:@historybites247'];
	return {
		// Reviewers see seed provenance, which public pages never show (contracts 6.7).
		source:
			key === 'yt:UCq3x9Vb2m4LkT7pQe8sW1aZ'
				? { ...base, large: true, verdict: 'likely_slop' }
				: key === 'yt:@everydaytrivia'
					? { ...base, imported: true, attribution: 'Example seed list (CC0-1.0), warnlist' }
					: base,
		layers: {
			provenance: { met: true, signals: ['platform_label'], detail: '11 of 14 recent videos carry the platform AI label, reported by 6 installs.' },
			behavior: { met: true, signals: ['templated', 'near_duplicates'], detail: 'One caption template across 9 of the last 14 videos.' },
			rubric: { met: true, signals: ['rubric_hollow'], detail: 'Hollow selected by a weighted share of 0.72, mass-produced by 0.81.' },
			consensus: { met: false, signals: [], detail: '6 slop tags from 9 installs, a share of 0.67. Consensus needs 0.7.' }
		},
		reports: [
			{ id: 'rpt_9x2k', platform: 'tt', source_id: base.id, source_name: base.name, status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-02T16:40:00Z', updated_at: '2026-10-02T16:40:00Z', reason: 'Posts 12 AI history videos a day with the same voice and the same caption.', examples: ['7421983300112233445', '7421983300112233446'], slop_type: 'filler', tests: ['mass_produced', 'hollow'] },
			{ id: 'rpt_9x2m', platform: 'tt', source_id: base.id, source_name: base.name, status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', reason: 'Wrong dates in most videos, and every video ends with the same link.', examples: ['7421983300112233447'], slop_type: 'bait', tests: ['hollow'] }
		],
		appeals: key === 'yt:@numisnotes' ? [{ ...APPEAL, status: 'under_review', verified_at: '2026-10-02T21:10:00Z' }] : [],
		items: [
			{ platform: base.platform, id: '7421983300112233445', verdict: 'likely_slop', signals: ['platform_label'], tags: { slop: 4, ai_fine: 1, not_slop: 0 }, platform_label_reports: 3 },
			{ platform: base.platform, id: '7421983300112233447', verdict: null, signals: [], tags: { slop: 2, ai_fine: 0, not_slop: 1 }, platform_label_reports: 1 }
		],
		history: LOG.filter((e) => `${e.platform}:${e.source_id}` === key)
	};
}

export type Call = { method: string; path: string; search: URLSearchParams; body: any; headers: Record<string, string> };
export type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

const err = (status: number, code: string, message: string): Reply => ({ status, json: { error: { code, message } } });

function defaults(call: Call): Reply {
	const { method, path, search } = call;
	if (method === 'GET' && path === '/v1/account') return err(401, 'not_signed_in', 'Sign in to continue.');
	if (method === 'GET' && path === '/v1/account/passkeys') return { json: { passkeys: [], current: null } };
	// The email field's passkey autofill asks for a challenge once the person starts on a sign-in form.
	if (method === 'POST' && path === '/v1/auth/passkey/options') return { json: { options: REQUEST_OPTIONS } };
	if (method === 'GET' && path === '/v1/stats') return { json: STATS };
	if (method === 'GET' && path === '/v1/supporters')
		return { json: { supporters: [{ name: 'Daniel R.', since: '2026-03-02T00:00:00Z' }, { name: 'The Lindqvist family', since: '2026-04-18T00:00:00Z' }, { name: 'Ana', since: '2026-06-01T00:00:00Z' }, { name: 'Tomasz K.', since: '2026-08-21T00:00:00Z' }] } };
	if (method === 'GET' && path === '/v1/log') {
		const filter = (e: LogEntry) =>
			(!search.get('platform') || e.platform === search.get('platform')) && (!search.get('verdict') || e.to === search.get('verdict'));
		const cursor = search.get('cursor');
		const entries = (cursor ? LOG_PAGE_2 : LOG).filter(filter);
		return { json: { entries, next_cursor: cursor ? null : 'c_page2' } };
	}
	const src = path.match(/^\/v1\/sources\/([a-z]{2})\/(.+)$/);
	if (method === 'GET' && src) {
		const key = `${src[1]}:${decodeURIComponent(src[2])}`;
		const s = SOURCES[key];
		if (!s) return err(404, 'not_rated', 'Colander knows nothing about this source.');
		const res: SourceResponse = { source: s, history: LOG.filter((e) => `${e.platform}:${e.source_id}` === key) };
		return { json: res };
	}
	return err(404, 'not_found', 'Not found.');
}

/** Routes every /v1 request through `overrides` (keys like "POST /v1/appeals" or "GET /v1/review/sources/*"), then the defaults. */
export async function mockApi(page: Page, overrides: Record<string, Handler> = {}) {
	const calls: Call[] = [];
	const patterns = Object.entries(overrides).map(([key, h]) => {
		const [m, p] = key.split(' ');
		return { m, re: new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), h };
	});
	await page.route('**/v1/**', async (route) => {
		const req: Request = route.request();
		const url = new URL(req.url());
		let body: unknown = null;
		try {
			body = req.postDataJSON();
		} catch {
			body = req.postData();
		}
		const call: Call = { method: req.method(), path: url.pathname, search: url.searchParams, body, headers: req.headers() };
		calls.push(call);
		const hit = patterns.find((p) => p.m === call.method && p.re.test(call.path));
		const reply = hit ? (typeof hit.h === 'function' ? await hit.h(call) : hit.h) : defaults(call);
		await route.fulfill({
			status: reply.status ?? 200,
			contentType: 'application/json',
			headers: reply.headers,
			body: reply.json === undefined ? '' : JSON.stringify(reply.json)
		});
	});
	return calls;
}

export { err };

/** Every page, with the mocks it needs. Specs open History Bites 24/7 in the console after load. */
export const PAGES: [string, Record<string, Handler>?][] = [
	['/'],
	['/definition'],
	['/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ'],
	['/s/yt/@unknownchannel'],
	['/appeal/tt/@historybites247'],
	['/appeal/status/apl_4k9x2m?secret=s3cret', { 'GET /v1/appeals/*': { json: { appeal: APPEAL } } }],
	['/log'],
	['/plans'],
	['/plans/welcome', { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } }],
	['/support'],
	['/support/thanks'],
	['/supporters'],
	['/transparency'],
	['/account', { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } }, 'GET /v1/account/passkeys': { json: { passkeys: PASSKEYS, current: 'pk_laptop' } } }],
	['/account/invite#invite=inv_test', { 'GET /v1/account': { json: { account: CURATOR_NEW } } }],
	['/account/cancel#cancel-secret'],
	[
		'/console',
		{
			'GET /v1/account': { json: { account: STAFF } },
			'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
			'GET /v1/review/sources/*': { json: reviewSource('tt:@historybites247') }
		}
	],
	[
		'/admin',
		{
			'GET /v1/admin/me': { json: ME },
			'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
			'GET /v1/review/sources/*': { json: reviewSource('tt:@historybites247') }
		}
	],
	['/admin/people', { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/people': { json: { people: PEOPLE } } }],
	['/admin/audit', { 'GET /v1/admin/me': { json: ME }, 'GET /v1/admin/audit': { json: { entries: AUDIT, next_cursor: null } } }],
	['/privacy'],
	['/terms'],
	['/missing-page']
];
