-- Colander core schema. Times are unix seconds (UTC).
-- Install IDs are never stored raw, only hex(SHA-256("colander-install:" + id)).

CREATE TABLE installs (
	hash         TEXT PRIMARY KEY,
	created_at   INTEGER NOT NULL,
	first_tag_at INTEGER
) STRICT;

-- A source is a channel, profile or page. Verdict columns hold the current list state.
CREATE TABLE sources (
	id                 INTEGER PRIMARY KEY,
	platform           TEXT NOT NULL,
	canonical_id       TEXT NOT NULL,
	name               TEXT,
	import_list        TEXT,    -- blocklist | warnlist, for imported seed entries
	import_source      TEXT,    -- attribution, for example "AiSList"
	import_license     TEXT,    -- for example "CC BY-NC 4.0"
	imported_at        INTEGER,
	reviewed_at        INTEGER, -- latest staff or curator decision on the source
	large_staff        INTEGER NOT NULL DEFAULT 0,
	subscribers        INTEGER,
	uploads_per_day    REAL,
	youtube_checked_at INTEGER,
	frozen_until       INTEGER, -- burst detection freezes the consensus layer until then
	verdict            TEXT,
	signals            INTEGER NOT NULL DEFAULT 0,
	detail             INTEGER NOT NULL DEFAULT 0,
	flags              INTEGER NOT NULL DEFAULT 0,
	changed_at         INTEGER,
	rescore_at         INTEGER,
	lapse_hold         INTEGER NOT NULL DEFAULT 0,
	computed           TEXT,    -- what scoring alone says, ignoring appeals and decisions
	created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX sources_verdict ON sources (verdict);
CREATE INDEX sources_youtube ON sources (platform, youtube_checked_at);

CREATE TABLE source_aliases (
	platform  TEXT NOT NULL,
	alias     TEXT NOT NULL,
	source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	PRIMARY KEY (platform, alias)
) STRICT, WITHOUT ROWID;
CREATE INDEX source_aliases_source ON source_aliases (source_id);

CREATE TABLE items (
	id         INTEGER PRIMARY KEY,
	platform   TEXT NOT NULL,
	item_id    TEXT NOT NULL,
	source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	verdict    TEXT,
	signals    INTEGER NOT NULL DEFAULT 0,
	detail     INTEGER NOT NULL DEFAULT 0,
	flags      INTEGER NOT NULL DEFAULT 0,
	changed_at INTEGER,
	rescore_at INTEGER,
	lapse_hold INTEGER NOT NULL DEFAULT 0,
	computed   TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (platform, item_id)
) STRICT;
CREATE INDEX items_source ON items (source_id);
CREATE INDEX items_verdict ON items (verdict);

-- One row per install and target: a later tag replaces the earlier one.
CREATE TABLE tags (
	install_hash   TEXT NOT NULL REFERENCES installs (hash),
	platform       TEXT NOT NULL,
	target_type    TEXT NOT NULL,
	target_id      TEXT NOT NULL,
	source_id      INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	item_id        INTEGER REFERENCES items (id) ON DELETE CASCADE,
	client_id      TEXT NOT NULL,
	verdict        TEXT NOT NULL,
	slop_type      TEXT,
	tests          INTEGER NOT NULL DEFAULT 0,
	platform_label INTEGER NOT NULL DEFAULT 0,
	created_at     INTEGER NOT NULL,
	received_at    INTEGER NOT NULL,
	ext_version    TEXT,
	PRIMARY KEY (install_hash, platform, target_type, target_id)
) STRICT;
CREATE INDEX tags_source ON tags (source_id);

CREATE TABLE accounts (
	id           TEXT PRIMARY KEY,
	email        TEXT NOT NULL UNIQUE,
	display_name TEXT,
	role         TEXT NOT NULL DEFAULT 'member',
	created_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE magic_links (
	token_hash TEXT PRIMARY KEY,
	email      TEXT NOT NULL,
	next       TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at    INTEGER
) STRICT;

CREATE TABLE reviewer_tokens (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE reports (
	id           TEXT PRIMARY KEY,
	install_hash TEXT NOT NULL REFERENCES installs (hash),
	client_id    TEXT NOT NULL,
	platform     TEXT NOT NULL,
	source_id    INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	reported_id  TEXT NOT NULL,
	source_name  TEXT,
	examples     TEXT NOT NULL DEFAULT '[]',
	reason       TEXT NOT NULL,
	slop_type    TEXT,
	tests        INTEGER NOT NULL DEFAULT 0,
	ext_version  TEXT,
	status       TEXT NOT NULL DEFAULT 'open', -- open | decided | dismissed
	verdict      TEXT,
	close_reason TEXT,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL,
	UNIQUE (install_hash, client_id)
) STRICT;
CREATE INDEX reports_install ON reports (install_hash, created_at);
CREATE INDEX reports_source ON reports (source_id, status);

CREATE TABLE appeals (
	id          TEXT PRIMARY KEY,
	platform    TEXT NOT NULL,
	source_id   INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	email       TEXT NOT NULL,
	statement   TEXT NOT NULL,
	code        TEXT NOT NULL,
	secret_hash TEXT NOT NULL,
	status      TEXT NOT NULL,
	outcome     TEXT,
	reasoning   TEXT,
	resolved_by TEXT REFERENCES accounts (id),
	created_at  INTEGER NOT NULL,
	verified_at INTEGER,
	resolved_at INTEGER
) STRICT;
CREATE INDEX appeals_source ON appeals (source_id, status);
CREATE INDEX appeals_status ON appeals (status, created_at);

-- Staff, curator and appeal decisions. A decision applies until expires_at (its rescore_at).
CREATE TABLE decisions (
	id         INTEGER PRIMARY KEY,
	source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	item_id    INTEGER REFERENCES items (id) ON DELETE CASCADE,
	verdict    TEXT NOT NULL, -- a verdict, or none
	reason     TEXT NOT NULL,
	signals    INTEGER NOT NULL DEFAULT 0,
	detail     INTEGER NOT NULL DEFAULT 0,
	actor      TEXT NOT NULL, -- curator | staff | appeal
	account_id TEXT REFERENCES accounts (id),
	actor_name TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX decisions_target ON decisions (source_id, item_id, id);

-- The public decision log. Every verdict change writes one row.
CREATE TABLE decision_log (
	id           INTEGER PRIMARY KEY,
	at           INTEGER NOT NULL,
	platform     TEXT NOT NULL,
	target_type  TEXT NOT NULL,
	target_id    TEXT NOT NULL,
	source_id    INTEGER REFERENCES sources (id) ON DELETE SET NULL,
	source_key   TEXT NOT NULL,
	source_name  TEXT,
	from_verdict TEXT,
	to_verdict   TEXT,
	reason       TEXT NOT NULL,
	signals      INTEGER NOT NULL DEFAULT 0,
	actor        TEXT NOT NULL,
	actor_name   TEXT
) STRICT;
CREATE INDEX decision_log_source ON decision_log (source_id, id);
CREATE INDEX decision_log_at ON decision_log (at);

CREATE TABLE escalations (
	id          INTEGER PRIMARY KEY,
	source_id   INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	item_id     INTEGER REFERENCES items (id) ON DELETE CASCADE,
	kind        TEXT NOT NULL, -- capped | lapsed | reports | burst
	summary     TEXT NOT NULL,
	created_at  INTEGER NOT NULL,
	resolved_at INTEGER
) STRICT;
CREATE UNIQUE INDEX escalations_open ON escalations (source_id, ifnull(item_id, 0), kind) WHERE resolved_at IS NULL;

-- The published list: current entries, and every change per sequence for deltas.
CREATE TABLE list_sequences (
	seq        INTEGER PRIMARY KEY,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE list_entries (
	hash       BLOB PRIMARY KEY,
	entry      BLOB NOT NULL,
	target_key TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE list_changes (
	seq   INTEGER NOT NULL REFERENCES list_sequences (seq) ON DELETE CASCADE,
	hash  BLOB NOT NULL,
	entry BLOB NOT NULL,
	PRIMARY KEY (seq, hash)
) STRICT, WITHOUT ROWID;

-- Anonymous list request counts per UTC hour (contracts 9.6).
CREATE TABLE list_requests (
	hour  INTEGER PRIMARY KEY,
	count INTEGER NOT NULL
) STRICT;

CREATE TABLE adapter_configs (
	id         INTEGER PRIMARY KEY,
	version    INTEGER NOT NULL,
	envelope   TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE trials (
	install_hash TEXT PRIMARY KEY REFERENCES installs (hash),
	sub          TEXT NOT NULL UNIQUE,
	issued_at    INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE sync_blobs (
	sub        TEXT PRIMARY KEY,
	version    INTEGER NOT NULL,
	data       TEXT NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE youtube_cache (
	key        TEXT PRIMARY KEY,
	body       BLOB NOT NULL,
	fetched_at INTEGER NOT NULL
) STRICT;
