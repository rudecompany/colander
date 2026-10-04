-- Compliance with the YouTube API Services Developer Policies and the seed list review.
-- Expand-then-contract: sources.subscribers and sources.uploads_per_day stay, nulled and unread.
-- The data changes (seed list names out of the public log, imports from before the license check,
-- stored YouTube API titles and figures) are in src/store/compliance.ts, because they rewrite
-- text; a restore of a dump taken before this migration runs them again.

-- YouTube Data API figures, apart from Colander's own data so they can be deleted whole. They are
-- written only while YOUTUBE_DERIVED_USE is on, the hourly prune deletes rows before they are 30
-- days old (Developer Policies III.E.4), and dumps never hold their rows, so no backup keeps them.
CREATE TABLE youtube_channels (
	source_id       INTEGER PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
	subscribers     INTEGER, -- null when the channel hides it
	uploads_per_day REAL,
	fetched_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX youtube_channels_fetched ON youtube_channels (fetched_at);

-- Nothing reads or writes the response cache any more, so the API data it holds goes now. The
-- table stays for older code until a later migration drops it.
DELETE FROM youtube_cache;

-- YouTube Data API units charged per Pacific day, before each call (the quota resets at midnight
-- Pacific Time).
CREATE TABLE youtube_quota (
	day   TEXT PRIMARY KEY, -- YYYY-MM-DD in America/Los_Angeles
	units INTEGER NOT NULL
) STRICT;

-- Every run of the import-seed ops command, for audits. Staff only: public pages never name a list.
CREATE TABLE seed_imports (
	id             INTEGER PRIMARY KEY,
	source_name    TEXT NOT NULL,
	list           TEXT NOT NULL,    -- blocklist | warnlist
	license        TEXT NOT NULL,    -- CC0-1.0 | CC-BY-4.0 | MIT | LicenseRef-written-grant, or as an old import recorded it
	attribution    TEXT,             -- the credit the license asks for
	permission_doc TEXT,             -- where the written grant is kept, for LicenseRef-written-grant
	sha256         TEXT NOT NULL,    -- hex, of the imported file (of the cleared IDs, see cleared_at)
	entries        INTEGER NOT NULL,
	imported_at    INTEGER NOT NULL,
	-- An import from before the license check, whose entries were cleared then: this row keeps only
	-- their count and a hash of their IDs (sha256), for audits.
	cleared_at     INTEGER
) STRICT;
-- The checked import that last listed the source. Entries of imports from before the license check
-- are cleared (src/store/compliance.ts).
ALTER TABLE sources ADD COLUMN import_batch INTEGER REFERENCES seed_imports (id);

-- Staff only and never published: a log reason as written, before it was redacted.
ALTER TABLE decision_log ADD COLUMN reason_original TEXT;
