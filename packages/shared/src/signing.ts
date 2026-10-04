// Ed25519 for lists, signed JSON envelopes and plan tokens (docs/contracts.md 3, 4, 5): verification
// for clients, signing for the server. Only WebCrypto, so it runs in workerd, browsers and Node.
// One key signs everything; context strings keep the uses apart.
import type { PlanTokenPayload } from './api';
import { b64decode, b64encode, b64url, concat, hex, utf8 } from './bytes';

export interface TrustedKey {
	/** Hex of the first 8 bytes of SHA-256 over the raw 32-byte public key. */
	id: string;
	key: CryptoKey;
}

export const CONFIG_CONTEXT = 'colander:config:v1';
export const PLAN_CONTEXT = 'colander:plan:v1';

// Copies into a fresh ArrayBuffer so WebCrypto never sees a view over a larger buffer.
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export async function importKeys(base64Keys: string[]): Promise<TrustedKey[]> {
	const out: TrustedKey[] = [];
	for (const k of base64Keys) {
		const raw = b64decode(k.trim());
		if (raw.length !== 32) continue;
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(raw)));
		const key = await crypto.subtle.importKey('raw', buf(raw), { name: 'Ed25519' }, false, ['verify']);
		out.push({ id: hex(digest.subarray(0, 8)), key });
	}
	return out;
}

/** Verifies with the key named by `keyId`, or with every trusted key when no ID is given. */
export async function verifyEd25519(
	keys: TrustedKey[],
	keyId: Uint8Array | string | null,
	data: Uint8Array,
	signature: Uint8Array
): Promise<boolean> {
	if (signature.length !== 64) return false;
	const id = keyId == null ? null : typeof keyId === 'string' ? keyId.toLowerCase() : hex(keyId);
	for (const k of keys) {
		if (id && k.id !== id) continue;
		if (await crypto.subtle.verify({ name: 'Ed25519' }, k.key, buf(signature), buf(data))) return true;
	}
	return false;
}

function signedMessage(context: string, payload: Uint8Array): Uint8Array {
	return concat(utf8(context), new Uint8Array([0]), payload);
}

/** Verifies a `{kid, payload, sig}` envelope and returns the parsed payload JSON, or throws. */
export async function verifyEnvelope(envelope: unknown, context: string, keys: TrustedKey[]): Promise<unknown> {
	const e = envelope as { kid?: unknown; payload?: unknown; sig?: unknown };
	if (!e || typeof e.kid !== 'string' || typeof e.payload !== 'string' || typeof e.sig !== 'string') {
		throw new Error('malformed envelope');
	}
	const payload = b64decode(e.payload);
	if (!(await verifyEd25519(keys, e.kid, signedMessage(context, payload), b64decode(e.sig)))) {
		throw new Error('bad envelope signature');
	}
	return JSON.parse(new TextDecoder().decode(payload));
}

/** Verifies a plan token offline. Returns its payload, or null when it is malformed or forged. */
export async function verifyPlanToken(token: string, keys: TrustedKey[]): Promise<PlanTokenPayload | null> {
	const parts = token.trim().split('.');
	if (parts.length !== 2) return null;
	try {
		const payload = b64decode(parts[0]!);
		if (!(await verifyEd25519(keys, null, signedMessage(PLAN_CONTEXT, payload), b64decode(parts[1]!)))) return null;
		const p = JSON.parse(new TextDecoder().decode(payload)) as PlanTokenPayload;
		if (p.v !== 1 || p.plan !== 'plus' || typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
		return p;
	} catch {
		return null;
	}
}

/** Plus is unlocked while now < exp (contract 5). */
export function planActive(p: PlanTokenPayload | null, nowMs = Date.now()): boolean {
	return !!p && nowMs / 1000 < p.exp;
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/** The server's signing key, built from the 32-byte seed in COLANDER_SIGNING_KEY (contract 12). */
export class SigningKey {
	private constructor(
		private readonly key: CryptoKey,
		/** Raw 32-byte public key. */
		readonly publicKey: Uint8Array,
		/** First 8 bytes of SHA-256 over the public key. */
		readonly id: Uint8Array
	) {}

	static async fromSeed(seed: Uint8Array): Promise<SigningKey> {
		if (seed.length !== 32) throw new Error(`signing key seed must be 32 bytes, got ${seed.length}`);
		const pkcs8 = buf(concat(PKCS8_PREFIX, seed));
		// WebCrypto has no "public key from private key", but the private JWK carries it as x.
		const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
		const jwk = (await crypto.subtle.exportKey('jwk', exportable)) as JsonWebKey;
		if (!jwk.x) throw new Error('Ed25519 private key export carries no public key');
		const publicKey = b64decode(jwk.x);
		const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(publicKey)));
		return new SigningKey(key, publicKey, digest.slice(0, 8));
	}

	get idHex(): string {
		return hex(this.id);
	}

	/** The public key in the form the extension trusts (base64 of the raw key). */
	get publicBase64(): string {
		return b64encode(this.publicKey);
	}

	/** Signs data as is. Lists use it directly over header and entries. */
	async sign(data: Uint8Array): Promise<Uint8Array> {
		return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.key, buf(data)));
	}
}

export interface Envelope {
	kid: string;
	payload: string;
	sig: string;
}

/** Signs payload bytes under a context into the `{kid, payload, sig}` envelope (contract 4). */
export async function signEnvelope(key: SigningKey, context: string, payload: Uint8Array): Promise<Envelope> {
	return { kid: key.idHex, payload: b64encode(payload), sig: b64encode(await key.sign(signedMessage(context, payload))) };
}

/**
 * JSON exactly as Go's encoding/json writes it: JSON.stringify plus Go's escapes for <, >, & and
 * U+2028/U+2029, so tokens stay byte-identical to the ones the Go server signed.
 */
function goJSON(value: unknown): string {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Issues a plan token (contract 5): base64url(payload) + "." + base64url(signature), unpadded. */
export async function issuePlanToken(key: SigningKey, claims: PlanTokenPayload): Promise<string> {
	// Field order is part of the signed bytes; it matches the Go struct.
	const { v, sub, plan, trial, iat, exp } = claims;
	const payload = utf8(goJSON({ v, sub, plan, trial, iat, exp }));
	return `${b64url(payload)}.${b64url(await key.sign(signedMessage(PLAN_CONTEXT, payload)))}`;
}
