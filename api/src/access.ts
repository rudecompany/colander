// The admin host (docs/contracts.md 6.1 and 6.9): admin.getcolander.com, staging-admin.getcolander.com,
// and admin.localhost in dev. Cloudflare Access sits in front of it with A3T Identity as the
// identity provider (One-time PIN as the fallback) and independent MFA; the edge verifies the
// Access application token on every request that reaches the Worker and fails closed.
//
// The staff identity is the token's email and, from A3T Identity, the A3T subject that Access
// passes as the custom OIDC claim `sub`. The Store pins that subject on the account's first
// sign-in and refuses any other after that (src/routes/admin.ts).
//
// Dev mode has no Access: POST /__dev/access on admin.localhost mints a token signed by a key
// that exists only in this isolate, and only when COLANDER_DEV=1 and PUBLIC_URL is
// http://localhost. Outside that the dev key is never created or trusted, and the token's issuer
// and audience match no deployed configuration.
import { normalizeEmail } from './auth';
import { primeKeys, rsaKeyPair, signJwt, verifyJwt } from './jwt';

/** The parts of Env the admin host reads. */
export type AccessEnv = Pick<Env, 'COLANDER_DEV' | 'PUBLIC_URL' | 'ADMIN_HOST' | 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD'>;

/** Who Access let in: a normalized email, and the A3T subject when the identity provider sent one. */
export interface AccessIdentity {
	email: string;
	/** a3t:<sub>, or '' for One-time PIN */
	subject: string;
}

/** Dev mode on a local origin: the only place the dev Access stub and the dev ops token work. */
export function devLocal(env: Pick<Env, 'COLANDER_DEV' | 'PUBLIC_URL'>): boolean {
	return env.COLANDER_DEV === '1' && /^http:\/\/localhost(:\d{1,5})?\/?$/.test(env.PUBLIC_URL);
}

/** The admin hostname, or '' when this environment has none. Dev mode on localhost uses admin.localhost. */
export function adminHostname(env: AccessEnv): string {
	return devLocal(env) ? 'admin.localhost' : (env.ADMIN_HOST ?? '').trim().toLowerCase();
}

/** The admin origin for redirects: same scheme and port as PUBLIC_URL. */
export function adminOrigin(env: AccessEnv): string {
	const host = adminHostname(env);
	if (!host) return '';
	const pub = new URL(env.PUBLIC_URL);
	return `${pub.protocol}//${host}${pub.port ? `:${pub.port}` : ''}`;
}

const DEV_ISSUER = 'http://admin.localhost';
const DEV_AUDIENCE = 'colander-dev-access';
const DEV_JWKS = 'dev:access';
let devKey: Promise<CryptoKey> | undefined;

function devSigningKey(): Promise<CryptoKey> {
	return (devKey ??= rsaKeyPair('dev').then(async ({ privateKey, jwks }) => {
		await primeKeys(DEV_JWKS, jwks);
		return privateKey;
	}));
}

/** Dev mode's stand-in for an Access login: an 8-hour token for email, with an A3T subject when given. */
export async function devAccessToken(env: AccessEnv, email: string, subject: string): Promise<string> {
	if (!devLocal(env)) throw new Error('the dev Access stub works only in dev mode on localhost');
	const now = Math.floor(Date.now() / 1000);
	const claims: Record<string, unknown> = { aud: [DEV_AUDIENCE], email, iss: DEV_ISSUER, iat: now, nbf: now, exp: now + 8 * 3600, type: 'app', sub: crypto.randomUUID() };
	if (subject) claims.custom = { sub: subject };
	return signJwt(await devSigningKey(), 'dev', claims);
}

/**
 * The Access token of a request: the Cf-Access-Jwt-Assertion header that Access adds. In dev the
 * stub's CF_Authorization cookie stands in for it.
 */
function accessToken(request: Request, dev: boolean): string {
	const header = request.headers.get('cf-access-jwt-assertion');
	if (header) return header.trim();
	if (!dev) return '';
	return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? '';
}

/**
 * Verifies the Access application token and returns the identity, or null: no token, a bad
 * signature, the wrong issuer or audience, an expired token, a service token (no email), or an
 * environment without CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.
 */
export async function verifyAccess(request: Request, env: AccessEnv): Promise<AccessIdentity | null> {
	const dev = devLocal(env);
	const token = accessToken(request, dev);
	if (!token) return null;
	let opts: { jwksUrl: string; issuer: string; audience: string };
	if (dev) {
		await devSigningKey();
		opts = { jwksUrl: DEV_JWKS, issuer: DEV_ISSUER, audience: DEV_AUDIENCE };
	} else {
		const team = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim().replace(/^https:\/\//, '').replace(/\/+$/, '');
		const aud = (env.CF_ACCESS_AUD ?? '').trim();
		if (!team || !aud) return null;
		opts = { jwksUrl: `https://${team}/cdn-cgi/access/certs`, issuer: `https://${team}`, audience: aud };
	}
	const claims = await verifyJwt(token, opts);
	if (!claims || claims.type !== 'app') return null;
	const email = normalizeEmail(typeof claims.email === 'string' ? claims.email : '');
	if (!email) return null;
	const custom = claims.custom as { sub?: unknown } | undefined;
	const sub = typeof custom?.sub === 'string' ? custom.sub.trim() : '';
	return { email, subject: sub ? `a3t:${sub}` : '' };
}
