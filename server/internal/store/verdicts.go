package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strconv"
	"strings"
)

// Vote is one install's latest tag on a source or one of its items, as scoring reads it.
type Vote struct {
	Install          string
	ItemRef          int64 // 0 for a tag on the source itself
	Verdict          string
	SlopType         string
	Tests            uint8
	PlatformLabel    bool
	CreatedAt        int64
	ReceivedAt       int64
	InstallCreatedAt int64
}

// Decision is a staff, curator or appeal decision on a source or item.
type Decision struct {
	ID        int64
	SourceRef int64
	ItemRef   int64
	Verdict   string // a verdict, or "none"
	Reason    string
	Signals   uint16
	Detail    uint8
	Actor     string // curator | staff | appeal
	AccountID string
	ActorName string
	CreatedAt int64
	ExpiresAt int64
}

// SourceData is everything scoring needs about one source.
type SourceData struct {
	Source      *Source
	Items       []Item
	Votes       []Vote
	Decisions   map[int64]*Decision // the active decision per item ref, 0 for the source
	AppealOpen  bool                // a verified appeal is under review
	OpenReports int
}

// LoadSourceData loads a source with its items, tags, active decisions, appeal and report state.
func (s *Store) LoadSourceData(ctx context.Context, ref, now int64) (*SourceData, error) {
	src, err := s.GetSource(ctx, ref)
	if err != nil {
		return nil, err
	}
	d := &SourceData{Source: src, Decisions: map[int64]*Decision{}}
	if d.Items, err = s.ItemsBySource(ctx, ref); err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT t.install_hash, ifnull(t.item_id, 0), t.verdict, ifnull(t.slop_type, ''),
		t.tests, t.platform_label, t.created_at, t.received_at, i.created_at
		FROM tags t JOIN installs i ON i.hash = t.install_hash WHERE t.source_id = ?`, ref)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v Vote
		if err := rows.Scan(&v.Install, &v.ItemRef, &v.Verdict, &v.SlopType, &v.Tests, &v.PlatformLabel, &v.CreatedAt,
			&v.ReceivedAt, &v.InstallCreatedAt); err != nil {
			return nil, err
		}
		d.Votes = append(d.Votes, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	decs, err := s.decisions(ctx, `source_id = ? AND expires_at > ? ORDER BY id`, ref, now)
	if err != nil {
		return nil, err
	}
	for i := range decs {
		d.Decisions[decs[i].ItemRef] = &decs[i] // later decisions replace earlier ones
	}
	err = s.DB.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM appeals WHERE source_id = ? AND status = 'under_review'),
		(SELECT count(*) FROM reports WHERE source_id = ? AND status = 'open')`, ref, ref).Scan(&d.AppealOpen, &d.OpenReports)
	return d, err
}

func (s *Store) decisions(ctx context.Context, where string, args ...any) ([]Decision, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, source_id, ifnull(item_id, 0), verdict, reason, signals, detail, actor,
		ifnull(account_id, ''), ifnull(actor_name, ''), created_at, expires_at FROM decisions WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Decision
	for rows.Next() {
		var d Decision
		if err := rows.Scan(&d.ID, &d.SourceRef, &d.ItemRef, &d.Verdict, &d.Reason, &d.Signals, &d.Detail, &d.Actor,
			&d.AccountID, &d.ActorName, &d.CreatedAt, &d.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Rep is the raw input to one install's reputation (contracts 9.1).
type Rep struct {
	FirstTagAt int64
	Decided    int
	Agree      int
}

// Reputation returns reputation inputs per install. With sourceRef set, only installs that tagged
// that source or its items are returned. A target counts as decided when it holds a staff or appeal
// decision (the staff reviewed flag), a slop verdict the community consensus layer agreed on, or a
// Clear from not-slop consensus. An AI-made verdict that merely carries the consensus signal does
// not count, or slop taggers would lose weight for the consensus they formed and verdicts would
// flip back and forth between passes. An item without its own verdict holds its source's.
func (s *Store) Reputation(ctx context.Context, sourceRef int64) (map[string]Rep, error) {
	filter := ""
	var args []any
	if sourceRef != 0 {
		filter = `WHERE t.install_hash IN (SELECT install_hash FROM tags WHERE source_id = ?)`
		args = append(args, sourceRef)
	}
	rows, err := s.DB.QueryContext(ctx, `WITH t AS (
		SELECT t.install_hash AS h, t.verdict AS tv,
			CASE WHEN it.verdict IS NOT NULL THEN it.verdict ELSE src.verdict END AS v,
			CASE WHEN it.verdict IS NOT NULL THEN it.flags ELSE src.flags END AS f,
			CASE WHEN it.verdict IS NOT NULL THEN it.signals ELSE src.signals END AS sg
		FROM tags t JOIN sources src ON src.id = t.source_id LEFT JOIN items it ON it.id = t.item_id `+filter+`
	), d AS (
		SELECT h, tv, v, (v IN ('slop', 'likely_slop', 'ai_made', 'clear') AND (f & 64) != 0)
			OR (v IN ('slop', 'likely_slop') AND (sg & 4096) != 0)
			OR (v = 'clear' AND (sg & 32768) != 0) AS decided FROM t
	)
	SELECT i.hash, ifnull(i.first_tag_at, i.created_at), sum(d.decided),
		sum(d.decided AND ((tv = 'slop' AND v IN ('slop', 'likely_slop')) OR (tv = 'not_slop' AND v = 'clear') OR (tv = 'ai_fine' AND v = 'ai_made')))
	FROM d JOIN installs i ON i.hash = d.h GROUP BY i.hash`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Rep{}
	for rows.Next() {
		var h string
		var r Rep
		if err := rows.Scan(&h, &r.FirstTagAt, &r.Decided, &r.Agree); err != nil {
			return nil, err
		}
		out[h] = r
	}
	return out, rows.Err()
}

// LogEntry is one row of the public decision log.
type LogEntry struct {
	ID         int64
	At         int64
	Platform   string
	TargetType string
	TargetID   string
	SourceRef  int64
	SourceKey  string
	SourceName string
	From       string
	To         string
	Reason     string
	Signals    uint16
	Actor      string
	ActorName  string
}

func addLog(ctx context.Context, q querier, e *LogEntry) error {
	_, err := q.ExecContext(ctx, `INSERT INTO decision_log (at, platform, target_type, target_id, source_id, source_key,
		source_name, from_verdict, to_verdict, reason, signals, actor, actor_name)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.At, e.Platform, e.TargetType, e.TargetID, nullInt(e.SourceRef), e.SourceKey, nullString(e.SourceName),
		nullString(e.From), nullString(e.To), e.Reason, e.Signals, e.Actor, nullString(e.ActorName))
	return err
}

// LogFilter narrows a decision log query. Results are newest first.
type LogFilter struct {
	Before    int64 // cursor: only entries with a smaller id
	Platform  string
	Verdict   string // matches the verdict the entry moved to
	SourceRef int64
	Limit     int
}

// Log lists decision log entries.
func (s *Store) Log(ctx context.Context, f LogFilter) ([]LogEntry, error) {
	var where []string
	var args []any
	if f.Before > 0 {
		where, args = append(where, "id < ?"), append(args, f.Before)
	}
	if f.Platform != "" {
		where, args = append(where, "platform = ?"), append(args, f.Platform)
	}
	if f.Verdict != "" {
		where, args = append(where, "to_verdict = ?"), append(args, f.Verdict)
	}
	if f.SourceRef != 0 {
		where, args = append(where, "source_id = ?"), append(args, f.SourceRef)
	}
	q := `SELECT id, at, platform, target_type, target_id, ifnull(source_id, 0), source_key, ifnull(source_name, ''),
		ifnull(from_verdict, ''), ifnull(to_verdict, ''), reason, signals, actor, ifnull(actor_name, '') FROM decision_log`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY id DESC LIMIT " + strconv.Itoa(max(f.Limit, 1))
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LogEntry{}
	for rows.Next() {
		var e LogEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Platform, &e.TargetType, &e.TargetID, &e.SourceRef, &e.SourceKey, &e.SourceName,
			&e.From, &e.To, &e.Reason, &e.Signals, &e.Actor, &e.ActorName); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Update is a new state for a source (ItemRef 0) or item, with an optional log entry.
type Update struct {
	SourceRef int64
	ItemRef   int64
	// Expect is the verdict the caller computed from. The update is skipped when the stored
	// verdict changed in the meantime, so two scorers never log the same change twice.
	Expect string
	State  State
	Log    *LogEntry
}

// ApplyUpdate writes the state and log entry in one transaction. It reports false when skipped.
func (s *Store) ApplyUpdate(ctx context.Context, u Update) (bool, error) {
	table, id := "sources", u.SourceRef
	if u.ItemRef != 0 {
		table, id = "items", u.ItemRef
	}
	applied := false
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		var cur string
		err := tx.QueryRowContext(ctx, `SELECT ifnull(verdict, '') FROM `+table+` WHERE id = ?`, id).Scan(&cur)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil || cur != u.Expect {
			return err
		}
		st := u.State
		_, err = tx.ExecContext(ctx, `UPDATE `+table+` SET verdict = ?, signals = ?, detail = ?, flags = ?, changed_at = ?,
			rescore_at = ?, lapse_hold = ?, computed = ? WHERE id = ?`,
			nullString(st.Verdict), st.Signals, st.Detail, st.Flags, nullInt(st.ChangedAt), nullInt(st.RescoreAt),
			st.LapseHold, nullString(st.Computed), id)
		if err != nil {
			return err
		}
		if u.ItemRef == 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE sources SET mixed = ? WHERE id = ?`, st.Mixed, id); err != nil {
				return err
			}
		}
		if u.Log != nil {
			if err := addLog(ctx, tx, u.Log); err != nil {
				return err
			}
		}
		applied = true
		return nil
	})
	return applied, err
}

// AddDecision records a reviewer or appeal decision. A source decision marks the source reviewed,
// lifts any lapse hold, closes its open reports and resolves its escalations; large, when set,
// records the staff view of the source's size. An item decision does the same for the item.
func (s *Store) AddDecision(ctx context.Context, d Decision, large *bool) (int64, error) {
	var id int64
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `INSERT INTO decisions (source_id, item_id, verdict, reason, signals, detail, actor,
			account_id, actor_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			d.SourceRef, nullInt(d.ItemRef), d.Verdict, d.Reason, d.Signals, d.Detail, d.Actor, nullString(d.AccountID),
			nullString(d.ActorName), d.CreatedAt, d.ExpiresAt)
		if err != nil {
			return err
		}
		id, _ = res.LastInsertId()
		if d.ItemRef != 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE items SET lapse_hold = 0 WHERE id = ?`, d.ItemRef); err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, `UPDATE escalations SET resolved_at = ? WHERE item_id = ? AND resolved_at IS NULL`, d.CreatedAt, d.ItemRef)
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sources SET reviewed_at = ?, lapse_hold = 0 WHERE id = ?`, d.CreatedAt, d.SourceRef); err != nil {
			return err
		}
		if large != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE sources SET large_staff = ?, size_reviewed_at = ? WHERE id = ?`,
				*large, d.CreatedAt, d.SourceRef); err != nil {
				return err
			}
		}
		verdict := d.Verdict
		if verdict == "none" {
			verdict = ""
		}
		if err := closeReports(ctx, tx, d.SourceRef, verdict, d.Reason, d.CreatedAt); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE escalations SET resolved_at = ? WHERE source_id = ? AND item_id IS NULL AND resolved_at IS NULL`,
			d.CreatedAt, d.SourceRef)
		return err
	})
	return id, err
}

// LatestDecisions lists the latest decision per target of a source, active or not.
func (s *Store) LatestDecisions(ctx context.Context, sourceRef int64) ([]Decision, error) {
	return s.decisions(ctx, `id IN (SELECT max(id) FROM decisions WHERE source_id = ? GROUP BY ifnull(item_id, 0))`, sourceRef)
}

// Escalation is an open item in the review queue raised by scoring.
type Escalation struct {
	ID        int64
	SourceRef int64
	ItemRef   int64
	Kind      string // capped | lapsed | reports | burst
	Summary   string
	CreatedAt int64
}

// SyncEscalations makes the open escalations of kinds in managed, on one target, match want (kind to summary).
func (s *Store) SyncEscalations(ctx context.Context, sourceRef, itemRef int64, managed []string, want map[string]string, now int64) error {
	var open []string
	rows, err := s.DB.QueryContext(ctx, `SELECT kind FROM escalations WHERE source_id = ? AND ifnull(item_id, 0) = ? AND resolved_at IS NULL`, sourceRef, itemRef)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return err
		}
		open = append(open, k)
	}
	rows.Close()
	var add, remove []string
	for k := range want {
		if !slices.Contains(open, k) {
			add = append(add, k)
		}
	}
	for _, k := range open {
		if _, ok := want[k]; !ok && slices.Contains(managed, k) {
			remove = append(remove, k)
		}
	}
	if len(add) == 0 && len(remove) == 0 {
		return nil
	}
	return s.Tx(ctx, func(tx *sql.Tx) error {
		for _, k := range add {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO escalations (source_id, item_id, kind, summary, created_at)
				VALUES (?, ?, ?, ?, ?)`, sourceRef, nullInt(itemRef), k, want[k], now); err != nil {
				return err
			}
		}
		for _, k := range remove {
			if _, err := tx.ExecContext(ctx, `UPDATE escalations SET resolved_at = ? WHERE source_id = ? AND ifnull(item_id, 0) = ?
				AND kind = ? AND resolved_at IS NULL`, now, sourceRef, itemRef, k); err != nil {
				return err
			}
		}
		return nil
	})
}

// OpenEscalations lists unresolved escalations, oldest first.
func (s *Store) OpenEscalations(ctx context.Context) ([]Escalation, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, source_id, ifnull(item_id, 0), kind, summary, created_at
		FROM escalations WHERE resolved_at IS NULL ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Escalation
	for rows.Next() {
		var e Escalation
		if err := rows.Scan(&e.ID, &e.SourceRef, &e.ItemRef, &e.Kind, &e.Summary, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
