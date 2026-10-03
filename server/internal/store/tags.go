package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// TouchInstall records an install hash the first time it is seen.
func (s *Store) TouchInstall(ctx context.Context, hash string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO installs (hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, hash, now)
	return err
}

// TagInput is one validated tag with canonical IDs.
type TagInput struct {
	ClientID      string
	Platform      string
	TargetType    string // source | item
	TargetID      string
	SourceID      string // the item's source; the target itself for source tags
	Verdict       string // slop | ai_fine | not_slop
	SlopType      string
	Tests         uint8
	PlatformLabel bool
	CreatedAt     int64
	ExtVersion    string
}

// SaveTags stores tags from one install. A tag replaces the install's earlier tag on the same target
// unless the stored one is newer; replaying the same tag changes nothing. It returns the touched source refs.
func (s *Store) SaveTags(ctx context.Context, install string, tags []TagInput, now int64) ([]int64, error) {
	var refs []int64
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO installs (hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, install, now); err != nil {
			return err
		}
		for _, t := range tags {
			sourceRef, err := ensureSource(ctx, tx, t.Platform, t.SourceID, "", now)
			if err != nil {
				return err
			}
			var itemRef int64
			if t.TargetType == "item" {
				if itemRef, err = ensureItem(ctx, tx, t.Platform, t.TargetID, sourceRef, now); err != nil {
					return err
				}
				// An item keeps its first source, so evidence rolls up to that one.
				if err := tx.QueryRowContext(ctx, `SELECT source_id FROM items WHERE id = ?`, itemRef).Scan(&sourceRef); err != nil {
					return err
				}
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO tags (install_hash, platform, target_type, target_id, source_id, item_id,
				client_id, verdict, slop_type, tests, platform_label, created_at, received_at, ext_version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (install_hash, platform, target_type, target_id) DO UPDATE SET
					source_id = excluded.source_id, item_id = excluded.item_id, client_id = excluded.client_id,
					verdict = excluded.verdict, slop_type = excluded.slop_type, tests = excluded.tests,
					platform_label = excluded.platform_label, created_at = excluded.created_at,
					received_at = excluded.received_at, ext_version = excluded.ext_version
				WHERE excluded.client_id != tags.client_id AND excluded.created_at >= tags.created_at`,
				install, t.Platform, t.TargetType, t.TargetID, sourceRef, nullInt(itemRef), t.ClientID, t.Verdict,
				nullString(t.SlopType), t.Tests, t.PlatformLabel, t.CreatedAt, now, nullString(t.ExtVersion))
			if err != nil {
				return err
			}
			refs = append(refs, sourceRef)
		}
		_, err := tx.ExecContext(ctx, `UPDATE installs SET first_tag_at = ? WHERE hash = ? AND first_tag_at IS NULL`, now, install)
		return err
	})
	return refs, err
}

// ReportInput is one validated report.
type ReportInput struct {
	InstallHash string
	ClientID    string
	Platform    string
	SourceID    string // canonical, as reported
	SourceName  string
	Examples    []string
	Reason      string
	SlopType    string
	Tests       uint8
	ExtVersion  string
}

// Report is a stored report.
type Report struct {
	ID          string
	Platform    string
	SourceRef   int64
	ReportedID  string
	SourceName  string
	Examples    []string
	Reason      string
	SlopType    string
	Tests       uint8
	Status      string // open | decided | dismissed
	Verdict     string
	CloseReason string
	CreatedAt   int64
	UpdatedAt   int64
}

const reportCols = `id, platform, source_id, reported_id, ifnull(source_name, ''), examples, reason, ifnull(slop_type, ''),
	tests, status, ifnull(verdict, ''), ifnull(close_reason, ''), created_at, updated_at`

func scanReport(row interface{ Scan(...any) error }) (*Report, error) {
	var r Report
	var examples string
	err := row.Scan(&r.ID, &r.Platform, &r.SourceRef, &r.ReportedID, &r.SourceName, &examples, &r.Reason, &r.SlopType,
		&r.Tests, &r.Status, &r.Verdict, &r.CloseReason, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(examples), &r.Examples); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) reports(ctx context.Context, where string, args ...any) ([]Report, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+reportCols+` FROM reports WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		r, err := scanReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// CreateReport stores a report, creating its source when unknown. Sending the same client_id
// again returns the stored report and created=false.
func (s *Store) CreateReport(ctx context.Context, in ReportInput, now int64) (r *Report, created bool, err error) {
	examples, err := json.Marshal(in.Examples)
	if err != nil {
		return nil, false, err
	}
	var id string
	err = s.Tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT id FROM reports WHERE install_hash = ? AND client_id = ?`, in.InstallHash, in.ClientID).Scan(&id)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO installs (hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, in.InstallHash, now); err != nil {
			return err
		}
		ref, err := ensureSource(ctx, tx, in.Platform, in.SourceID, in.SourceName, now)
		if err != nil {
			return err
		}
		id, created = NewID("rpt"), true
		_, err = tx.ExecContext(ctx, `INSERT INTO reports (id, install_hash, client_id, platform, source_id, reported_id,
			source_name, examples, reason, slop_type, tests, ext_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, in.InstallHash, in.ClientID, in.Platform, ref, in.SourceID, nullString(in.SourceName), string(examples),
			in.Reason, nullString(in.SlopType), in.Tests, nullString(in.ExtVersion), now, now)
		return err
	})
	if err != nil {
		return nil, false, err
	}
	r, err = s.GetReport(ctx, id)
	return r, created, err
}

// GetReport loads one report.
func (s *Store) GetReport(ctx context.Context, id string) (*Report, error) {
	return scanReport(s.DB.QueryRowContext(ctx, `SELECT `+reportCols+` FROM reports WHERE id = ?`, id))
}

// ReportsByInstall lists an install's reports, newest first.
func (s *Store) ReportsByInstall(ctx context.Context, install string) ([]Report, error) {
	return s.reports(ctx, `install_hash = ? ORDER BY created_at DESC, rowid DESC`, install)
}

// ReportsBySource lists a source's reports, open ones first, then newest first.
func (s *Store) ReportsBySource(ctx context.Context, sourceRef int64) ([]Report, error) {
	return s.reports(ctx, `source_id = ? ORDER BY status != 'open', created_at DESC, rowid DESC`, sourceRef)
}

// OpenReports lists every open report, oldest first.
func (s *Store) OpenReports(ctx context.Context) ([]Report, error) {
	return s.reports(ctx, `status = 'open' ORDER BY created_at, rowid`)
}

// DismissReport closes an open report with no verdict change.
func (s *Store) DismissReport(ctx context.Context, id, reason string, now int64) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE reports SET status = 'dismissed', close_reason = ?, updated_at = ?
		WHERE id = ? AND status = 'open'`, reason, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.GetReport(ctx, id); err != nil {
			return err
		}
		return ErrConflict
	}
	return nil
}

// ErrConflict is returned when a row is not in the state an update needs.
var ErrConflict = errors.New("conflict")

// closeReports closes a source's open reports with the verdict a reviewer set ("" dismisses them).
func closeReports(ctx context.Context, tx *sql.Tx, sourceRef int64, verdict, reason string, now int64) error {
	status := "decided"
	if verdict == "" {
		status = "dismissed"
	}
	_, err := tx.ExecContext(ctx, `UPDATE reports SET status = ?, verdict = ?, close_reason = ?, updated_at = ?
		WHERE source_id = ? AND status = 'open'`, status, nullString(verdict), reason, now, sourceRef)
	return err
}
