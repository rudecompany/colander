// RS256 JWT verification against a published key set (JWKS), with WebCrypto only. It checks the
// Cloudflare Access application token on the admin host and the GitHub Actions OIDC token on the
// ops channel. Ported from A3T Core's admin Worker (apps/admin/worker/access.ts): keys are
// cached per URL for an hour, and anything malformed, unsigned, expired or not yet valid fails
// closed. It returns the claims instead of a boolean.
import { b64decode, b64url, utf8 } from '@colander/shared/bytes';

type Jwk = { kid?: string; kty?: string; n?: string; e?: string };

interface KeySet {
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

const KEY_TTL_MS = 60 * 60 * 1000;
/** An unknown kid refetches the set at most this often, so junk tokens cannot make us hammer it. */
const REFETCH_MS = 60 * 1000;

const sets = new Map<string, KeySet>();

/** The claims of a verified token. */
export type Claims = Record<string, unknown> & { iss: string; exp: number };

async function importKeys(jwks: { keys?: Jwk[] }): Promise<Map<string, CryptoKey>> {
	const keys = new Map<string, CryptoKey>();
	for (const jwk of jwks.keys ?? []) {
		if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue;
		try {
			keys.set(
				jwk.kid,
				await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
			);
		} catch {
			// Skip malformed keys.
		}
	}
	return keys;
}

/** Puts a key set in the cache, as if it was fetched from url: tests and dev mode use it. */
export async function primeKeys(url: string, jwks: { keys: Jwk[] }, now = Date.now()): Promise<void> {
	sets.set(url, { keys: await importKeys(jwks), fetchedAt: now + 100 * 365 * 86_400_000 });
}

async function signingKey(url: string, kid: string, now: number): Promise<CryptoKey | undefined> {
	const cached = sets.get(url);
	const fresh = cached && now - cached.fetchedAt < KEY_TTL_MS;
	if (cached?.keys.has(kid) && fresh) return cached.keys.get(kid);
	if (cached && now - cached.fetchedAt < REFETCH_MS) return undefined;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return undefined;
		sets.set(url, { keys: await importKeys(await res.json()), fetchedAt: now });
	} catch {
		return undefined;
	}
	return sets.get(url)?.keys.get(kid);
}

const decode = <T>(segment: string): T => JSON.parse(new TextDecoder().decode(b64decode(segment))) as T;

/**
 * Verifies token as RS256 against the keys at jwksUrl and returns its claims, or null. iss must
 * equal issuer, aud must be or contain audience, exp must be in the future and nbf (when set)
 * not more than a minute ahead.
 */
export async function verifyJwt(token: string, opts: { jwksUrl: string; issuer: string; audience: string; now?: number }): Promise<Claims | null> {
	const now = opts.now ?? Date.now();
	const parts = token.split('.');
	if (parts.length !== 3 || !opts.audience || !opts.issuer) return null;
	let header: { alg?: string; kid?: string };
	let claims: Claims;
	try {
		header = decode(parts[0]!);
		claims = decode(parts[1]!);
	} catch {
		return null;
	}
	if (typeof claims !== 'object' || claims === null) return null;
	if (header.alg !== 'RS256' || !header.kid) return null;
	const s = Math.floor(now / 1000);
	if (typeof claims.exp !== 'number' || claims.exp <= s) return null;
	if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > s + 60)) return null;
	if (claims.iss !== opts.issuer) return null;
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(opts.audience)) return null;
	const key = await signingKey(opts.jwksUrl, header.kid, now);
	if (!key) return null;
	try {
		const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64decode(parts[2]!), utf8(`${parts[0]}.${parts[1]}`));
		return ok ? claims : null;
	} catch {
		return null;
	}
}

/** Signs claims as an RS256 JWT with key under kid: dev mode's stand-in for Access, and tests. */
export async function signJwt(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
	const enc = (v: unknown) => b64url(utf8(JSON.stringify(v)));
	const body = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
	const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(body));
	return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** A fresh RS256 key pair and its public JWK set. */
export async function rsaKeyPair(kid: string): Promise<{ privateKey: CryptoKey; jwks: { keys: Jwk[] } }> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
	return { privateKey: pair.privateKey, jwks: { keys: [{ kid, kty: 'RSA', n: pub.n, e: pub.e }] } };
}
