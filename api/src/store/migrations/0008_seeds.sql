-- Seed lists from the registry (packages/shared/src/seed-registry.json, docs/contracts.md 14),
-- their expiry, revocation and suppression, and the blind calibration set.
-- Numbered 0008 so 0006 and 0007 stay free for work landing beside it: the runner applies any
-- version it has not applied yet, in order, and dumps name every version they hold.
-- Expand-then-contract: the sources.import_* columns of imports from before the registry stay,
-- unread; only registry entries in seed_entries put a source in the review queue.

-- seed_imports gains the registry entry each run read. For those runs, list holds the entry's use.
ALTER TABLE seed_imports ADD COLUMN seed TEXT;          -- registry id; NULL for runs from before the registry
ALTER TABLE seed_imports ADD COLUMN listed_at INTEGER;  -- the entry's upstream date, from which expiry counts
ALTER TABLE seed_imports ADD COLUMN added INTEGER;
ALTER TABLE seed_imports ADD COLUMN dropped INTEGER;
ALTER TABLE seed_imports ADD COLUMN records TEXT;       -- JSON of the private clearance records (DPIA, LIA, grant), staff only
ALTER TABLE seed_imports ADD COLUMN revoked_at INTEGER; -- revoke-seed deleted this run's entries
ALTER TABLE seed_imports ADD COLUMN revoke_reason TEXT;

-- What each registry entry lists now. A dropped, expired or revoked entry is deleted; the batch
-- rows above keep counts and the file hash for audits. Staff only: never in a public response.
CREATE TABLE seed_entries (
	seed      TEXT NOT NULL,    -- registry id
	platform  TEXT NOT NULL,
	alias     TEXT NOT NULL,    -- canonical ID as the file listed it (contracts 2.2)
	source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
	batch     INTEGER NOT NULL REFERENCES seed_imports (id),
	listed_at INTEGER NOT NULL, -- upstream date of the latest run that listed it
	note      TEXT,             -- for Colander's own lists, where staff saw it
	PRIMARY KEY (seed, platform, alias)
) STRICT, WITHOUT ROWID;
CREATE INDEX seed_entries_source ON seed_entries (source_id);

-- Staff suppressed seed lists on the source (a GDPR Article 21 objection, or a case they closed):
-- its entries are deleted and no import or calibration sample takes it again until they lift it.
ALTER TABLE sources ADD COLUMN seed_suppressed_at INTEGER;
ALTER TABLE sources ADD COLUMN seed_suppress_reason TEXT;

-- The calibration set: sources sampled from a frame and labeled blind.
CREATE TABLE calibration_items (
	source_id  INTEGER PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
	frame      TEXT NOT NULL,    -- seed:<id> | community | random:<id>
	sampled_at INTEGER NOT NULL
) STRICT;
CREATE TABLE calibration_labels (
	source_id  INTEGER NOT NULL REFERENCES calibration_items (source_id) ON DELETE CASCADE,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	label      TEXT NOT NULL,              -- slop | ai_not_slop | not_ai | gone | unsure
	tests      INTEGER NOT NULL DEFAULT 0, -- test bits the labeler found
	evidence   INTEGER NOT NULL DEFAULT 0, -- provenance signal bits the labeler saw on the platform
	note       TEXT,
	language   TEXT,                       -- what the source is in: a code of CALIBRATION_LANGUAGES; NULL for gone and unsure
	kind       TEXT,                       -- music | video; NULL for gone and unsure
	labeled_at INTEGER NOT NULL,
	PRIMARY KEY (source_id, account_id)
) STRICT;

-- Staff reads of which seed lists name a source (seed list review 30): who, which source as it
-- was named then, which registry IDs they saw, and when. Staff only, never in a response; the
-- daily seeds job deletes rows after 24 months, like the calibration rows.
CREATE TABLE seed_provenance_reads (
	account_id TEXT NOT NULL,
	platform   TEXT NOT NULL,
	source     TEXT NOT NULL,    -- the canonical ID at the time of the read
	seeds      TEXT NOT NULL,    -- JSON array of registry IDs
	read_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX seed_provenance_reads_at ON seed_provenance_reads (read_at);
