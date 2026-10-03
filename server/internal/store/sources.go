package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// State is the current list state of a source or item.
type State struct {
	Verdict   string // "" when not rated
	Signals   uint16
	Detail    uint8 // slop type code and test bits, as in a list entry
	Flags     uint8 // list flag bits for large, imported, staff reviewed
	ChangedAt int64
	RescoreAt int64
	LapseHold bool
	Computed  string
	Mixed     bool // sources only: the source is mixed, so its items keep their own list entries
}

// Source is a channel, profile or page. The source with an empty canonical ID on a platform holds
// the items tagged where the card does not show their source; it is never rated and nothing rolls
// up to it (contracts 6.2).
type Source struct {
	Ref              int64
	Platform         string
	CanonicalID      string
	Name             string
	Aliases          []string
	ImportList       string
	ImportSource     string
	ImportLicense    string
	ImportedAt       int64
	ReviewedAt       int64
	LargeStaff       bool
	SizeReviewedAt   int64 // when staff last recorded the source's size, 0 when never
	Subscribers      sql.NullInt64
	UploadsPerDay    sql.NullFloat64
	YouTubeCheckedAt int64
	FrozenUntil      int64
	State            State
	CreatedAt        int64
}

// Item is a video, Short, Reel or image post.
type Item struct {
	Ref       int64
	Platform  string
	ItemID    string
	SourceRef int64
	State     State
	CreatedAt int64
}

const sourceCols = `id, platform, canonical_id, ifnull(name, ''), ifnull(import_list, ''), ifnull(import_source, ''),
	ifnull(import_license, ''), ifnull(imported_at, 0), ifnull(reviewed_at, 0), large_staff, ifnull(size_reviewed_at, 0),
	subscribers, uploads_per_day, ifnull(youtube_checked_at, 0), ifnull(frozen_until, 0), ifnull(verdict, ''), signals, detail,
	flags, ifnull(changed_at, 0), ifnull(rescore_at, 0), lapse_hold, ifnull(computed, ''), mixed, created_at`

func scanSource(row interface{ Scan(...any) error }) (*Source, error) {
	var s Source
	err := row.Scan(&s.Ref, &s.Platform, &s.CanonicalID, &s.Name, &s.ImportList, &s.ImportSource, &s.ImportLicense,
		&s.ImportedAt, &s.ReviewedAt, &s.LargeStaff, &s.SizeReviewedAt, &s.Subscribers, &s.UploadsPerDay, &s.YouTubeCheckedAt,
		&s.FrozenUntil, &s.State.Verdict, &s.State.Signals, &s.State.Detail, &s.State.Flags, &s.State.ChangedAt,
		&s.State.RescoreAt, &s.State.LapseHold, &s.State.Computed, &s.State.Mixed, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &s, err
}

const itemCols = `id, platform, item_id, source_id, ifnull(verdict, ''), signals, detail, flags,
	ifnull(changed_at, 0), ifnull(rescore_at, 0), lapse_hold, ifnull(computed, ''), created_at`

func scanItem(row interface{ Scan(...any) error }) (*Item, error) {
	var it Item
	err := row.Scan(&it.Ref, &it.Platform, &it.ItemID, &it.SourceRef, &it.State.Verdict, &it.State.Signals,
		&it.State.Detail, &it.State.Flags, &it.State.ChangedAt, &it.State.RescoreAt, &it.State.LapseHold,
		&it.State.Computed, &it.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &it, err
}

// FindSource returns the source ref that owns alias on platform.
func (s *Store) FindSource(ctx context.Context, platform, alias string) (int64, error) {
	return findSource(ctx, s.DB, platform, alias)
}

func findSource(ctx context.Context, q querier, platform, alias string) (int64, error) {
	var ref int64
	err := q.QueryRowContext(ctx, `SELECT source_id FROM source_aliases WHERE platform = ? AND alias = ?`, platform, alias).Scan(&ref)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return ref, err
}

// ensureSource returns the source owning alias, creating it when unknown. A non-empty name fills a missing one.
func ensureSource(ctx context.Context, q querier, platform, alias, name string, now int64) (int64, error) {
	ref, err := findSource(ctx, q, platform, alias)
	if errors.Is(err, ErrNotFound) {
		res, err := q.ExecContext(ctx, `INSERT INTO sources (platform, canonical_id, name, created_at) VALUES (?, ?, ?, ?)`,
			platform, alias, nullString(name), now)
		if err != nil {
			return 0, err
		}
		ref, _ = res.LastInsertId()
		_, err = q.ExecContext(ctx, `INSERT INTO source_aliases (platform, alias, source_id) VALUES (?, ?, ?)`, platform, alias, ref)
		return ref, err
	}
	if err != nil {
		return 0, err
	}
	if name != "" {
		_, err = q.ExecContext(ctx, `UPDATE sources SET name = ? WHERE id = ? AND name IS NULL`, name, ref)
	}
	return ref, err
}

// EnsureSource is ensureSource outside a transaction.
func (s *Store) EnsureSource(ctx context.Context, platform, alias, name string, now int64) (int64, error) {
	return ensureSource(ctx, s.DB, platform, alias, name, now)
}

// GetSource loads a source with its aliases.
func (s *Store) GetSource(ctx context.Context, ref int64) (*Source, error) {
	src, err := scanSource(s.DB.QueryRowContext(ctx, `SELECT `+sourceCols+` FROM sources WHERE id = ?`, ref))
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT alias FROM source_aliases WHERE source_id = ? ORDER BY alias`, ref)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		src.Aliases = append(src.Aliases, a)
	}
	// The canonical ID leads the alias list.
	for i, a := range src.Aliases {
		if a == src.CanonicalID {
			src.Aliases[0], src.Aliases[i] = src.Aliases[i], src.Aliases[0]
		}
	}
	return src, rows.Err()
}

// SourceRefs lists every source ref, oldest first.
func (s *Store) SourceRefs(ctx context.Context) ([]int64, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id FROM sources ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var refs []int64
	for rows.Next() {
		var r int64
		if err := rows.Scan(&r); err != nil {
			return nil, err
		}
		refs = append(refs, r)
	}
	return refs, rows.Err()
}

// ensureItem returns the item, creating it under sourceRef when unknown. An item keeps its first
// source, except that an item first seen without one joins the first source a later tag names.
func ensureItem(ctx context.Context, q querier, platform, itemID string, sourceRef, now int64) (int64, error) {
	var ref, cur int64
	var unattributed bool
	err := q.QueryRowContext(ctx, `SELECT i.id, i.source_id, s.canonical_id = '' FROM items i JOIN sources s ON s.id = i.source_id
		WHERE i.platform = ? AND i.item_id = ?`, platform, itemID).Scan(&ref, &cur, &unattributed)
	if err == nil {
		if unattributed && cur != sourceRef {
			for _, stmt := range []string{
				`UPDATE items SET source_id = ? WHERE id = ?`,
				`UPDATE tags SET source_id = ? WHERE item_id = ?`,
				`UPDATE decisions SET source_id = ? WHERE item_id = ?`,
				`UPDATE OR IGNORE escalations SET source_id = ? WHERE item_id = ?`,
			} {
				if _, err := q.ExecContext(ctx, stmt, sourceRef, ref); err != nil {
					return 0, err
				}
			}
		}
		return ref, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	res, err := q.ExecContext(ctx, `INSERT INTO items (platform, item_id, source_id, created_at) VALUES (?, ?, ?, ?)`,
		platform, itemID, sourceRef, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// EnsureItem is ensureItem outside a transaction.
func (s *Store) EnsureItem(ctx context.Context, platform, itemID string, sourceRef, now int64) (int64, error) {
	return ensureItem(ctx, s.DB, platform, itemID, sourceRef, now)
}

// FindItem looks an item up by its platform ID.
func (s *Store) FindItem(ctx context.Context, platform, itemID string) (*Item, error) {
	return scanItem(s.DB.QueryRowContext(ctx, `SELECT `+itemCols+` FROM items WHERE platform = ? AND item_id = ?`, platform, itemID))
}

// ItemsBySource lists a source's items, oldest first.
func (s *Store) ItemsBySource(ctx context.Context, sourceRef int64) ([]Item, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+itemCols+` FROM items WHERE source_id = ? ORDER BY id`, sourceRef)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

// mergeSources moves everything from drop onto keep and deletes drop.
func mergeSources(ctx context.Context, tx *sql.Tx, keep, drop int64) error {
	for _, stmt := range []string{
		`UPDATE source_aliases SET source_id = ? WHERE source_id = ?`,
		`UPDATE items SET source_id = ? WHERE source_id = ?`,
		`UPDATE tags SET source_id = ? WHERE source_id = ?`,
		`UPDATE reports SET source_id = ? WHERE source_id = ?`,
		`UPDATE appeals SET source_id = ? WHERE source_id = ?`,
		`UPDATE decisions SET source_id = ? WHERE source_id = ?`,
		`UPDATE decision_log SET source_id = ? WHERE source_id = ?`,
		`UPDATE OR IGNORE escalations SET source_id = ? WHERE source_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, stmt, keep, drop); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE sources SET
		name = coalesce(sources.name, d.name),
		import_list = CASE WHEN 'blocklist' IN (sources.import_list, d.import_list) THEN 'blocklist'
			ELSE coalesce(sources.import_list, d.import_list) END,
		import_source = coalesce(sources.import_source, d.import_source),
		import_license = coalesce(sources.import_license, d.import_license),
		imported_at = coalesce(sources.imported_at, d.imported_at),
		reviewed_at = max(ifnull(sources.reviewed_at, 0), ifnull(d.reviewed_at, 0)),
		large_staff = max(sources.large_staff, d.large_staff),
		size_reviewed_at = max(ifnull(sources.size_reviewed_at, 0), ifnull(d.size_reviewed_at, 0)),
		frozen_until = max(ifnull(sources.frozen_until, 0), ifnull(d.frozen_until, 0))
		FROM (SELECT * FROM sources WHERE id = ?) AS d WHERE sources.id = ?`, drop, keep)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM sources WHERE id = ?`, drop)
	return err
}

// YouTubeInfo is what the Data API told us about a channel.
type YouTubeInfo struct {
	ChannelID     string
	Handle        string // with @, lowercased, or ""
	Title         string
	Subscribers   sql.NullInt64
	UploadsPerDay sql.NullFloat64
}

// SetYouTube records channel data for ref, adds the channel ID and handle as aliases and merges any
// other source that already owned one of them. It returns the ref that survives.
func (s *Store) SetYouTube(ctx context.Context, ref int64, info YouTubeInfo, now int64) (int64, error) {
	keep := ref
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		for _, alias := range []string{info.ChannelID, strings.ToLower(info.Handle)} {
			if alias == "" {
				continue
			}
			owner, err := findSource(ctx, tx, "yt", alias)
			switch {
			case errors.Is(err, ErrNotFound):
				if _, err := tx.ExecContext(ctx, `INSERT INTO source_aliases (platform, alias, source_id) VALUES ('yt', ?, ?)`, alias, keep); err != nil {
					return err
				}
			case err != nil:
				return err
			case owner != keep:
				// The older source keeps its history; the newer one folds into it.
				k, d := min(owner, keep), max(owner, keep)
				if err := mergeSources(ctx, tx, k, d); err != nil {
					return err
				}
				keep = k
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE sources SET canonical_id = ?, name = coalesce(name, ?), subscribers = ?,
			uploads_per_day = ?, youtube_checked_at = ? WHERE id = ?`,
			info.ChannelID, nullString(info.Title), info.Subscribers, info.UploadsPerDay, now, keep)
		return err
	})
	return keep, err
}

// MarkYouTubeChecked records a lookup that found nothing, so it is not retried before the cache expires.
func (s *Store) MarkYouTubeChecked(ctx context.Context, ref, now int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE sources SET youtube_checked_at = ? WHERE id = ?`, now, ref)
	return err
}

// YouTubeStale lists YouTube sources not checked since before, oldest first.
func (s *Store) YouTubeStale(ctx context.Context, before int64, limit int) ([]Source, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id FROM sources WHERE platform = 'yt' AND canonical_id != ''
		AND ifnull(youtube_checked_at, 0) < ? ORDER BY ifnull(youtube_checked_at, 0), id LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	var refs []int64
	for rows.Next() {
		var r int64
		if err := rows.Scan(&r); err != nil {
			rows.Close()
			return nil, err
		}
		refs = append(refs, r)
	}
	rows.Close()
	out := make([]Source, 0, len(refs))
	for _, r := range refs {
		src, err := s.GetSource(ctx, r)
		if err != nil {
			return nil, err
		}
		out = append(out, *src)
	}
	return out, nil
}

// ImportSeed records alias as an imported seed entry with its attribution and license.
// A blocklist import is never weakened by a later warnlist import.
func (s *Store) ImportSeed(ctx context.Context, platform, alias, list, sourceName, license string, now int64) (int64, error) {
	var ref int64
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		var err error
		ref, err = ensureSource(ctx, tx, platform, alias, "", now)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE sources SET
			import_list = CASE WHEN import_list = 'blocklist' THEN 'blocklist' ELSE ? END,
			import_source = ?, import_license = ?, imported_at = ? WHERE id = ?`,
			list, sourceName, license, now, ref)
		return err
	})
	return ref, err
}

// SetFrozen freezes a source's consensus layer until the given time.
func (s *Store) SetFrozen(ctx context.Context, ref, until int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE sources SET frozen_until = ? WHERE id = ?`, until, ref)
	return err
}
