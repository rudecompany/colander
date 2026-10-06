// Pairing codes (0007_pairing.sql, contracts 7): one row per code the website showed.
import { newId, type Db } from './db';

export type PairKind = 'plan' | 'reviewer';

export interface Pairing {
	id: string;
	accountId: string;
	kind: PairKind;
	expiresAt: number;
	claimedAt: number;
	extVersion: string;
	browser: string;
}

type PairingRow = { id: string; account_id: string; kind: string; expires_at: number; claimed_at: number; ext_version: string; browser: string };

const cols = `id, account_id, kind, expires_at, ifnull(claimed_at, 0) AS claimed_at, ifnull(ext_version, '') AS ext_version, ifnull(browser, '') AS browser`;

function scan(r: PairingRow | undefined): Pairing | undefined {
	return r && { id: r.id, accountId: r.account_id, kind: r.kind as PairKind, expiresAt: r.expires_at, claimedAt: r.claimed_at, extVersion: r.ext_version, browser: r.browser };
}

/**
 * Stores a new code for the account and ends its earlier unclaimed code of the same kind, so only
 * the code on screen works. Returns the new pairing's ID.
 */
export function createPairing(db: Db, accountId: string, kind: PairKind, codeHash: string, now: number, expires: number): string {
	const id = newId('pair');
	db.tx(() => {
		db.run('UPDATE pairings SET expires_at = ? WHERE account_id = ? AND kind = ? AND claimed_at IS NULL AND expires_at > ?', now, accountId, kind, now);
		db.run('INSERT INTO pairings (id, account_id, kind, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, accountId, kind, codeHash, now, expires);
	});
	return id;
}

/** The account's own pairing, or undefined. */
export function getPairing(db: Db, accountId: string, id: string): Pairing | undefined {
	return scan(db.get<PairingRow>(`SELECT ${cols} FROM pairings WHERE id = ? AND account_id = ?`, id, accountId));
}

/** Ends the account's codes that were not used yet, when its credentials end (sign out everywhere, revoke). */
export function endPairings(db: Db, accountId: string): void {
	db.run('DELETE FROM pairings WHERE account_id = ? AND claimed_at IS NULL', accountId);
}

/** Uses an unexpired, unclaimed code once. Undefined for a wrong, used or expired code. */
export function claimPairing(db: Db, codeHash: string, extVersion: string, browser: string, now: number): Pairing | undefined {
	return scan(
		db.get<PairingRow>(
			`UPDATE pairings SET claimed_at = ?, ext_version = ?, browser = ?
			WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > ? RETURNING ${cols}`,
			now,
			extVersion,
			browser,
			codeHash,
			now
		)
	);
}
