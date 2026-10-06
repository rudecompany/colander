// Passkeys (WebAuthn) through @simplewebauthn/server, pinned to an exact version: it parses
// untrusted CBOR and ASN.1, so it changes only in a reviewed pull request. The relying party is the
// host of PUBLIC_URL (getcolander.com, staging.getcolander.com, or localhost in dev) and only the
// PUBLIC_URL origin is accepted. Credentials are discoverable, user verification is required,
// attestation is none, and ES256, EdDSA and RS256 are the allowed algorithms (contracts 6.6).
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { utf8 } from '@colander/shared/bytes';
import type { Account, Passkey } from './store/accounts';

export interface RelyingParty {
	id: string;
	origin: string;
}

export const relyingParty = (publicUrl: string): RelyingParty => {
	const u = new URL(publicUrl);
	return { id: u.hostname, origin: u.origin };
};

/** ES256, EdDSA, RS256. */
export const ALGORITHMS = [-7, -8, -257];
/** At most this many passkeys per account. */
export const MAX_PASSKEYS = 10;
const TIMEOUT_MS = 5 * 60 * 1000;

const descriptor = (p: Passkey) => ({ id: p.credentialId, transports: p.transports });

/** Options to create a passkey for account, excluding the ones it holds. */
export function registrationOptions(rp: RelyingParty, account: Account, existing: Passkey[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: 'Colander',
		rpID: rp.id,
		userName: account.email,
		userDisplayName: account.displayName || account.email,
		// The account ID, never the email, is the user handle authenticators keep.
		userID: new Uint8Array(utf8(account.id)),
		timeout: TIMEOUT_MS,
		attestationType: 'none',
		excludeCredentials: existing.map(descriptor),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
		supportedAlgorithmIDs: ALGORITHMS
	});
}

/** Options to sign in with a passkey: any discoverable one, or only those of one account for a step-up. */
export function authenticationOptions(rp: RelyingParty, allow: Passkey[] = []): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return generateAuthenticationOptions({ rpID: rp.id, allowCredentials: allow.map(descriptor), userVerification: 'required', timeout: TIMEOUT_MS });
}

/** A new credential, verified. */
export interface NewCredential {
	credentialId: string;
	publicKey: Uint8Array;
	signCount: number;
	transports: string[];
	backedUp: boolean;
}

/** Parses a credential sent as JSON text, or undefined. */
export function parseCredential<T extends RegistrationResponseJSON | AuthenticationResponseJSON>(raw: string): T | undefined {
	try {
		const v = JSON.parse(raw) as T;
		return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.response === 'object' ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Verifies a registration against the stored challenge; undefined when anything is off. */
export async function verifyRegistration(rp: RelyingParty, response: RegistrationResponseJSON, challenge: string): Promise<NewCredential | undefined> {
	try {
		const v = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserVerification: true,
			supportedAlgorithmIDs: ALGORITHMS
		});
		if (!v.verified) return undefined;
		const { credential, credentialBackedUp } = v.registrationInfo;
		return {
			credentialId: credential.id,
			publicKey: credential.publicKey,
			signCount: credential.counter,
			transports: (credential.transports ?? []).map(String),
			backedUp: credentialBackedUp
		};
	} catch {
		return undefined;
	}
}

/**
 * Verifies a sign-in against the stored challenge and passkey; undefined when anything is off,
 * including a signature counter that did not move forward (a cloned authenticator). Synced
 * passkeys report 0 every time, which passes.
 */
export async function verifyAuthentication(
	rp: RelyingParty,
	response: AuthenticationResponseJSON,
	challenge: string,
	passkey: Passkey
): Promise<{ signCount: number; backedUp: boolean } | undefined> {
	try {
		const v = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: rp.origin,
			expectedRPID: rp.id,
			requireUserVerification: true,
			credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: passkey.signCount, transports: passkey.transports as never }
		});
		if (!v.verified) return undefined;
		return { signCount: v.authenticationInfo.newCounter, backedUp: v.authenticationInfo.credentialBackedUp };
	} catch {
		return undefined;
	}
}
