// Test identities for the two token checks of src/jwt.ts: Cloudflare Access application tokens
// for the admin host, and GitHub Actions OIDC tokens for the ops channel. Each is signed by a key
// made here, whose public half is put in the verifier's key cache under the URL production
// fetches, so the Worker runs its real verification.
import { env } from 'cloudflare:workers';
import { primeKeys, rsaKeyPair, signJwt } from '../src/jwt';
import { GITHUB_JWKS } from '../src/ops';

/** The admin host, Access team and AUD the workerd tests run with (vitest.config.ts). */
export const ADMIN_ORIGIN = 'https://admin.getcolander.com';
export const ACCESS_TEAM = env.CF_ACCESS_TEAM_DOMAIN;
export const ACCESS_AUD = env.CF_ACCESS_AUD;

const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(url: string, kid: string): Promise<CryptoKey> {
	let k = keys.get(url);
	if (!k) {
		k = rsaKeyPair(kid).then(async ({ privateKey, jwks }) => {
			await primeKeys(url, jwks);
			return privateKey;
		});
		keys.set(url, k);
	}
	return k;
}

const now = () => Math.floor(Date.now() / 1000);

/** An Access application token for email; subject becomes the custom `sub` claim of A3T Identity. */
export async function accessToken(email: string, opts: { subject?: string; claims?: Record<string, unknown>; kid?: string } = {}): Promise<string> {
	const key = await keyFor(`https://${ACCESS_TEAM}/cdn-cgi/access/certs`, 'access');
	const claims: Record<string, unknown> = {
		aud: [ACCESS_AUD],
		email,
		iss: `https://${ACCESS_TEAM}`,
		iat: now(),
		nbf: now(),
		exp: now() + 3600,
		type: 'app',
		sub: 'cf-user-1',
		...(opts.subject ? { custom: { sub: opts.subject } } : {}),
		...opts.claims
	};
	return signJwt(key, opts.kid ?? 'access', claims);
}

/** Headers of a browser request through Access on the admin host. */
export async function accessHeaders(email: string, opts: { subject?: string } = {}): Promise<Record<string, string>> {
	return { 'Cf-Access-Jwt-Assertion': await accessToken(email, opts), 'X-Colander-CSRF': '1', 'Sec-Fetch-Site': 'same-origin' };
}

/** A GitHub Actions OIDC token as the Ops workflow on main gets it, with claims overridden. */
export async function githubToken(claims: Record<string, unknown> = {}, kid = 'gh'): Promise<string> {
	const key = await keyFor(GITHUB_JWKS, 'gh');
	return signJwt(key, kid, {
		iss: 'https://token.actions.githubusercontent.com',
		aud: env.PUBLIC_URL,
		sub: 'repo:rudecompany/colander:environment:production',
		repository: 'rudecompany/colander',
		repository_id: '1403629038',
		ref: 'refs/heads/main',
		workflow_ref: 'rudecompany/colander/.github/workflows/ops.yml@refs/heads/main',
		environment: env.OPS_GITHUB_ENVIRONMENT,
		actor: 'slantview',
		run_id: '4242',
		iat: now(),
		nbf: now(),
		exp: now() + 300,
		...claims
	});
}

/** The Authorization header of the ops channel. */
export const opsAuth = async (claims: Record<string, unknown> = {}) => ({ Authorization: 'Bearer ' + (await githubToken(claims)) });
