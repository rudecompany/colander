/**
 * Where links to the public site point. On the admin host they leave it for the main host, since
 * the admin host serves only the admin console: admin.getcolander.com → getcolander.com,
 * staging-admin.getcolander.com → staging.getcolander.com, admin.localhost:8787 → localhost:8787.
 * Everywhere else '' keeps them relative.
 */
export function siteOrigin(url: Pick<URL, 'hostname' | 'origin'>): string {
	if (!/^(staging-)?admin\./.test(url.hostname)) return '';
	const main = new URL(url.origin);
	main.hostname = url.hostname.replace(/^staging-admin\./, 'staging.').replace(/^admin\./, '');
	return main.origin;
}
