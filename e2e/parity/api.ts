// The HTTP API part of the parity story: the same requests to the Go server and to the Worker,
// with their answers compared request by request. Install IDs, client IDs and the clock are the
// same on both sides, so most answers must match exactly; the values each side draws at random
// (account, report and appeal IDs, appeal codes and secrets, trial subjects, tokens) are replaced
// by placeholders first. Both read the client address from CF-Connecting-IP, which the harness
// sets: one address per person where per-IP quotas matter, a new one per request elsewhere, so
// the Worker's edge burst limiter never trips.
import { readFileSync } from 'node:fs';

export interface Side {
	name: 'go' | 'worker';
	origin: string;
	log: string;
}

export interface Reply {
	status: number;
	body: any;
	headers: Headers;
}

interface Spec {
	method?: string;
	body?: unknown;
	install?: string;
	auth?: string;
	cookie?: string;
	ip?: string;
}

type Check = (what: string, ok: boolean, detail?: unknown) => void;

let nextIp = 0;
const freshIp = () => `198.18.${(++nextIp >> 8) & 255}.${nextIp & 255}`;

async function send(side: Side, path: string, spec: Spec = {}): Promise<Reply> {
	const method = spec.method ?? (spec.body === undefined ? 'GET' : 'POST');
	const headers: Record<string, string> = { 'CF-Connecting-IP': spec.ip ?? freshIp() };
	if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
	if (spec.cookie) headers.Cookie = spec.cookie;
	if (spec.cookie && method !== 'GET') headers['X-Colander-CSRF'] = '1';
	if (spec.install) headers.Authorization = `Install ${spec.install}`;
	if (spec.auth) headers.Authorization = spec.auth;
	const res = await fetch(side.origin + path, {
		method,
		headers,
		body: spec.body === undefined ? undefined : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// not JSON
	}
	return { status: res.status, body, headers: res.headers };
}

/**
 * Replaces what each side draws at random with placeholders, so the rest can be compared exactly.
 * Object keys are sorted: Go writes the keys of its maps sorted, the Worker in contract order, and
 * JSON gives key order no meaning.
 */
export function normalize(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) return value.map((v) => normalize(v));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, normalize(v, k)]));
	}
	// Sequence numbers differ by design, and Go counts list requests in process where the Worker reads edge analytics.
	if (key === 'list_sequence' || key === 'active_installs') return '(differs by design)';
	if (typeof value !== 'string') return value;
	if (key === 'secret' || (key === 'token' && !value.includes('.'))) return '(secret)';
	const plan = /^([\w-]+)\.[\w-]{86}$/.exec(value);
	if (plan) {
		const claims = JSON.parse(Buffer.from(plan[1]!, 'base64url').toString()) as Record<string, unknown>;
		return { plan_token: { ...claims, sub: String(claims.sub).replace(/_[a-z2-9]{16}$/, '_(random)') } };
	}
	return value
		.replace(/(?<![a-z0-9])(acc|rpt|apl|trial)_[a-z2-9]{16}\b/g, '$1_(random)')
		.replace(/\bcolander-(?!DEMO)[A-Z0-9]{8}\b/g, 'colander-(random)')
		.replace(/([?&]secret=)[\w-]+/g, '$1(secret)');
}

/** The newest dev mail to `to` in a side's log after `mark`, polled for a few seconds. */
async function mailTo(side: Side, to: string, mark: number): Promise<string> {
	for (let i = 0; i < 50; i++) {
		const blocks = readFileSync(side.log).subarray(mark).toString().split('==== Colander dev mail (not sent) ====').slice(1);
		const mail = blocks.reverse().find((b) => b.includes(`\nTo: ${to}\n`));
		if (mail) return mail;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`no dev mail to ${to} in the ${side.name} log`);
}

/**
 * The API story at one frozen time. `settle` ends a batch the way each server catches up (the Go
 * server restarts, the Worker runs /__dev/settle); `compare` diffs the stored state and the lists.
 */
export async function apiStory(sides: [Side, Side], now: string, check: Check, settle: () => Promise<void>, compare: (step: string) => Promise<void>): Promise<void> {
	const workerSide = sides[1];

	/** One request to both sides; their status and normalized bodies must agree. */
	async function both(what: string, path: string | ((s: Side, i: number) => string), spec: Spec | ((s: Side, i: number) => Spec) = {}, compareBody = true): Promise<[Reply, Reply]> {
		const pair = (await Promise.all(sides.map((s, i) => send(s, typeof path === 'string' ? path : path(s, i), typeof spec === 'function' ? spec(s, i) : spec)))) as [Reply, Reply];
		const [g, w] = pair;
		const same = g.status === w.status && (!compareBody || JSON.stringify(normalize(g.body)) === JSON.stringify(normalize(w.body)));
		check(`${what}: both answer ${g.status}${compareBody ? ' with the same body' : ''}`, same, { go: { status: g.status, body: normalize(g.body) }, worker: { status: w.status, body: normalize(w.body) } });
		return pair;
	}

	const stats = await send(workerSide, '/v1/stats');
	if (stats.status === 404) throw new Error('The Worker does not serve the API routes of contract section 6 yet, so their parity cannot be checked.');

	const install = (n: number) => Buffer.alloc(16, n).toString('base64url');
	const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
	let client = 0;
	const tag = (fields: Record<string, unknown> = {}) => ({
		client_id: uuid(++client),
		platform: 'yt',
		target_type: 'source',
		target_id: '@paritysloppy',
		verdict: 'slop',
		slop_type: 'filler',
		tests: ['low_effort', 'mass_produced'],
		platform_label: true,
		created_at: now,
		ext_version: '1.0.0',
		...fields
	});

	// ---- Batch 1: tags, reports, trials and sync ----

	// A burst: 22 brand-new installs tag one source as slop within the hour.
	for (let i = 1; i <= 22; i++) await both(`burst tag ${i}`, '/v1/tags', { install: install(i), body: { tags: [tag()] } });

	// One request with every kind of tag the contract accepts and rejects.
	const edgeInstall = install(40);
	await both('tags accepted and rejected one by one', '/v1/tags', {
		install: edgeInstall,
		body: {
			tags: [
				tag({ target_id: '@ParityMixed', verdict: 'not_slop', slop_type: undefined, tests: [] }),
				tag({ target_type: 'item', target_id: 'dQw4w9WgXcQ', source_id: '@paritysloppy', verdict: 'ai_fine', slop_type: undefined, tests: [] }),
				tag({ target_type: 'item', target_id: 'parityItem1', source_id: '@paritysloppy' }),
				tag({ platform: 'ig', target_type: 'item', target_id: 'CparityX0', verdict: 'slop', tests: ['hollow'] }),
				tag({ source_id: '@other' }),
				tag({ verdict: 'not_slop', slop_type: 'filler', tests: [] }),
				tag({ client_id: 'not-a-uuid' }),
				tag({ target_id: '@' }),
				tag({ platform: 'xx' }),
				tag({ verdict: 'maybe', slop_type: undefined, tests: [] }),
				tag({ tests: ['low_effort', 'nonsense'] }),
				tag({ target_id: 'https://www.youtube.com/@parityurl' })
			]
		}
	});
	await both('a tag replaying its client_id', '/v1/tags', { install: edgeInstall, body: { tags: [{ ...tag(), client_id: uuid(client - 11) }] } });
	await both('a later tag replaces the install’s earlier one', '/v1/tags', {
		install: edgeInstall,
		body: { tags: [tag({ target_id: '@ParityMixed', verdict: 'slop', created_at: now.replace(/:00Z$/, ':30Z') })] }
	});
	await both('an older tag does not replace a newer one', '/v1/tags', {
		install: edgeInstall,
		body: { tags: [tag({ target_id: '@ParityMixed', verdict: 'ai_fine', slop_type: undefined, tests: [], created_at: '2020-01-01T00:00:00Z' })] }
	});
	await both('an unknown field', '/v1/tags', { install: edgeInstall, body: { tags: [{ ...tag(), extra: 1 }] } });
	await both('no tags', '/v1/tags', { install: edgeInstall, body: { tags: [] } });
	await both('51 tags', '/v1/tags', { install: edgeInstall, body: { tags: Array.from({ length: 51 }, () => tag()) } });
	await both('a tag body that is not JSON', '/v1/tags', { install: edgeInstall, body: 'not json' });
	await both('tags without an install', '/v1/tags', { body: { tags: [tag()] } });
	await both('tags from a malformed install ID', '/v1/tags', { auth: 'Install short', body: { tags: [tag()] } });
	// 60 tags a minute per install: the 61st waits.
	const busy = install(41);
	await both('50 tags at once', '/v1/tags', { install: busy, body: { tags: Array.from({ length: 50 }, (_, i) => tag({ target_id: `@paritybusy${i}` })) } });
	await both('10 more tags', '/v1/tags', { install: busy, body: { tags: Array.from({ length: 10 }, (_, i) => tag({ target_id: `@paritybusy${50 + i}` })) } });
	const [g61, w61] = await both('the 61st tag in a minute', '/v1/tags', { install: busy, body: { tags: [tag({ target_id: '@paritybusy60' })] } });
	check('the 61st tag: the same Retry-After', g61.headers.get('retry-after') === w61.headers.get('retry-after'), { go: g61.headers.get('retry-after'), worker: w61.headers.get('retry-after') });

	// Reports: three on one source (an escalation), with examples, a replay, and invalid ones.
	const reportBody = (n: number, fields: Record<string, unknown> = {}) => ({
		client_id: uuid(1000 + n),
		platform: 'yt',
		source_id: '@paritysloppy',
		source_name: 'Parity Sloppy',
		examples: ['dQw4w9WgXcQ'],
		reason: `Report ${n}: the same generated narration on every upload.`,
		slop_type: 'filler',
		tests: ['mass_produced'],
		ext_version: '1.0.0',
		...fields
	});
	for (let i = 1; i <= 3; i++) await both(`report ${i}`, '/v1/reports', { install: install(i), body: reportBody(i) });
	await both('a report replaying its client_id', '/v1/reports', { install: install(1), body: reportBody(1) });
	await both('a report on a new source with a long name', '/v1/reports', { install: install(4), body: reportBody(4, { source_id: '@ParityNewSource', source_name: 'N'.repeat(120), examples: [] }) });
	for (const [what, fields] of [
		['an empty reason', { reason: '' }],
		['a reason over 500 characters', { reason: 'r'.repeat(501) }],
		['four examples', { examples: ['a', 'b', 'c', 'd'] }],
		['a source name over 120 characters', { source_name: 'N'.repeat(121) }],
		['an unknown platform', { platform: 'xx' }],
		['an unknown field', { extra: true }]
	] as const) {
		await both(`a report with ${what}`, '/v1/reports', { install: install(5), body: reportBody(50, fields) });
	}
	// 20 reports a day per install: the 21st waits.
	for (let i = 0; i < 21; i++) {
		await both(`quota report ${i + 1}`, '/v1/reports', { install: install(6), body: reportBody(100 + i, { source_id: `@parityquota${i}`, source_name: '' }) }, i === 20);
	}
	await both("an install's reports", '/v1/reports', { install: install(1) });
	await both('reports of an install that has none', '/v1/reports', { install: install(99) });

	// The trial, once per install, and settings sync with its token.
	const [gTrial, wTrial] = await both('a trial', '/v1/trial', { install: install(7), method: 'POST' });
	await both('a second trial', '/v1/trial', { install: install(7), method: 'POST' });
	const plan = (i: number) => `Plan ${(i === 0 ? gTrial : wTrial).body.token}`;
	await both('sync before any write', '/v1/sync', (_, i) => ({ auth: plan(i) }));
	await both('the first sync write', '/v1/sync', (_, i) => ({ auth: plan(i), method: 'PUT', body: { version: 0, data: { theme: 'dark', list: [1, 2] } } }));
	await both('a stale sync write', '/v1/sync', (_, i) => ({ auth: plan(i), method: 'PUT', body: { version: 0, data: { theme: 'light' } } }));
	await both('sync after the write', '/v1/sync', (_, i) => ({ auth: plan(i) }));
	await both('sync without a plan', '/v1/sync');

	await settle();
	await compare('api: tags, reports, trials and sync');

	// ---- Batch 2: appeals and reviewers, on the sources batch 1 got rated ----

	// Appeals from one address: create, read, verify by code (no YouTube key: staff check by hand), and the per-IP quota.
	const creator = '203.0.113.50';
	const [gA, wA] = await both('an appeal', '/v1/appeals', {
		ip: creator,
		body: { platform: 'yt', source_id: '@lostcivsexplained', email: 'Creator@Example.test', statement: 'We script and voice every video ourselves.' }
	});
	const appeal = (i: number) => (i === 0 ? gA : wA).body as { appeal: { id: string }; secret: string };
	await both('the appeal read with its secret', (_, i) => `/v1/appeals/${appeal(i).appeal.id}?secret=${appeal(i).secret}`);
	await both('the appeal read with a wrong secret', (_, i) => `/v1/appeals/${appeal(i).appeal.id}?secret=wrong`);
	await both('the creator asks to verify', (_, i) => `/v1/appeals/${appeal(i).appeal.id}/verify`, (_, i) => ({ body: { secret: appeal(i).secret } }));
	for (const [n, body] of [
		[2, { platform: 'yt', source_id: '@aihistorydaily', email: 'two@example.test', statement: 'Second.' }],
		[3, { platform: 'tt', source_id: '@nobodyknows', email: 'three@example.test', statement: 'Unknown source.' }],
		[4, { platform: 'yt', source_id: '@lostcivsexplained', email: 'not an email', statement: 'Bad email.' }],
		[5, { platform: 'yt', source_id: '@gossipnarrated', email: 'five@example.test', statement: 's'.repeat(2001) }],
		[6, { platform: 'yt', source_id: '@gossipnarrated', email: 'six@example.test', statement: 'Six.' }],
		[7, { platform: 'yt', source_id: '@spacekidssongs', email: 'seven@example.test', statement: 'Over the quota.' }]
	] as const) {
		await both(`appeal ${n} from the same address`, '/v1/appeals', { ip: creator, body });
	}


	/** Signs in through the emailed link and returns the session cookie and a reviewer token per side. */
	async function signIn(email: string): Promise<{ cookie: string[]; bearer: string[] }> {
		const marks = sides.map((s) => readFileSync(s.log).length);
		await both(`sign-in link for ${email}`, '/v1/auth/email', { ip: '203.0.113.60', body: { email, next: '/console' } });
		const cookie: string[] = [];
		const bearer: string[] = [];
		for (const [i, s] of sides.entries()) {
			const link = /https?:\/\/\S+\/auth\/callback\?\S+/.exec(await mailTo(s, email, marks[i]!))![0];
			const token = new URL(link).searchParams.get('token');
			const res = await fetch(`${s.origin}/v1/auth/verify`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Colander-CSRF': '1', 'CF-Connecting-IP': freshIp() },
				body: JSON.stringify({ token })
			});
			check(`${s.name}: ${email} signs in`, res.status === 200, await res.text());
			cookie.push(res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '));
		}
		const [g, w] = await both(`reviewer token for ${email}`, '/v1/account/reviewer-token', (_, i) => ({ cookie: cookie[i], method: 'POST' }));
		bearer.push(`Bearer ${g.body.token}`, `Bearer ${w.body.token}`);
		return { cookie, bearer };
	}
	const staff = await signIn('rae@colander.test');
	const curator = await signIn('curator@colander.test');
	await both('the account of the staff session', '/v1/account', (_, i) => ({ cookie: staff.cookie[i] }));
	await both('the display name, set', '/v1/account', (_, i) => ({ cookie: curator.cookie[i], method: 'PATCH', body: { display_name: '  Cora  ' } }));

	const asStaff = (i: number) => ({ auth: staff.bearer[i] });
	const asCurator = (i: number) => ({ auth: curator.bearer[i] });
	await both('the review queue', '/v1/review/queue?kind=all', (_, i) => asStaff(i));
	for (const kind of ['reports', 'appeals', 'escalations']) await both(`the review queue of ${kind}`, `/v1/review/queue?kind=${kind}`, (_, i) => asStaff(i));
	await both('the review page of the reported source', '/v1/review/sources/yt/@paritysloppy', (_, i) => asStaff(i));
	await both('the review queue without a reviewer', '/v1/review/queue');

	const decision = (fields: Record<string, unknown>) => ({ verdict: 'slop', reason: 'Generated narration on every upload.', signals: [], slop_type: 'filler', tests: ['mass_produced'], ...fields });
	await both('a curator on a large source', '/v1/review/sources/yt/@gossipnarrated/decision', (_, i) => ({ ...asCurator(i), body: decision({}) }));
	await both('a curator on a source with an open appeal', '/v1/review/sources/yt/@lostcivsexplained/decision', (_, i) => ({ ...asCurator(i), body: decision({}) }));
	await both('slop without AI evidence', '/v1/review/sources/tt/@chefmarta/decision', (_, i) => ({ ...asCurator(i), body: decision({}) }));
	await both('a curator decision with a provenance signal', '/v1/review/sources/tt/@chefmarta/decision', (_, i) => ({ ...asCurator(i), body: decision({ verdict: 'likely_slop', signals: ['creator_statement'], tests: ['low_effort', 'hollow'] }) }));
	await both('an unknown verdict', '/v1/review/sources/tt/@chefmarta/decision', (_, i) => ({ ...asStaff(i), body: decision({ verdict: 'awful' }) }));

	// The appeal: staff confirm the code, the source shows Disputed, then the appeal is denied.
	const appealPath = (i: number, action: string) => `/v1/review/appeals/${appeal(i).appeal.id}/${action}`;
	await both('staff confirm the appeal code', (_, i) => appealPath(i, 'verify'), (_, i) => ({ ...asStaff(i), method: 'POST' }));
	await both('the source page while disputed', '/v1/sources/yt/@lostcivsexplained');
	await both('a curator resolving an appeal', (_, i) => appealPath(i, 'resolve'), (_, i) => ({ ...asCurator(i), body: { outcome: 'denied', reasoning: 'No.' } }));
	await both('an unknown outcome', (_, i) => appealPath(i, 'resolve'), (_, i) => ({ ...asStaff(i), body: { outcome: 'maybe', reasoning: 'Hm.' } }));
	await both('staff deny the appeal', (_, i) => appealPath(i, 'resolve'), (_, i) => ({ ...asStaff(i), body: { outcome: 'denied', reasoning: 'The narration is generated and the scripts are templated.' } }));
	await both('the appeal resolved twice', (_, i) => appealPath(i, 'resolve'), (_, i) => ({ ...asStaff(i), body: { outcome: 'upheld', reasoning: 'Again.' } }));

	await both('staff decide the source', '/v1/review/sources/yt/@paritysloppy/decision', (_, i) => ({ ...asStaff(i), body: decision({ signals: ['templated'], large: false }) }));
	await both('staff decide an item', '/v1/review/items/yt/parityItem1/decision', (_, i) => ({ ...asStaff(i), body: decision({ verdict: 'clear', reason: 'This one is filmed.', slop_type: '', tests: [], source_id: '@paritysloppy' }) }));
	await both('a decision on an unknown source', '/v1/review/sources/yt/@nobodyknows/decision', (_, i) => ({ ...asStaff(i), body: decision({ verdict: 'clear', slop_type: '', tests: [] }) }));
	await both('staff clear a source for nothing', '/v1/review/sources/ig/handmadepottery/decision', (_, i) => ({ ...asStaff(i), body: decision({ verdict: 'none', reason: 'Back to the community.', slop_type: '', tests: [] }) }));

	// Dismiss the open report on the new source (made in batch 1), then dismiss it again.
	const [gNew, wNew] = await both("the new source's reporter's reports", '/v1/reports', { install: install(4) });
	const ids = [gNew, wNew].map((r) => (r.body.reports as { id: string }[])[0]!.id);
	await both('staff dismiss a report', (_, i) => `/v1/review/reports/${ids[i]}/dismiss`, (_, i) => ({ ...asStaff(i), body: { reason: 'Not enough to go on.' } }));
	await both('a report dismissed twice', (_, i) => `/v1/review/reports/${ids[i]}/dismiss`, (_, i) => ({ ...asStaff(i), body: { reason: 'Again.' } }));

	// What the public and the extension read.
	for (const path of [
		'/v1/sources/yt/@paritysloppy',
		'/v1/sources/yt/@lostcivsexplained',
		'/v1/sources/yt/UCaaaaaaaaaaaaaaaaaaaaaa',
		'/v1/sources/tt/@chefmarta',
		'/v1/sources/yt/@nobodyknows',
		'/v1/log?limit=200',
		'/v1/log?limit=5&platform=yt&verdict=slop',
		'/v1/stats',
		'/v1/supporters',
		'/v1/config/adapters'
	]) {
		await both(`GET ${path}`, path);
	}
	await both("an install's reports after the review", '/v1/reports', { install: install(1) });

	await settle();
	await compare('api: appeals and review');
}
