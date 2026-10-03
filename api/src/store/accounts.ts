// Accounts, sessions, magic links and reviewer tokens (Go's store/accounts.go).
import { newId, nullString, type Db } from './db';

/** A website account. */
export interface Account {
	id: string;
	email: string;
	displayName: string;
	/** member | curator | staff */
	role: string;
	createdAt: number;
}

type AccountRow = { id: string; email: string; display_name: string; role: string; created_at: number };

function scanAccount(r: AccountRow | undefined): Account | undefined {
	return r && { id: r.id, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at };
}

const accountCols = `a.id, a.email, ifnull(a.display_name, '') AS display_name, a.role, a.created_at`;

/** Loads an account by id. */
export function getAccount(db: Db, id: string): Account | undefined {
	return scanAccount(db.get<AccountRow>(`SELECT ${accountCols} FROM accounts a WHERE a.id = ?`, id));
}

/** Loads an account by its normalized email. */
export function accountByEmail(db: Db, email: string): Account | undefined {
	return scanAccount(db.get<AccountRow>(`SELECT ${accountCols} FROM accounts a WHERE a.email = ?`, email));
}

function ensureAccount(db: Db, email: string, now: number): void {
	db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING', newId('acc'), email, now);
}

/** Sets an account's role, creating the account when the email is new. */
export function grantRole(db: Db, email: string, role: string, now: number): Account {
	return db.tx(() => {
		ensureAccount(db, email, now);
		db.run('UPDATE accounts SET role = ? WHERE email = ?', role, email);
		return accountByEmail(db, email)!;
	});
}

/** Updates the public name ("" clears it). */
export function setDisplayName(db: Db, id: string, name: string): void {
	db.run('UPDATE accounts SET display_name = ? WHERE id = ?', nullString(name), id);
}

/** Stores a hashed sign-in token. */
export function createMagicLink(db: Db, tokenHash: string, email: string, next: string, now: number, expires: number): void {
	db.run(
		'INSERT INTO magic_links (token_hash, email, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
		tokenHash,
		email,
		next,
		now,
		expires
	);
}

/**
 * Consumes an unexpired, unused link and returns the account it signs in, creating the account on
 * first sign-in. Undefined is Go's ErrNotFound. Call it in the same tx as createSession (hosting
 * plan section 1.2).
 */
export function useMagicLink(db: Db, tokenHash: string, now: number): Account | undefined {
	return db.tx(() => {
		const row = db.get<{ email: string }>(
			`UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
			RETURNING email`,
			now,
			tokenHash,
			now
		);
		if (!row) return undefined;
		ensureAccount(db, row.email, now);
		db.run('DELETE FROM magic_links WHERE expires_at < ?', now);
		return accountByEmail(db, row.email);
	});
}

/** Stores a hashed session token and drops expired sessions. */
export function createSession(db: Db, tokenHash: string, accountId: string, now: number, expires: number): void {
	db.tx(() => {
		db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
		db.run(
			'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
			tokenHash,
			accountId,
			now,
			expires
		);
	});
}

/** Returns the account behind an unexpired session. */
export function sessionAccount(db: Db, tokenHash: string, now: number): Account | undefined {
	return scanAccount(
		db.get<AccountRow>(
			`SELECT ${accountCols} FROM sessions x JOIN accounts a ON a.id = x.account_id
			WHERE x.token_hash = ? AND x.expires_at > ?`,
			tokenHash,
			now
		)
	);
}

/** Removes a session. */
export function deleteSession(db: Db, tokenHash: string): void {
	db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

/** Replaces an account's reviewer token. */
export function setReviewerToken(db: Db, accountId: string, tokenHash: string, now: number): void {
	db.run(
		`INSERT INTO reviewer_tokens (token_hash, account_id, created_at) VALUES (?, ?, ?)
		ON CONFLICT (account_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
		tokenHash,
		accountId,
		now
	);
}

/** Returns the account behind a reviewer token. */
export function reviewerAccount(db: Db, tokenHash: string): Account | undefined {
	return scanAccount(
		db.get<AccountRow>(
			`SELECT ${accountCols} FROM reviewer_tokens r JOIN accounts a ON a.id = r.account_id
			WHERE r.token_hash = ?`,
			tokenHash
		)
	);
}
