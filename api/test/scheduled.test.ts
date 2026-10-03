// The cron triggers (src/scheduled.ts): the 5-minute watchdog with its deduplicated alerts, and the
// hourly list request count from the GraphQL Analytics API.
import { env } from 'cloudflare:workers';
import { createScheduledController, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { STATUS } from '../src/jobs';
import { alerts, ANALYTICS_CRON, PULL_HOURS, THRESHOLDS } from '../src/scheduled';
import { SNAPSHOT_KEY } from '../src/store/list';
import type { Store, WatchdogStatus } from '../src/store/store';

const stub = env.STORE.getByName('primary');
const T = 1_900_000_000_000;
const S = T / 1000;
const MINUTE = 60_000;
const WATCHDOG = '*/5 * * * *';

/** Runs fn in the primary Store with its clock at T. */
const inStore = <R>(fn: (store: Store, state: DurableObjectState) => R | Promise<R>) =>
	runInDurableObject(stub, (store: Store, state) => {
		store.now = () => T;
		return fn(store, state);
	});

/** An ALERTS binding that records what it sends, or fails. */
function mailbox(fail = false) {
	const sent: EmailMessageBuilder[] = [];
	const binding: SendEmail = {
		send: async (m: EmailMessage | EmailMessageBuilder) => {
			if (fail) throw new Error('E_DELIVERY_FAILED');
			sent.push(m as EmailMessageBuilder);
			return { messageId: `m${sent.length}` };
		}
	};
	return { sent, binding };
}

/** Runs a cron trigger through the Worker's scheduled handler, which awaits all its work. */
function cron(cron: string, overrides: Partial<Env> & { CF_ANALYTICS_TOKEN?: string } = {}, scheduledTime = T): Promise<void> {
	return worker.scheduled(createScheduledController({ cron, scheduledTime }), { ...env, ...overrides });
}

beforeEach(async () => {
	vi.restoreAllMocks();
	await inStore(async (store, state) => {
		store.db.run('DELETE FROM jobs; DELETE FROM list_sequences; DELETE FROM list_requests');
		for (const key of Object.values(STATUS)) state.storage.kv.delete(key);
		await state.storage.deleteAlarm();
	});
	await env.LISTS.delete(SNAPSHOT_KEY);
});

describe('watchdog', () => {
	it('creates the recurring jobs, arms the alarm and asks for the first publication', async () => {
		const mail = mailbox();
		const logs = vi.spyOn(console, 'log');
		await cron(WATCHDOG, { ALERTS: mail.binding });
		await inStore(async (store, state) => {
			expect(store.db.all('SELECT name, due_at FROM jobs ORDER BY name')).toEqual([
				{ name: 'pass', due_at: T },
				{ name: 'prune', due_at: T },
				{ name: 'publish', due_at: T }
			]);
			expect(await state.storage.getAlarm()).toBe(T);
		});
		expect(mail.sent).toEqual([]);
		const line = logs.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.message === 'watchdog');
		expect(line).toEqual({ message: 'watchdog', passAgeS: null, publishAgeS: null, r2HeadAgeS: null, dumpAgeS: null, dumpMs: null, rowsPerPass: null, alerts: [] });
	});

	it('returns the status the alerts come from', async () => {
		await env.LISTS.put(SNAPSHOT_KEY, new Uint8Array([1]), { customMetadata: { seq: String(S - 50), created: String(S - 50) } });
		await inStore((store) => store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', S - 50, S - 50));
		const status = await inStore((store) => store.watchdog());
		expect(status).toMatchObject({ now: T, jobs: ['pass', 'prune', 'publish', 'rescore'], alarmLost: false, head: { seq: S - 50, createdAt: S - 50 }, r2: { seq: S - 50, created: S - 50 }, alerted: [], since: T });
		// R2 holds the head, so no publication was asked for.
		expect(await inStore((store) => store.db.all('SELECT name FROM jobs ORDER BY name'))).toEqual([{ name: 'pass' }, { name: 'prune' }]);
	});

	it('mails an alert once while it lasts, and again when it comes back', async () => {
		const mail = mailbox();
		// The head is 1,000 s old and R2 has nothing: snapshot misses would serve no list.
		await inStore((store) => store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', S - 1000, S - 1000));
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]).toMatchObject({ to: 'ops-alerts@getcolander.com', from: { email: 'watchdog@getcolander.com' }, subject: 'Colander on getcolander.com: r2_behind' });
		expect(mail.sent[0]!.text).toContain(`R2 holds list sequence none while the Store's head is ${S - 1000}.`);
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(mail.sent).toHaveLength(1);
		expect(await inStore((_, state) => state.storage.kv.get(STATUS.alerts))).toEqual(['r2_behind']);

		await env.LISTS.put(SNAPSHOT_KEY, new Uint8Array([1]), { customMetadata: { seq: String(S - 1000), created: String(S - 1000) } });
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(await inStore((_, state) => state.storage.kv.get(STATUS.alerts))).toEqual([]);
		await env.LISTS.delete(SNAPSHOT_KEY);
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(mail.sent).toHaveLength(2);
	});

	it('tries a failed alert mail again at the next run', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		await inStore((store) => store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', S - 1000, S - 1000));
		await cron(WATCHDOG, { ALERTS: mailbox(true).binding });
		expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])).message)).toEqual(['alert mail failed']);
		expect(await inStore((_, state) => state.storage.kv.get(STATUS.alerts))).toBeUndefined();
		const mail = mailbox();
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(mail.sent.map((m) => m.subject)).toEqual(['Colander on getcolander.com: r2_behind']);
	});

	it('re-arms a lost alarm and says so', async () => {
		const mail = mailbox();
		await inStore((store) => {
			store.jobs.ensure(T - 2 * MINUTE);
			store.db.run('INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)', S, S);
		});
		await env.LISTS.put(SNAPSHOT_KEY, new Uint8Array([1]), { customMetadata: { seq: String(S), created: String(S) } });
		await cron(WATCHDOG, { ALERTS: mail.binding });
		expect(mail.sent.map((m) => m.subject)).toEqual(['Colander on getcolander.com: alarm_lost']);
		expect(mail.sent[0]!.text).toContain('The Store alarm was missing while a job was 2 minutes overdue.');
		expect(await inStore((_, state) => state.storage.getAlarm())).toBe(T - 2 * MINUTE);
	});
});

describe('alerts', () => {
	const base: WatchdogStatus = {
		now: T,
		jobs: ['prune', 'publish'],
		alarmLost: false,
		overdueMs: 0,
		pass: null,
		publish: null,
		head: { seq: S, createdAt: S },
		r2: { seq: S, created: S },
		dump: null,
		alerted: [],
		since: T - 60 * MINUTE
	};
	const keys = (s: Partial<WatchdogStatus>) => alerts({ ...base, ...s }).map((a) => a.key);

	it('alert on passes and publications only once a pass handler exists, counting from the first watchdog run', () => {
		expect(keys({})).toEqual([]);
		const pass = { at: T - 5 * MINUTE, ms: 900, sources: 26_000, changes: 3, rowsRead: 400_000 };
		expect(keys({ jobs: ['pass', 'prune', 'publish'], since: T - 10 * MINUTE })).toEqual([]);
		expect(keys({ jobs: ['pass', 'prune', 'publish'] })).toEqual(['pass_stale', 'publish_stale']);
		expect(keys({ jobs: ['pass', 'prune', 'publish'], pass, publish: { at: T - MINUTE, seq: S } })).toEqual([]);
		expect(keys({ jobs: ['pass', 'prune', 'publish'], pass: { ...pass, rowsRead: THRESHOLDS.rowsPerPass }, publish: { at: T, seq: S } })).toEqual(['pass_rows']);
	});

	it('alert on R2 only after the publish job had time to write it', () => {
		expect(keys({ r2: null, head: { seq: S - 60, createdAt: S - 60 } })).toEqual([]);
		expect(keys({ r2: null, head: { seq: S - 180, createdAt: S - 180 } })).toEqual(['r2_behind']);
		expect(keys({ r2: { seq: S - 200, created: S - 200 }, head: { seq: S - 180, createdAt: S - 180 } })).toEqual(['r2_behind']);
		expect(keys({ head: { seq: 0, createdAt: 0 }, r2: null })).toEqual([]);
	});

	it('alert on dumps only once the dump job exists', () => {
		expect(keys({ dump: { at: T - 8 * 60 * MINUTE, ms: 20_000 } })).toEqual([]);
		const jobs = ['dump', 'prune', 'publish'];
		expect(keys({ jobs, since: T - 8 * 60 * MINUTE })).toEqual(['dump_stale']);
		expect(keys({ jobs, dump: { at: T - 60 * MINUTE, ms: 12_000 } })).toEqual(['dump_slow']);
		expect(keys({ jobs, dump: { at: T - 60 * MINUTE, ms: 900 } })).toEqual([]);
		expect(keys({ alarmLost: true, overdueMs: 3 * MINUTE })).toEqual(['alarm_lost']);
	});
});

describe('analytics pull', () => {
	const hourly = Date.UTC(2030, 0, 1, 5, 7);
	const H = 3_600_000;
	const token = { CF_ANALYTICS_TOKEN: 'analytics-token', CF_ZONE_ID: 'zone123' };

	function graphql(body: unknown) {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			calls.push({ url: String(input), init: init! });
			return Response.json(body);
		});
		return calls;
	}

	const groups = (counts: [string, number][]) => ({
		data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: counts.map(([hour, count]) => ({ count, dimensions: { datetimeHour: hour } })) }] } },
		errors: null
	});

	const stored = () => inStore((store) => store.db.all<{ hour: number; count: number }>('SELECT hour, count FROM list_requests ORDER BY hour'));

	it('is skipped with a log line while the token or zone is not set', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		const logs = vi.spyOn(console, 'log');
		await cron(ANALYTICS_CRON, {}, hourly);
		await cron(ANALYTICS_CRON, { CF_ANALYTICS_TOKEN: 'analytics-token' }, hourly);
		expect(fetch).not.toHaveBeenCalled();
		expect(logs.mock.calls.map((c) => JSON.parse(String(c[0])).message)).toEqual([
			'analytics pull skipped: CF_ANALYTICS_TOKEN or CF_ZONE_ID is not set',
			'analytics pull skipped: CF_ANALYTICS_TOKEN or CF_ZONE_ID is not set'
		]);
		expect(await stored()).toEqual([]);
	});

	it('sets the last whole hours of list requests on this host, replacing earlier pulls', async () => {
		const calls = graphql(groups([['2030-01-01T03:00:00Z', 120], ['2030-01-01T04:00:00Z', 48]]));
		await cron(ANALYTICS_CRON, token, hourly);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
		expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer analytics-token');
		const req = JSON.parse(String(calls[0]!.init.body)) as { query: string; variables: unknown };
		expect(req.variables).toEqual({ zoneTag: 'zone123', host: 'getcolander.com', start: '2029-12-31T23:00:00.000Z', end: '2030-01-01T05:00:00.000Z' });
		expect(req.query).toContain('clientRequestPath_like: "/v1/list/%"');
		const end = Date.UTC(2030, 0, 1, 5) / H;
		let rows = await stored();
		expect(PULL_HOURS).toBe(6);
		expect(rows).toHaveLength(PULL_HOURS);
		expect([rows[0]!.hour, rows.at(-1)!.hour]).toEqual([end - PULL_HOURS, end - 1]);
		expect(rows.filter((r) => r.count > 0)).toEqual([
			{ hour: end - 2, count: 120 },
			{ hour: end - 1, count: 48 }
		]);

		vi.restoreAllMocks();
		graphql(groups([['2030-01-01T04:00:00Z', 50]]));
		await cron(ANALYTICS_CRON, token, hourly);
		rows = await stored();
		expect(rows.filter((r) => r.count > 0)).toEqual([{ hour: end - 1, count: 50 }]);
	});

	it('fails the trigger on an API error, writing nothing', async () => {
		graphql({ data: null, errors: [{ message: 'not authorized for that zone' }] });
		await expect(cron(ANALYTICS_CRON, token, hourly)).rejects.toThrow('analytics API: not authorized for that zone');
		expect(await stored()).toEqual([]);
	});
});
