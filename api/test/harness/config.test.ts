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

	it('serves only through its custom domains, the site and the admin host, with the edge cache on', () => {
		expect(c.workers_dev).toBe(false);
		expect(c.preview_urls).toBe(false);
		expect(c.routes).toEqual([expect.objectContaining({ custom_domain: true }), expect.objectContaining({ custom_domain: true })]);
		const hosts = (c.routes as { pattern: string }[]).map((r) => r.pattern);
		expect(`https://${hosts[0]}`).toBe(c.vars.PUBLIC_URL);
		expect(hosts[1]).toBe(c.vars.ADMIN_HOST);
		// A first-level subdomain, so Universal SSL covers it.
		expect(c.vars.ADMIN_HOST).toMatch(/^[a-z-]+\.getcolander\.com$/);
		expect(c.cache).toEqual({ enabled: true, cross_version_cache: true });
		expect(c.assets?.run_worker_first).toEqual(['/v1/*', '/ops/*', '/healthz', '/__dev/*', '/200', '/404', '/', '/admin', '/admin/*']);
	});

	it('takes ops calls only from GitHub Actions of this repository, and keeps no static ops token', () => {
		expect(c.vars.OPS_GITHUB_REPOSITORY).toBe('rudecompany/colander');
		expect(c.vars.OPS_GITHUB_REPOSITORY_ID).toMatch(/^\d+$/);
		expect(c.vars.OPS_GITHUB_ENVIRONMENT).toMatch(/^(production|staging)$/);
		expect(c.secrets?.required).toEqual(['COLANDER_SIGNING_KEY', 'IP_SALT']);
		expect(c.vars).not.toHaveProperty('OPS_TOKEN');
	});
});

it('keeps the YouTube spend of both environments, which share one project and its key, within its budget', () => {
	// The project gets 10,000 units a day; 2,000 stay as margin (contracts 9.7). Each environment
	// keeps its own ledger, so only their sum bounds what the project spends.
	expect(Number(production.vars.YOUTUBE_DAILY_UNITS) + Number(staging.vars.YOUTUBE_DAILY_UNITS)).toBeLessThanOrEqual(8_000);
});

it('gives each environment its own ops environment and admin host', () => {
	expect([production.vars.OPS_GITHUB_ENVIRONMENT, staging.vars.OPS_GITHUB_ENVIRONMENT]).toEqual(['production', 'staging']);
	expect([production.vars.ADMIN_HOST, staging.vars.ADMIN_HOST]).toEqual(['admin.getcolander.com', 'staging-admin.getcolander.com']);
});

it('gives staging its own Worker, domain, buckets and rate limit namespace', () => {
	expect(staging.name).not.toBe(production.name);
	expect(staging.routes).not.toEqual(production.routes);
	const buckets = (c: typeof production): string[] => c.r2_buckets.map((b: { bucket_name?: string }) => b.bucket_name ?? '');
	expect(buckets(staging).filter((b) => buckets(production).includes(b))).toEqual([]);
	expect(staging.ratelimits?.[0]?.namespace_id).not.toBe(production.ratelimits?.[0]?.namespace_id);
});
