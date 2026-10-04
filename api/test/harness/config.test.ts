// Guards on wrangler.jsonc for every deployed environment: settings that would lose data, leak
// request details or mix staging with production fail here before they reach a deploy.
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const read = (env?: string) => unstable_readConfig({ config: new URL('../../wrangler.jsonc', import.meta.url).pathname, env });
const production = read();
const staging = read('staging');

describe.each([
	['production', production],
	['staging', staging]
])('%s', (_, c) => {
	it('never deletes, renames or transfers the Store class', () => {
		for (const m of c.migrations) {
			expect(m.deleted_classes ?? []).toEqual([]);
			expect(m.renamed_classes ?? []).toEqual([]);
			expect(m.transferred_classes ?? []).toEqual([]);
		}
		expect(c.migrations.flatMap((m: { new_sqlite_classes?: string[] }) => m.new_sqlite_classes ?? [])).toContain('Store');
	});

	it('keeps invocation logs and traces off and dev routes closed', () => {
		expect(c.observability?.logs?.invocation_logs).toBe(false);
		expect(c.observability?.traces?.enabled).toBe(false);
		expect(c.vars.COLANDER_DEV).toBe('');
	});

	it('keeps YouTube figures out of scoring and the spend under the daily quota', () => {
		// Derived use needs YouTube's written approval first (Developer Policies III.E.4).
		expect(c.vars.YOUTUBE_DERIVED_USE).toBe('');
		expect(Number(c.vars.YOUTUBE_DAILY_UNITS)).toBeGreaterThan(0);
		expect(Number(c.vars.YOUTUBE_DAILY_UNITS)).toBeLessThanOrEqual(10_000);
	});

	it('mails watchdog alerts to the one address the ALERTS binding may send to', () => {
		const alerts = c.send_email.find((b: { name: string }) => b.name === 'ALERTS') as { destination_address?: string } | undefined;
		expect(alerts?.destination_address).toMatch(/@/);
		expect(c.vars.ALERT_ADDRESS).toBe(alerts?.destination_address);
	});

	it('serves only through its custom domain, with the edge cache on', () => {
		expect(c.workers_dev).toBe(false);
		expect(c.preview_urls).toBe(false);
		expect(c.routes).toEqual([expect.objectContaining({ custom_domain: true })]);
		expect(c.cache).toEqual({ enabled: true, cross_version_cache: true });
		expect(c.assets?.run_worker_first).toEqual(['/v1/*', '/ops/*', '/healthz', '/__dev/*']);
	});
});

it('gives staging its own Worker, domain, buckets and rate limit namespace', () => {
	expect(staging.name).not.toBe(production.name);
	expect(staging.routes).not.toEqual(production.routes);
	const buckets = (c: typeof production): string[] => c.r2_buckets.map((b: { bucket_name?: string }) => b.bucket_name ?? '');
	expect(buckets(staging).filter((b) => buckets(production).includes(b))).toEqual([]);
	expect(staging.ratelimits?.[0]?.namespace_id).not.toBe(production.ratelimits?.[0]?.namespace_id);
});
