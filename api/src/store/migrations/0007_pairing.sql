-- Pairing codes (contracts 7): the website shows a short code to a signed-in account, and the
-- extension that takes it gets a plan token or a reviewer token. Codes are stored only as SHA-256,
-- last 10 minutes and work once. The hourly prune deletes them an hour after they expire.
CREATE TABLE pairings (
	id          TEXT PRIMARY KEY,
	account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	kind        TEXT NOT NULL CHECK (kind IN ('plan', 'reviewer')),
	code_hash   TEXT NOT NULL UNIQUE,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER NOT NULL,
	claimed_at  INTEGER,
	ext_version TEXT,
	browser     TEXT
) STRICT;
CREATE INDEX pairings_account ON pairings (account_id, kind);
CREATE INDEX pairings_expires ON pairings (expires_at);
