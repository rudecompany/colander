-- When staff last recorded a source's size (large or not). Without it, and without a YouTube Data
-- API subscriber count, the audience size is unknown and rule 6 holds Slop at Likely slop (9.4).
ALTER TABLE sources ADD COLUMN size_reviewed_at INTEGER;

-- A mixed source (9.4): its items keep their own list entries even when they match its verdict.
ALTER TABLE sources ADD COLUMN mixed INTEGER NOT NULL DEFAULT 0;
