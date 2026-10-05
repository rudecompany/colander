// A small software passkey for the API tests: it answers registration and sign-in options the
// way a platform authenticator does (attestation none, a discoverable credential, user
// verification), with a P-256 (ES256) or Ed25519 (EdDSA) key, and can be told to misbehave: a
// wrong origin, a wrong RP ID, no user verification, or a signature counter that goes back.
import { b64decode, b64url, concat, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';

/** A minimal CBOR encoder: unsigned and negative integers, byte and text strings, maps. */
function cbor(v: unknown): Uint8Array {
	const head = (major: number, n: number): Uint8Array => {
		if (n < 24) return new Uint8Array([(major << 5) | n]);
		if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
		if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
		return new Uint8Array([(major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
	};
	if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === 'string') {
		const b = utf8(v);
		return concat(head(3, b.length), b);
	}
	if (v instanceof Uint8Array) return concat(head(2, v.length), v);
	if (v instanceof Map) {
		const parts: Uint8Array[] = [head(5, v.size)];
		for (const [k, val] of v) parts.push(cbor(k), cbor(val));
		return concat(...parts);
	}
	throw new Error('cbor: unsupported value');
}

/** WebCrypto's raw ECDSA signature (r || s) as the DER that WebAuthn uses. */
function der(raw: Uint8Array): Uint8Array {
	const int = (b: Uint8Array) => {
		let i = 0;
		while (i < b.length - 1 && b[i] === 0) i++;
		let out: Uint8Array = b.slice(i);
		if (out[0]! & 0x80) out = concat(new Uint8Array([0]), out);
		return concat(new Uint8Array([2, out.length]), out);
	};
	const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
	return concat(new Uint8Array([0x30, body.length]), body);
}

const u32 = (n: number) => new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

export interface Misbehave {
	origin?: string;
	rpId?: string;
	/** clear the user verified flag */
	noUv?: boolean;
	/** the signature counter to report */
	counter?: number;
}

export class SoftAuthenticator {
	private keys?: CryptoKeyPair;
	credentialId = crypto.getRandomValues(new Uint8Array(16));
	userHandle: Uint8Array = new Uint8Array();
	counter = 0;

	constructor(
		readonly origin: string,
		readonly alg: 'ES256' | 'EdDSA' = 'ES256'
	) {}

	get id(): string {
		return b64url(this.credentialId);
	}

	private async keyPair(): Promise<CryptoKeyPair> {
		this.keys ??= (await crypto.subtle.generateKey(
			this.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' },
			true,
			['sign', 'verify']
		)) as CryptoKeyPair;
		return this.keys;
	}

	private async coseKey(): Promise<Uint8Array> {
		const jwk = (await crypto.subtle.exportKey('jwk', (await this.keyPair()).publicKey)) as JsonWebKey;
		if (this.alg === 'ES256') {
			return cbor(
				new Map<number, unknown>([
					[1, 2],
					[3, -7],
					[-1, 1],
					[-2, b64decode(jwk.x!)],
					[-3, b64decode(jwk.y!)]
				])
			);
		}
		return cbor(
			new Map<number, unknown>([
				[1, 1],
				[3, -8],
				[-1, 6],
				[-2, b64decode(jwk.x!)]
			])
		);
	}

	private flags(at: boolean, m: Misbehave): number {
		// UP, UV (unless told not to), BE and BS for a synced passkey, AT when a credential follows.
		return 0x01 | (m.noUv ? 0 : 0x04) | 0x08 | 0x10 | (at ? 0x40 : 0);
	}

	private clientData(type: string, challenge: string, m: Misbehave): Uint8Array {
		return utf8(JSON.stringify({ type, challenge, origin: m.origin ?? this.origin, crossOrigin: false }));
	}

	/** Answers PublicKeyCredentialCreationOptionsJSON with a RegistrationResponseJSON. */
	async create(options: { challenge: string; rp: { id?: string }; user: { id: string } }, m: Misbehave = {}): Promise<Record<string, unknown>> {
		this.userHandle = b64decode(options.user.id);
		const rpId = m.rpId ?? options.rp.id!;
		const attested = concat(new Uint8Array(16), new Uint8Array([0, this.credentialId.length]), this.credentialId, await this.coseKey());
		const authData = concat(sha256(utf8(rpId)), new Uint8Array([this.flags(true, m)]), u32(this.counter), attested);
		const attestationObject = cbor(
			new Map<string, unknown>([
				['fmt', 'none'],
				['attStmt', new Map()],
				['authData', authData]
			])
		);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, m)),
				attestationObject: b64url(attestationObject),
				transports: ['internal']
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}

	/** Answers PublicKeyCredentialRequestOptionsJSON with an AuthenticationResponseJSON. */
	async get(options: { challenge: string; rpId?: string }, m: Misbehave = {}): Promise<Record<string, unknown>> {
		const rpId = m.rpId ?? options.rpId!;
		const counter = m.counter ?? this.counter;
		const authData = concat(sha256(utf8(rpId)), new Uint8Array([this.flags(false, m)]), u32(counter));
		const clientDataJSON = this.clientData('webauthn.get', options.challenge, m);
		const data = concat(authData, sha256(clientDataJSON));
		const key = (await this.keyPair()).privateKey;
		const raw = new Uint8Array(
			await crypto.subtle.sign(this.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' }, key, data)
		);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authData),
				signature: b64url(this.alg === 'ES256' ? der(raw) : raw),
				userHandle: b64url(this.userHandle)
			},
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}
}
