// Passkeys in the browser with the platform's own JSON helpers (PublicKeyCredential.parse*FromJSON
// and toJSON), so no WebAuthn library ships to the page. Every supported browser has them; one
// without them simply does not offer passkeys and keeps email codes.
import type { Account } from '@colander/shared/api';
import { api, PlainError } from './api';

type Json = Record<string, unknown>;

function pkc(): typeof PublicKeyCredential | undefined {
	const P = globalThis.PublicKeyCredential as typeof PublicKeyCredential | undefined;
	return P && typeof P.parseRequestOptionsFromJSON === 'function' && typeof P.parseCreationOptionsFromJSON === 'function' ? P : undefined;
}

/** Whether this browser can use passkeys here. */
export const passkeysSupported = (): boolean => !!pkc() && typeof navigator !== 'undefined' && !!navigator.credentials;

/** Whether the browser can offer passkeys in the email field's autofill (conditional UI). */
export async function conditionalSupported(): Promise<boolean> {
	const P = pkc();
	try {
		return !!(await P?.isConditionalMediationAvailable?.());
	} catch {
		return false;
	}
}

/** The person closed the passkey prompt or it timed out: not an error to show loudly. */
export class PasskeyCancelled extends Error {
	constructor() {
		super('The passkey prompt was closed.');
	}
}

const asJson = (cred: Credential | null): Json => {
	if (!cred) throw new PasskeyCancelled();
	return (cred as PublicKeyCredential).toJSON() as unknown as Json;
};

/** Runs navigator.credentials.get for the server's options and returns the credential as JSON. */
export async function getCredential(options: Json, opts: { mediation?: CredentialMediationRequirement; signal?: AbortSignal } = {}): Promise<Json> {
	const P = pkc();
	if (!P) throw new PlainError('This browser cannot use passkeys.');
	try {
		return asJson(await navigator.credentials.get({ publicKey: P.parseRequestOptionsFromJSON(options as unknown as PublicKeyCredentialRequestOptionsJSON), mediation: opts.mediation, signal: opts.signal }));
	} catch (e) {
		if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw new PasskeyCancelled();
		throw e;
	}
}

/** Runs navigator.credentials.create for the server's options and returns the credential as JSON. */
export async function createCredential(options: Json): Promise<Json> {
	const P = pkc();
	if (!P) throw new PlainError('This browser cannot use passkeys.');
	try {
		return asJson(await navigator.credentials.create({ publicKey: P.parseCreationOptionsFromJSON(options as unknown as PublicKeyCredentialCreationOptionsJSON) }));
	} catch (e) {
		if (e instanceof DOMException && e.name === 'NotAllowedError') throw new PasskeyCancelled();
		// The device already holds a passkey for this account: a normal situation, not a fault.
		if (e instanceof DOMException && e.name === 'InvalidStateError') {
			throw new PlainError('This device already holds a passkey for your account. Use it to sign in, or add one on another device.');
		}
		throw e;
	}
}

/**
 * Signs in, or steps up when signed in, with a passkey: a challenge from the server, the browser's
 * prompt, then the check. With mediation 'conditional' it waits for the person to pick a passkey
 * from the email field's autofill.
 */
export async function passkeySignIn(opts: { mediation?: CredentialMediationRequirement; signal?: AbortSignal } = {}): Promise<Account> {
	const { options } = await api<{ options: Json }>('/v1/auth/passkey/options', { method: 'POST', stepUp: false });
	const credential = await getCredential(options, opts);
	const res = await api<{ account: Account }>('/v1/auth/passkey/verify', { method: 'POST', body: { credential }, stepUp: false });
	return res.account;
}
