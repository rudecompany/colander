// The Worker's cron triggers (hosting plan sections 2 and 4, wrangler.jsonc `triggers`):
// - every 5 minutes, the watchdog: an RPC to the Store re-arms a lost alarm and returns its status,
//   and alerts go out once each through the ALERTS binding while they last;
// - hourly, the list request counts from the GraphQL Analytics API into list_requests, because
//   cache hits never run code (contracts 9.6).
import { primary, type WatchdogStatus } from './store/store';

/** The hourly trigger. Every other trigger is the watchdog. */
export const ANALYTICS_CRON = '7 * * * *';

/** Alerts come from the domain onboarded to Email Sending (docs/deploy.md step 4). */
const ALERT_FROM = 'watchdog@getcolander.com';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** When the watchdog alerts (hosting plan sections 1.2 and 3). */
export const THRESHOLDS = {
	/** three missed 5-minute passes */
	passAgeMs: 15 * MINUTE,
	/** every pass asks for a publication */
	publishAgeMs: 15 * MINUTE,
	/** R2 may lag a fresh sequence while the publish job writes it */
	r2LagS: 120,
	/** one missed 6-hourly dump */
	dumpAgeMs: 7 * HOUR,
	/** the dump blocks the Store and the platform caps that at 30 s */
	dumpMs: 10_000,
	/** the gzip of the dump sits in memory while it blocks, in an isolate of 128 MB */
	dumpSize: 32 << 20,
	/** ship the incremental scoring planner when a pass reads this many rows */
	rowsPerPass: 2_000_000,
	/** sign-in codes sent in one hour: above this someone is likely abusing the sign-in form */
	signInMailPerHour: 500
};

/** The analytics token is optional: without it the hourly pull is skipped. */
type CronEnv = Env & { CF_ANALYTICS_TOKEN?: string };

export async function scheduled(controller: ScheduledController, env: CronEnv): Promise<void> {
	if (controller.cron === ANALYTICS_CRON) await pullListRequests(env, controller.scheduledTime);
	else await watchdog(env, controller.scheduledTime);
}

export interface Alert {
	key: string;
	text: string;
}

const minutes = (ms: number) => `${Math.round(ms / MINUTE)} minutes`;

/** The alerts a status calls for. Ages count from when the watchdog first ran, until a job reports. */
export function alerts(s: WatchdogStatus): Alert[] {
	const out: Alert[] = [];
	const age = (at: number | undefined) => s.now - (at ?? s.since);
	if (s.alarmLost) {
		out.push({ key: 'alarm_lost', text: `The Store alarm was missing while a job was ${minutes(s.overdueMs)} overdue. The watchdog set it again.` });
	}
	if (s.jobs.includes('pass')) {
		if (age(s.pass?.at) > THRESHOLDS.passAgeMs) {
			out.push({ key: 'pass_stale', text: `No full scoring pass has finished for ${minutes(age(s.pass?.at))}.` });
		}
		if (age(s.publish?.at) > THRESHOLDS.publishAgeMs) {
			out.push({ key: 'publish_stale', text: `The list has not been published for ${minutes(age(s.publish?.at))}, although every pass asks for it.` });
		}
		if (s.pass && s.pass.rowsRead >= THRESHOLDS.rowsPerPass) {
			out.push({
				key: 'pass_rows',
				text: `The last scoring pass read ${s.pass.rowsRead} rows. Ship the incremental scoring planner (src/jobs.ts).`
			});
		}
	}
	const hour = Math.floor(s.now / HOUR);
	const mail = s.signInMail;
	const sent = mail ? Math.max(mail.hour === hour ? mail.count : 0, mail.hour === hour ? mail.previous : mail.hour === hour - 1 ? mail.count : 0) : 0;
	if (sent > THRESHOLDS.signInMailPerHour) {
		out.push({
			key: 'sign_in_mail',
			text: `Colander sent ${sent} sign-in codes in one hour, above the ${THRESHOLDS.signInMailPerHour} that normal use explains. Check the audit log and consider Turnstile (docs/deploy.md).`
		});
	}
	if (s.head.seq === 0 && s.r2 && s.r2.seq > 0) {
		out.push({
			key: 'store_empty',
			text: `The Store has no list while R2 holds sequence ${s.r2.seq}, so it publishes nothing rather than an empty list installs would take. Restore the newest dump (docs/deploy.md, Restore), or delete list/snapshot.bin from the lists bucket to start from an empty list on purpose.`
		});
	}
	if (s.head.seq > 0 && s.r2?.seq !== s.head.seq && s.now / 1000 - s.head.createdAt > THRESHOLDS.r2LagS) {
		out.push({
			key: 'r2_behind',
			text: `R2 holds list sequence ${s.r2?.seq ?? 'none'} while the Store's head is ${s.head.seq}. Snapshot misses serve an old list.`
		});
	}
	if (s.jobs.includes('dump')) {
		if (age(s.dump?.at) > THRESHOLDS.dumpAgeMs) {
			out.push({ key: 'dump_stale', text: `No backup dump has finished for ${minutes(age(s.dump?.at))}.` });
		}
		if (s.dump && s.dump.ms > THRESHOLDS.dumpMs) {
			out.push({
				key: 'dump_slow',
				text: `The last dump blocked the Store for ${(s.dump.ms / 1000).toFixed(1)} s. Switch to the per-table export before it reaches 20 s.`
			});
		}
		if (s.dump && s.dump.size > THRESHOLDS.dumpSize) {
			out.push({
				key: 'dump_large',
				text: `The last dump was ${(s.dump.size / 2 ** 20).toFixed(1)} MiB of gzip (${(s.dump.bytes / 2 ** 20).toFixed(0)} MiB of SQL), held in memory while it blocks the Store. Switch to the per-table export (src/backup.ts).`
			});
		}
	}
	return out;
}

/** Where the watchdog remembers mailing store_unreachable, in the lists bucket, since the Store keeps the other alerts. */
export const UNREACHABLE_KEY = 'watchdog/store_unreachable';

/**
 * Status and alerts, each alert mailed once while it lasts. A failed mail is retried next time. A
 * Store that does not answer is mailed at most once an hour, and the trigger still fails.
 */
async function watchdog(env: CronEnv, now: number): Promise<void> {
	const store = primary(env);
	let s: WatchdogStatus;
	try {
		s = await store.watchdog();
	} catch (err) {
		await storeUnreachable(env, now, err);
		throw err;
	}
	const active = alerts(s);
	const sec = (at: number | undefined) => (at === undefined ? null : Math.round((s.now - at) / 1000));
	console.log(
		JSON.stringify({
			message: 'watchdog',
			passAgeS: sec(s.pass?.at),
			publishAgeS: sec(s.publish?.at),
			r2HeadAgeS: s.r2 ? Math.round(s.now / 1000 - s.r2.created) : null,
			dumpAgeS: sec(s.dump?.at),
			dumpMs: s.dump?.ms ?? null,
			rowsPerPass: s.pass?.rowsRead ?? null,
			alerts: active.map((a) => a.key)
		})
	);
	const fresh = active.filter((a) => !s.alerted.includes(a.key));
	let mailed = active.filter((a) => s.alerted.includes(a.key)).map((a) => a.key);
	if (fresh.length > 0) {
		const host = new URL(env.PUBLIC_URL).host;
		try {
			await env.ALERTS.send({
				from: { name: 'Colander watchdog', email: ALERT_FROM },
				to: env.ALERT_ADDRESS,
				subject: `Colander on ${host}: ${fresh.map((a) => a.key).join(', ')}`,
				text: [...fresh.map((a) => a.text), '', `Still active: ${active.map((a) => a.key).join(', ')}.`].join('\n')
			});
			mailed = active.map((a) => a.key);
		} catch (err) {
			console.error(JSON.stringify({ message: 'alert mail failed', error: String(err) }));
		}
	}
	if (mailed.join() !== s.alerted.join()) await store.recordAlerts(mailed);
}

async function storeUnreachable(env: CronEnv, now: number, error: unknown): Promise<void> {
	try {
		const last = await env.LISTS.head(UNREACHABLE_KEY);
		if (last && now - Number(last.customMetadata?.at ?? 0) < HOUR) return;
		await env.ALERTS.send({
			from: { name: 'Colander watchdog', email: ALERT_FROM },
			to: env.ALERT_ADDRESS,
			subject: `Colander on ${new URL(env.PUBLIC_URL).host}: store_unreachable`,
			text: `The watchdog could not reach the Store, so no job status or other alert is known: ${String(error)}\nThis mail repeats each hour while it lasts.`
		});
		await env.LISTS.put(UNREACHABLE_KEY, '', { customMetadata: { at: String(now) } });
	} catch (err) {
		console.error(JSON.stringify({ message: 'store_unreachable alert failed', error: String(err) }));
	}
}

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

// Requests for /v1/list/* on this Worker's host per hour, cache hits included.
const LIST_REQUESTS = `query ListRequests($zoneTag: string!, $host: string!, $start: Time!, $end: Time!) {
	viewer {
		zones(filter: { zoneTag: $zoneTag }) {
			httpRequestsAdaptiveGroups(
				limit: 100
				filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host, clientRequestPath_like: "/v1/list/%", requestSource: "eyeball" }
			) {
				count
				dimensions { datetimeHour }
			}
		}
	}
}`;

interface ListRequestsResponse {
	data?: { viewer?: { zones?: { httpRequestsAdaptiveGroups: { count: number; dimensions: { datetimeHour: string } }[] }[] } };
	errors?: { message: string }[] | null;
}

/**
 * How many whole hours each pull sets. Hours already written are overwritten, so late-arriving
 * analytics data and a repeated trigger both settle correctly, and a few missed pulls heal. It
 * stays well under the smallest time range plans allow per query (maxDuration, one day on Free).
 */
export const PULL_HOURS = 6;

/** Sets the last PULL_HOURS whole hours of list requests from edge analytics. */
async function pullListRequests(env: CronEnv, scheduledTime: number): Promise<void> {
	if (!env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_ID) {
		console.log(JSON.stringify({ message: 'analytics pull skipped: CF_ANALYTICS_TOKEN or CF_ZONE_ID is not set' }));
		return;
	}
	const end = Math.floor(scheduledTime / HOUR) * HOUR;
	const start = end - PULL_HOURS * HOUR;
	const res = await fetch(GRAPHQL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: LIST_REQUESTS,
			variables: { zoneTag: env.CF_ZONE_ID, host: new URL(env.PUBLIC_URL).host, start: new Date(start).toISOString(), end: new Date(end).toISOString() }
		})
	});
	if (!res.ok) throw new Error(`analytics API answered ${res.status}`);
	const body = await res.json<ListRequestsResponse>();
	const zone = body.data?.viewer?.zones?.[0];
	if (body.errors?.length || !zone) throw new Error(`analytics API: ${body.errors?.map((e) => e.message).join('; ') ?? 'no zone in the answer'}`);
	const byHour = new Map(zone.httpRequestsAdaptiveGroups.map((g) => [Date.parse(g.dimensions.datetimeHour) / HOUR, g.count]));
	const counts: { hour: number; count: number }[] = [];
	for (let hour = start / HOUR; hour < end / HOUR; hour++) counts.push({ hour, count: byHour.get(hour) ?? 0 });
	await primary(env).setListRequests(counts);
	console.log(JSON.stringify({ message: 'analytics pull', hours: counts.length, requests: counts.reduce((n, c) => n + c.count, 0) }));
}
