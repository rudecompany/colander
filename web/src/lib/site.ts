/** Whether the page is on an admin host: admin.getcolander.com, staging-admin.getcolander.com or admin.localhost. */
export const onAdminHost = (url: Pick<URL, 'hostname'>): boolean => /^(staging-)?admin\./.test(url.hostname);

/**
 * Where links to the public site point. On the admin host they leave it for the main host, since
 * the admin host serves only the admin console: admin.getcolander.com → getcolander.com,
 * staging-admin.getcolander.com → staging.getcolander.com, admin.localhost:8787 → localhost:8787.
 * Everywhere else '' keeps them relative.
 */
export function siteOrigin(url: Pick<URL, 'hostname' | 'origin'>): string {
	if (!onAdminHost(url)) return '';
	const main = new URL(url.origin);
	main.hostname = url.hostname.replace(/^staging-admin\./, 'staging.').replace(/^admin\./, '');
	return main.origin;
}

/**
 * Where links to the admin console point, the other way round: getcolander.com →
 * admin.getcolander.com, staging.getcolander.com → staging-admin.getcolander.com, localhost:8787 →
 * admin.localhost:8787, and the admin host itself. Always absolute, so the browser leaves the
 * site's client-side router and the admin host's Access sign-in runs.
 */
export function adminOrigin(url: Pick<URL, 'hostname' | 'origin'>): string {
	if (onAdminHost(url)) return url.origin;
	const admin = new URL(url.origin);
	admin.hostname = /^staging\./.test(url.hostname) ? url.hostname.replace(/^staging\./, 'staging-admin.') : `admin.${url.hostname}`;
	return admin.origin;
}
