// Accounts, sessions, passkeys, sign-in flows, reviewer tokens, held requests and the audit log
// (docs/contracts.md 6.6 and 6.9). Every secret is stored only as a SHA-256 hash. Everything here
// is synchronous, so it runs inside the caller's transaction.
import { rank } from '../permissions';
import { newId, nullString, type Db } from './db';

/** A website account. */
export interface Account {
	id: string;
	email: string;
	displayName: string;
	/** member | curator | staff | admin */
	role: string;
	createdAt: number;
	/** the pinned A3T subject (a3t:<sub>), or '' */
	accessSubject: string;
}

type AccountRow = { id: string; email: string; display_name: string; role: string; created_at: number; access_subject: string };

function scanAccount(r: AccountRow | undefined): Account | undefined {
	return r && { id: r.id, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at, accessSubject: r.access_subject };
}

const accountCols = `a.id, a.email, ifnull(a.display_name, '') AS display_name, a.role, a.created_at, ifnull(a.access_subject, '') AS access_subject`;

/** Loads an account by id. */
export function getAccount(db: Db, id: string): Account | undefined {
	return scanAccount(db.get<AccountRow>(`SELECT ${accountCols} FROM accounts a WHERE a.id = ?`, id));
}

/** Loads an account by its normalized email. */
export function accountByEmail(db: Db, email: string): Account | undefined {
	return scanAccount(db.get<AccountRow>(`SELECT ${accountCols} FROM accounts a WHERE a.email = ?`, email));
}

/** The account for email, created on first sign-in. */
export function ensureAccount(db: Db, email: string, now: number): Account {
	db.run('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING', newId('acc'), email, now);
	return accountByEmail(db, email)!;
}

/** Whether any account holds the admin role: the ops channel grants staff and admin only until one does. */
export const hasAdmin = (db: Db): boolean => db.get("SELECT 1 FROM accounts WHERE role = 'admin' LIMIT 1") !== undefined;

/** One audit log row (src/store/migrations/0006_auth.sql). */
export interface AuditEntry {
	action: string;
	host: 'main' | 'admin' | 'ops' | 'job';
	target?: string;
	actorId?: string;
	actorSub?: string;
	actorEmail?: string;
	before?: string;
	after?: string;
	reason?: string;
	requestId?: string;
}

/** Appends to the audit log, which takes inserts only. now is unix seconds. */
export function audit(db: Db, e: AuditEntry, now: number): void {
	db.run(
		`INSERT INTO audit_log (at, actor_id, actor_sub, actor_email, host, action, target, before, after, reason, request_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		now,
		e.actorId ?? null,
		e.actorSub ?? null,
		e.actorEmail ?? null,
		e.host,
		e.action,
		e.target ?? null,
		e.before ?? null,
		e.after ?? null,
		e.reason ?? null,
		e.requestId ?? null
	);
}

/**
 * Sets an account's role, creating the account when the email is new. Raising a role to curator
 * or above ends the account's sessions and deletes its passkeys and reviewer token in the same
 * transaction, so a passkey added while it was a member never carries review authority: the new
 * reviewer enrolls one through an invite. It also cancels a support email change still waiting,
 * which only ever moves member accounts. Lowering it below curator deletes the reviewer token.
 */
export function grantRole(db: Db, email: string, role: string, now: number, who: Omit<AuditEntry, 'action' | 'target'>): Account {
	return db.tx(() => {
		const before = ensureAccount(db, email, now);
		if (before.role === role) return before;
		db.run('UPDATE accounts SET role = ? WHERE id = ?', role, before.id);
		audit(db, { ...who, action: 'role_changed', target: before.id, before: before.role, after: role }, now);
		if (rank(role) > rank(before.role) && rank(role) >= rank('curator')) {
			revokeCredentials(db, before.id);
			const moved = db.run(
				"UPDATE account_requests SET cancelled_at = ? WHERE account_id = ? AND kind = 'email_change' AND done_at IS NULL AND cancelled_at IS NULL",
				now,
				before.id
			);
			if (moved > 0) audit(db, { ...who, action: 'request_cancelled', target: before.id, before: 'email_change', reason: 'review accounts never move to a new address' }, now);
		} else if (rank(role) < rank('curator')) db.run('DELETE FROM reviewer_tokens WHERE account_id = ?', before.id);
		return getAccount(db, before.id)!;
	});
}

/** Ends every session and deletes every passkey and the reviewer token of an account. */
export function revokeCredentials(db: Db, accountId: string): void {
	db.run('DELETE FROM sessions WHERE account_id = ?', accountId);
	db.run('DELETE FROM passkeys WHERE account_id = ?', accountId);
	db.run('DELETE FROM reviewer_tokens WHERE account_id = ?', accountId);
	db.run("DELETE FROM auth_flows WHERE account_id = ? AND kind IN ('register', 'passkey')", accountId);
}

/** Updates the public name ("" clears it). */
export function setDisplayName(db: Db, id: string, name: string): void {
	db.run('UPDATE accounts SET display_name = ? WHERE id = ?', nullString(name), id);
}

/** Pins the A3T subject of a staff account. */
export function pinAccessSubject(db: Db, id: string, subject: string): void {
	db.run('UPDATE accounts SET access_subject = ? WHERE id = ? AND access_subject IS NULL', subject, id);
}

/**
 * Consumes an unexpired, unused sign-in link and returns the account it signs in, creating the
 * account on first sign-in. Links are no longer sent: this only lets links mailed before code
 * sign-in shipped finish within their 20 minutes, and goes with the magic_links table.
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
		return ensureAccount(db, row.email, now);
	});
}

/** A session and how it signed in. */
export interface Session {
	tokenHash: string;
	account: Account;
	/** email | passkey */
	method: string;
	/** the passkey this session signed in with, or '' (also once that passkey is removed) */
	passkeyId: string;
	authenticatedAt: number;
	createdAt: number;
	expiresAt: number;
	lastSeenAt: number;
	legacy: boolean;
}

type SessionRow = AccountRow & {
	token_hash: string;
	method: string;
	passkey_id: string;
	authenticated_at: number;
	s_created_at: number;
	expires_at: number;
	last_seen_at: number;
	legacy: number;
};

const scanSession = (r: SessionRow): Session => ({
	tokenHash: r.token_hash,
	account: scanAccount(r)!,
	method: r.method,
	passkeyId: r.passkey_id,
	authenticatedAt: r.authenticated_at,
	createdAt: r.s_created_at,
	expiresAt: r.expires_at,
	lastSeenAt: r.last_seen_at,
	legacy: r.legacy === 1
});

/** Stores a hashed session token and drops expired sessions. now and expires are unix seconds. */
export function createSession(
	db: Db,
	s: { tokenHash: string; accountId: string; method: 'email' | 'passkey'; passkeyId?: string; now: number; expires: number }
): void {
	db.tx(() => {
		db.run('DELETE FROM sessions WHERE expires_at <= ?', s.now);
		db.run(
			`INSERT INTO sessions (token_hash, account_id, created_at, expires_at, method, authenticated_at, last_seen_at, passkey_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			s.tokenHash,
			s.accountId,
			s.now,
			s.expires,
			s.method,
			s.now,
			s.now,
			s.passkeyId || null
		);
	});
}

/** The unexpired session behind a token hash. */
export function getSession(db: Db, tokenHash: string, now: number): Session | undefined {
	const r = db.get<SessionRow>(
		`SELECT ${accountCols}, x.token_hash, x.method, ifnull(x.passkey_id, '') AS passkey_id,
		ifnull(x.authenticated_at, x.created_at) AS authenticated_at, x.created_at AS s_created_at, x.expires_at,
		ifnull(x.last_seen_at, x.created_at) AS last_seen_at, x.legacy
		FROM sessions x JOIN accounts a ON a.id = x.account_id
		WHERE x.token_hash = ? AND x.expires_at > ?`,
		tokenHash,
		now
	);
	return r && scanSession(r);
}

/** Records use of a session, at most once an hour. */
export function touchSession(db: Db, s: Session, now: number): void {
	if (now - s.lastSeenAt >= 3600) db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, s.tokenHash);
}

/** Removes a session. */
export function deleteSession(db: Db, tokenHash: string): void {
	db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

/** The dates of an account's sessions, for the export. */
export function sessionDates(db: Db, accountId: string): { method: string; created_at: number; authenticated_at: number; last_seen_at: number; expires_at: number }[] {
	return db.all(
		`SELECT method, created_at, ifnull(authenticated_at, created_at) AS authenticated_at, ifnull(last_seen_at, created_at) AS last_seen_at, expires_at
		FROM sessions WHERE account_id = ? ORDER BY created_at`,
		accountId
	);
}

/** A stored passkey. */
export interface Passkey {
	id: string;
	accountId: string;
	credentialId: string;
	publicKey: Uint8Array;
	signCount: number;
	transports: string[];
	backedUp: boolean;
	name: string;
	createdAt: number;
	lastUsedAt: number;
}

type PasskeyRow = {
	id: string;
	account_id: string;
	credential_id: string;
	public_key: ArrayBuffer;
	sign_count: number;
	transports: string;
	backed_up: number;
	name: string;
	created_at: number;
	last_used_at: number;
};

const passkeyCols = `id, account_id, credential_id, public_key, sign_count, ifnull(transports, '[]') AS transports, backed_up,
	ifnull(name, '') AS name, created_at, ifnull(last_used_at, 0) AS last_used_at`;

const scanPasskey = (r: PasskeyRow): Passkey => ({
	id: r.id,
	accountId: r.account_id,
	credentialId: r.credential_id,
	publicKey: new Uint8Array(r.public_key),
	signCount: r.sign_count,
	transports: JSON.parse(r.transports) as string[],
	backedUp: r.backed_up === 1,
	name: r.name,
	createdAt: r.created_at,
	lastUsedAt: r.last_used_at
});

/** An account's passkeys, oldest first. */
export function passkeys(db: Db, accountId: string): Passkey[] {
	return db.all<PasskeyRow>(`SELECT ${passkeyCols} FROM passkeys WHERE account_id = ? ORDER BY created_at, rowid`, accountId).map(scanPasskey);
}

/** The passkey with a credential ID. */
export function passkeyByCredential(db: Db, credentialId: string): Passkey | undefined {
	const r = db.get<PasskeyRow>(`SELECT ${passkeyCols} FROM passkeys WHERE credential_id = ?`, credentialId);
	return r && scanPasskey(r);
}

export const passkeyCount = (db: Db, accountId: string): number =>
	db.get<{ n: number }>('SELECT count(*) AS n FROM passkeys WHERE account_id = ?', accountId)!.n;

/** Stores a new passkey and returns its id. */
export function addPasskey(
	db: Db,
	p: { accountId: string; credentialId: string; publicKey: Uint8Array; signCount: number; transports: string[]; backedUp: boolean; name: string },
	now: number
): string {
	const id = newId('pk');
	db.run(
		`INSERT INTO passkeys (id, account_id, credential_id, public_key, sign_count, transports, backed_up, name, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		p.accountId,
		p.credentialId,
		p.publicKey.slice().buffer,
		p.signCount,
		JSON.stringify(p.transports),
		p.backedUp ? 1 : 0,
		nullString(p.name),
		now
	);
	return id;
}

/** Records a passkey sign-in: the new signature counter, the backup state and the time. */
export function usePasskey(db: Db, id: string, signCount: number, backedUp: boolean, now: number): void {
	db.run('UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?', signCount, backedUp ? 1 : 0, now, id);
}

/** Deletes one of an account's passkeys; false when it has no such passkey. */
export function deletePasskey(db: Db, accountId: string, id: string): boolean {
	return db.run('DELETE FROM passkeys WHERE id = ? AND account_id = ?', id, accountId) > 0;
}

/** Short-lived sign-in state (auth_flows). */
export interface Flow {
	tokenHash: string;
	kind: string;
	email: string;
	accountId: string;
	secretHash: string;
	challenge: string;
	role: string;
	actorId: string;
	next: string;
	attempts: number;
	createdAt: number;
	expiresAt: number;
}

type FlowRow = {
	token_hash: string;
	kind: string;
	email: string;
	account_id: string;
	secret_hash: string;
	challenge: string;
	role: string;
	actor_id: string;
	next: string;
	attempts: number;
	created_at: number;
	expires_at: number;
};

const flowCols = `token_hash, kind, ifnull(email, '') AS email, ifnull(account_id, '') AS account_id, ifnull(secret_hash, '') AS secret_hash,
	ifnull(challenge, '') AS challenge, ifnull(role, '') AS role, ifnull(actor_id, '') AS actor_id, next, attempts, created_at, expires_at`;

const scanFlow = (r: FlowRow): Flow => ({
	tokenHash: r.token_hash,
	kind: r.kind,
	email: r.email,
	accountId: r.account_id,
	secretHash: r.secret_hash,
	challenge: r.challenge,
	role: r.role,
	actorId: r.actor_id,
	next: r.next,
	attempts: r.attempts,
	createdAt: r.created_at,
	expiresAt: r.expires_at
});

/** Stores a flow; a flow with the same token hash is replaced. */
export function putFlow(db: Db, f: Partial<Flow> & Pick<Flow, 'tokenHash' | 'kind' | 'createdAt' | 'expiresAt'>): void {
	db.run(
		`INSERT OR REPLACE INTO auth_flows (token_hash, kind, email, account_id, secret_hash, challenge, role, actor_id, next, attempts, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		f.tokenHash,
		f.kind,
		f.email || null,
		f.accountId || null,
		f.secretHash || null,
		f.challenge || null,
		f.role || null,
		f.actorId || null,
		f.next || '/account',
		f.createdAt,
		f.expiresAt
	);
}

/** An unexpired flow of a kind. */
export function getFlow(db: Db, tokenHash: string, kind: string, now: number): Flow | undefined {
	const r = db.get<FlowRow>(`SELECT ${flowCols} FROM auth_flows WHERE token_hash = ? AND kind = ? AND expires_at > ?`, tokenHash, kind, now);
	return r && scanFlow(r);
}

/**
 * Deletes an unexpired flow and returns it, in one statement: of two requests racing to use the
 * same challenge or invite, only one gets it back.
 */
export function takeFlow(db: Db, tokenHash: string, kind: string, now: number): Flow | undefined {
	const r = db.get<FlowRow>(`DELETE FROM auth_flows WHERE token_hash = ? AND kind = ? AND expires_at > ? RETURNING ${flowCols}`, tokenHash, kind, now);
	return r && scanFlow(r);
}

/** Counts a wrong code and returns the attempts so far. */
export function failFlow(db: Db, tokenHash: string): number {
	return db.get<{ attempts: number }>('UPDATE auth_flows SET attempts = attempts + 1 WHERE token_hash = ? RETURNING attempts', tokenHash)?.attempts ?? 0;
}

export function deleteFlow(db: Db, tokenHash: string): void {
	db.run('DELETE FROM auth_flows WHERE token_hash = ?', tokenHash);
}

/** A reviewer token's account and dates. */
export interface ReviewerToken {
	account: Account;
	expiresAt: number;
	lastUsedAt: number;
}

/** Replaces an account's reviewer token. */
export function setReviewerToken(db: Db, accountId: string, tokenHash: string, now: number, expires: number): void {
	db.run(
		`INSERT INTO reviewer_tokens (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (account_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at,
		expires_at = excluded.expires_at, last_used_at = NULL`,
		tokenHash,
		accountId,
		now,
		expires
	);
}

/** The reviewer token behind a hash, expired or not. */
export function reviewerToken(db: Db, tokenHash: string): ReviewerToken | undefined {
	const r = db.get<AccountRow & { expires_at: number; last_used_at: number }>(
		`SELECT ${accountCols}, ifnull(r.expires_at, 0) AS expires_at, ifnull(r.last_used_at, 0) AS last_used_at
		FROM reviewer_tokens r JOIN accounts a ON a.id = r.account_id WHERE r.token_hash = ?`,
		tokenHash
	);
	return r && { account: scanAccount(r)!, expiresAt: r.expires_at, lastUsedAt: r.last_used_at };
}

/** The dates of an account's reviewer token, or undefined. */
export function reviewerTokenOf(db: Db, accountId: string): { created_at: number; expires_at: number; last_used_at: number } | undefined {
	return db.get('SELECT created_at, ifnull(expires_at, 0) AS expires_at, ifnull(last_used_at, 0) AS last_used_at FROM reviewer_tokens WHERE account_id = ?', accountId);
}

/** Records use of a reviewer token, at most once an hour. */
export function touchReviewerToken(db: Db, tokenHash: string, t: ReviewerToken, now: number): void {
	if (now - t.lastUsedAt >= 3600) db.run('UPDATE reviewer_tokens SET last_used_at = ? WHERE token_hash = ?', now, tokenHash);
}

export function deleteReviewerToken(db: Db, accountId: string): boolean {
	return db.run('DELETE FROM reviewer_tokens WHERE account_id = ?', accountId) > 0;
}

/** An action held for a few days before it runs (account_requests). */
export interface HeldRequest {
	id: string;
	accountId: string;
	kind: 'delete' | 'export' | 'remove_passkey' | 'email_change';
	arg: string;
	actorId: string;
	createdAt: number;
	dueAt: number;
	doneAt: number;
}

type RequestRow = { id: string; account_id: string; kind: HeldRequest['kind']; arg: string; actor_id: string; created_at: number; due_at: number; done_at: number };
const requestCols = `id, account_id, kind, ifnull(arg, '') AS arg, ifnull(actor_id, '') AS actor_id, created_at, due_at, ifnull(done_at, 0) AS done_at`;
const scanRequest = (r: RequestRow): HeldRequest => ({
	id: r.id,
	accountId: r.account_id,
	kind: r.kind,
	arg: r.arg,
	actorId: r.actor_id,
	createdAt: r.created_at,
	dueAt: r.due_at,
	doneAt: r.done_at
});

/** Holds an action until dueAt; the cancel secret's hash cancels it. Returns its id. */
export function holdRequest(
	db: Db,
	r: { accountId: string; kind: HeldRequest['kind']; arg?: string; actorId?: string; cancelHash: string; dueAt: number },
	now: number
): string {
	const id = newId('req');
	db.run(
		`INSERT INTO account_requests (id, account_id, kind, arg, cancel_hash, actor_id, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		r.accountId,
		r.kind,
		r.arg || null,
		r.cancelHash,
		r.actorId || null,
		now,
		r.dueAt
	);
	return id;
}

/** The requests of an account that are still waiting, or ran in the last 7 days (a ready export). */
export function heldRequests(db: Db, accountId: string, now: number): HeldRequest[] {
	return db
		.all<RequestRow>(
			`SELECT ${requestCols} FROM account_requests
			WHERE account_id = ? AND cancelled_at IS NULL AND (done_at IS NULL OR done_at > ?) ORDER BY created_at`,
			accountId,
			now - 7 * 86_400
		)
		.map(scanRequest);
}

/** Cancels the request with this cancel hash; returns it, or undefined when nothing was waiting. */
export function cancelRequestByHash(db: Db, cancelHash: string, now: number): HeldRequest | undefined {
	const r = db.get<RequestRow>(
		`UPDATE account_requests SET cancelled_at = ? WHERE cancel_hash = ? AND done_at IS NULL AND cancelled_at IS NULL RETURNING ${requestCols}`,
		now,
		cancelHash
	);
	return r && scanRequest(r);
}

/** Cancels one of an account's waiting requests. */
export function cancelRequest(db: Db, accountId: string, id: string, now: number): HeldRequest | undefined {
	const r = db.get<RequestRow>(
		`UPDATE account_requests SET cancelled_at = ? WHERE id = ? AND account_id = ? AND done_at IS NULL AND cancelled_at IS NULL RETURNING ${requestCols}`,
		now,
		id,
		accountId
	);
	return r && scanRequest(r);
}

/** Cancels every waiting request of an account (a passkey sign-in does this) and returns them. */
export function cancelAllRequests(db: Db, accountId: string, now: number): HeldRequest[] {
	return db
		.all<RequestRow>(
			`UPDATE account_requests SET cancelled_at = ? WHERE account_id = ? AND done_at IS NULL AND cancelled_at IS NULL RETURNING ${requestCols}`,
			now,
			accountId
		)
		.map(scanRequest);
}

/** Waiting requests whose time has come. */
export function dueRequests(db: Db, now: number): HeldRequest[] {
	return db
		.all<RequestRow>(`SELECT ${requestCols} FROM account_requests WHERE done_at IS NULL AND cancelled_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50`, now)
		.map(scanRequest);
}

/** Marks a request done, unless it was cancelled meanwhile; false then. */
export function finishRequest(db: Db, id: string, now: number): boolean {
	return db.run('UPDATE account_requests SET done_at = ? WHERE id = ? AND done_at IS NULL AND cancelled_at IS NULL', now, id) > 0;
}

/**
 * Deletes an account and everything that hangs on it, in one transaction: sessions, passkeys,
 * flows, the reviewer token, held requests and its plan rows cascade; its sync blob goes; its
 * decisions and log entries lose their name, so the log shows a former reviewer; an
 * account_deleted audit row remains. Billing must have been settled with Stripe before.
 */
export function deleteAccount(db: Db, accountId: string, now: number, who: Omit<AuditEntry, 'action' | 'target'>): boolean {
	return db.tx(() => {
		if (!getAccount(db, accountId)) return false;
		db.run('DELETE FROM sync_blobs WHERE sub = ?', accountId);
		db.run('UPDATE decisions SET account_id = NULL, actor_name = NULL WHERE account_id = ?', accountId);
		db.run('UPDATE decision_log SET actor_name = NULL, account_id = NULL WHERE account_id = ?', accountId);
		db.run('UPDATE appeals SET resolved_by = NULL WHERE resolved_by = ?', accountId);
		db.run('DELETE FROM accounts WHERE id = ?', accountId);
		audit(db, { ...who, action: 'account_deleted', target: accountId }, now);
		return true;
	});
}
