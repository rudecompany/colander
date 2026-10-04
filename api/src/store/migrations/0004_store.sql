-- Tables the Go server kept in process memory, now persisted in the Store.
-- 0001 to 0003 are byte-identical copies of server/internal/store/migrations, so data dumps load
-- either way. Every later change is expand-then-contract: add first, remove only after no running
-- version reads it.

-- Token buckets for the exact quotas (contracts 6.2 to 6.8), one row per limiter and key.
-- Keys are install, email or IP hashes, never raw identifiers. Taken in the same transaction
-- as the write they guard.
CREATE TABLE limits (
	name   TEXT NOT NULL,    -- the limiter, for example tags_minute
	key    TEXT NOT NULL,
	tokens REAL NOT NULL,    -- tokens left after the last refill
	at     INTEGER NOT NULL, -- unix milliseconds of the last refill
	PRIMARY KEY (name, key)
) STRICT, WITHOUT ROWID;

-- Work driven by the Store's single alarm: the scoring pass, debounced rescores, list
-- publication, dumps and pruning. One row per job; the alarm is set to the earliest due_at.
CREATE TABLE jobs (
	name   TEXT PRIMARY KEY,
	due_at INTEGER NOT NULL  -- unix milliseconds
) STRICT;
