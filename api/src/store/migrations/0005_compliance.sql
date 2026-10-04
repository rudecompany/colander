-- Compliance with the YouTube API Services Developer Policies and the seed list review.
-- Expand-then-contract: sources.subscribers and sources.uploads_per_day stay, nulled and unread.

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
CREATE INDEX youtube_cache_fetched ON youtube_cache (fetched_at);

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
	license        TEXT NOT NULL,    -- CC0-1.0 | CC-BY-4.0 | MIT | LicenseRef-written-grant
	attribution    TEXT,             -- the credit the license asks for
	permission_doc TEXT,             -- where the written grant is kept, for LicenseRef-written-grant
	sha256         TEXT NOT NULL,    -- hex, of the imported file
	entries        INTEGER NOT NULL,
	imported_at    INTEGER NOT NULL
) STRICT;
-- The checked import that last listed the source; null for imports from before the license check,
-- which raise no review lead.
ALTER TABLE sources ADD COLUMN import_batch INTEGER REFERENCES seed_imports (id);

-- Staff only and never published: a log reason as written, before it was redacted.
ALTER TABLE decision_log ADD COLUMN reason_original TEXT;

-- The scoring pass named the seed list in public reasons ("Listed on the X seed list, ..."). The
-- name goes; the fact that the verdict rested on an imported list stays.
UPDATE decision_log SET
	reason_original = reason,
	reason = substr(reason, 1, instr(reason, 'isted on the ') - 1) || 'isted on an imported seed list' ||
		substr(reason, instr(reason, 'isted on the ') + instr(substr(reason, instr(reason, 'isted on the ')), ' seed list') + 9)
WHERE actor IN ('community', 'appeal')
	AND instr(reason, 'isted on the ') > 0
	AND instr(substr(reason, instr(reason, 'isted on the ')), ' seed list') > 0;

-- Names come from reports or, for YouTube, from the Data API. A name no report on the source gave
-- is the API title, which may not be kept past 30 days: it goes from the source and its log rows.
UPDATE decision_log SET source_name = NULL
WHERE source_name IS NOT NULL
	AND source_id IN (SELECT id FROM sources WHERE youtube_checked_at IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.source_id = decision_log.source_id AND r.source_name = decision_log.source_name);
UPDATE sources SET name = NULL
WHERE name IS NOT NULL
	AND youtube_checked_at IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.source_id = sources.id AND r.source_name = sources.name);

-- The API figures go too; every YouTube source is looked up again at the bounded rate.
UPDATE sources SET subscribers = NULL, uploads_per_day = NULL, youtube_checked_at = NULL
WHERE subscribers IS NOT NULL OR uploads_per_day IS NOT NULL OR youtube_checked_at IS NOT NULL;
