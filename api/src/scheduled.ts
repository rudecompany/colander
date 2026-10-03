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
	/** ship the incremental scoring planner when a pass reads this many rows */
	rowsPerPass: 2_000_000
};

/** The analytics token is optional: without it the hourly pull is skipped. */
type CronEnv = Env & { CF_ANALYTICS_TOKEN?: string };

export async function scheduled(controller: ScheduledController, env: CronEnv): Promise<void> {
	if (controller.cron === ANALYTICS_CRON) await pullListRequests(env, controller.scheduledTime);
	else await watchdog(env);
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
	}
	return out;
}

/** Status and alerts, each alert mailed once while it lasts. A failed mail is retried next time. */
async function watchdog(env: CronEnv): Promise<void> {
	const store = primary(env);
	const s = await store.watchdog();
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
