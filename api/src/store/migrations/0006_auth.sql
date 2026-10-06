-- Sign-in by emailed code and passkeys, roles with a fixed permission table, the admin host and
-- one insert-only audit log (docs/contracts.md 6.1, 6.6 and 6.9). Expand only: magic_links stays
-- until no running version reads it. The data changes that need the clock are in
-- src/store/migrations.ts (authData), so they also run on the rows of an older dump that is
-- restored.

-- The four roles, enforced in the database too: role has no CHECK constraint (0001), so triggers
-- refuse any other value on insert and update.
CREATE TRIGGER accounts_role_insert BEFORE INSERT ON accounts
WHEN NEW.role NOT IN ('member', 'curator', 'staff', 'admin')
BEGIN SELECT RAISE(ABORT, 'invalid role'); END;
CREATE TRIGGER accounts_role_update BEFORE UPDATE OF role ON accounts
WHEN NEW.role NOT IN ('member', 'curator', 'staff', 'admin')
BEGIN SELECT RAISE(ABORT, 'invalid role'); END;

-- The A3T Identity subject a staff or admin account is bound to, pinned on its first sign-in on
-- the admin host through Cloudflare Access. A token with another subject is refused after that.
ALTER TABLE accounts ADD COLUMN access_subject TEXT;
CREATE UNIQUE INDEX accounts_access_subject ON accounts (access_subject) WHERE access_subject IS NOT NULL;

CREATE TABLE passkeys (
	id            TEXT PRIMARY KEY,                -- pk_...
	account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	credential_id TEXT NOT NULL UNIQUE,            -- base64url
	public_key    BLOB NOT NULL,                   -- COSE key
	sign_count    INTEGER NOT NULL DEFAULT 0,
	transports    TEXT,                            -- JSON array
	backed_up     INTEGER NOT NULL DEFAULT 0,
	name          TEXT,
	created_at    INTEGER NOT NULL,
	last_used_at  INTEGER
) STRICT;
CREATE INDEX passkeys_account ON passkeys (account_id);

-- Short-lived sign-in state: email codes, WebAuthn challenges and passkey invites.
CREATE TABLE auth_flows (
	token_hash  TEXT PRIMARY KEY,  -- SHA-256 of the flow cookie, or of the invite secret
	kind        TEXT NOT NULL,     -- email_code | passkey | register | invite
	email       TEXT,
	account_id  TEXT REFERENCES accounts (id) ON DELETE CASCADE,
	secret_hash TEXT,              -- email_code: SHA-256(flow token + code); register: the invite's token_hash
	challenge   TEXT,              -- base64url WebAuthn challenge
	role        TEXT,              -- invite: the account's role when it was issued
	actor_id    TEXT,              -- invite: who issued it
	next        TEXT NOT NULL DEFAULT '/account',
	attempts    INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX auth_flows_expires ON auth_flows (expires_at);

-- How each session signed in. A session is a passkey session while passkey_id is set: removing the
-- passkey demotes it. legacy marks sessions from before this migration, the only ones whose old
-- colander_session cookie is still read and moved to the __Host- name.
ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'email'; -- email | passkey
ALTER TABLE sessions ADD COLUMN authenticated_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN passkey_id TEXT REFERENCES passkeys (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;

ALTER TABLE reviewer_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE reviewer_tokens ADD COLUMN last_used_at INTEGER;

-- Internal and never published: whose decision a log entry records, so deleting an account can
-- remove the name. Earlier entries take it from the decision or the appeal they record.
ALTER TABLE decision_log ADD COLUMN account_id TEXT;

-- Actions an account asked for with only an email code while it holds a passkey, held for 72
-- hours (an email change by support: 7 days). The cancel link in the email, or any passkey
-- sign-in, cancels them.
CREATE TABLE account_requests (
	id           TEXT PRIMARY KEY,  -- req_...
	account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	kind         TEXT NOT NULL,     -- delete | export | remove_passkey | email_change
	arg          TEXT,              -- remove_passkey: the passkey id; email_change: the new address
	cancel_hash  TEXT NOT NULL UNIQUE,
	actor_id     TEXT,              -- email_change: the admin who made it
	created_at   INTEGER NOT NULL,
	due_at       INTEGER NOT NULL,
	done_at      INTEGER,
	cancelled_at INTEGER
) STRICT;
CREATE INDEX account_requests_due ON account_requests (due_at) WHERE done_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX account_requests_account ON account_requests (account_id);

-- The one audit log: sign-ins, credential and role changes, staff and ops actions, and reads of
-- personal data. Insert-only: rows can be deleted only once they are past the 400-day retention,
-- and a copy goes to R2 every day.
CREATE TABLE audit_log (
	id          INTEGER PRIMARY KEY,
	at          INTEGER NOT NULL,
	actor_id    TEXT,  -- the account that acted; null for the person themselves when target is their account, or for ops
	actor_sub   TEXT,  -- a3t:<subject>, github:<login> or otp:<email hash>, when known
	actor_email TEXT,  -- staff only, from Cloudflare Access
	host        TEXT NOT NULL, -- main | admin | ops | job
	action      TEXT NOT NULL,
	target      TEXT,  -- usually an account ID
	before      TEXT,
	after       TEXT,
	reason      TEXT,
	request_id  TEXT   -- the cf-ray, or the GitHub run ID
) STRICT;
CREATE INDEX audit_log_target ON audit_log (target, id);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'the audit log is insert-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN OLD.at > unixepoch() - 400 * 86400
BEGIN SELECT RAISE(ABORT, 'the audit log is insert-only'); END;
