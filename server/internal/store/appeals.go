package store

import (
	"context"
	"database/sql"
	"sort"
)

// Appeal statuses.
const (
	AppealAwaiting      = "awaiting_verification"
	AppealPendingManual = "pending_manual"
	AppealUnderReview   = "under_review"
	AppealUpheld        = "upheld"
	AppealDenied        = "denied"
	AppealExpired       = "expired"
)

// Appeal is a creator's appeal against a source verdict.
type Appeal struct {
	ID         string
	Platform   string
	SourceRef  int64
	SourceID   string // the source's canonical ID
	SourceName string
	Email      string
	Statement  string
	Code       string
	SecretHash string
	Status     string
	Outcome    string
	Reasoning  string
	CreatedAt  int64
	VerifiedAt int64
	ResolvedAt int64
}

const appealCols = `a.id, a.platform, a.source_id, s.canonical_id, ifnull(s.name, ''), a.email, a.statement, a.code,
	a.secret_hash, a.status, ifnull(a.outcome, ''), ifnull(a.reasoning, ''), a.created_at, ifnull(a.verified_at, 0),
	ifnull(a.resolved_at, 0)`

func (s *Store) appeals(ctx context.Context, where string, args ...any) ([]Appeal, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+appealCols+` FROM appeals a JOIN sources s ON s.id = a.source_id WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Appeal{}
	for rows.Next() {
		var a Appeal
		if err := rows.Scan(&a.ID, &a.Platform, &a.SourceRef, &a.SourceID, &a.SourceName, &a.Email, &a.Statement, &a.Code,
			&a.SecretHash, &a.Status, &a.Outcome, &a.Reasoning, &a.CreatedAt, &a.VerifiedAt, &a.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CreateAppeal stores a new appeal awaiting verification.
func (s *Store) CreateAppeal(ctx context.Context, a Appeal) (*Appeal, error) {
	a.ID = NewID("apl")
	_, err := s.DB.ExecContext(ctx, `INSERT INTO appeals (id, platform, source_id, email, statement, code, secret_hash, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.ID, a.Platform, a.SourceRef, a.Email, a.Statement, a.Code, a.SecretHash, AppealAwaiting, a.CreatedAt)
	if err != nil {
		return nil, err
	}
	return s.GetAppeal(ctx, a.ID)
}

// GetAppeal loads one appeal.
func (s *Store) GetAppeal(ctx context.Context, id string) (*Appeal, error) {
	list, err := s.appeals(ctx, `a.id = ?`, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, ErrNotFound
	}
	return &list[0], nil
}

// AppealsBySource lists a source's appeals, newest first.
func (s *Store) AppealsBySource(ctx context.Context, sourceRef int64) ([]Appeal, error) {
	return s.appeals(ctx, `a.source_id = ? ORDER BY a.created_at DESC, a.rowid DESC`, sourceRef)
}

// AppealsWithStatus lists appeals in any of the given statuses, oldest first.
func (s *Store) AppealsWithStatus(ctx context.Context, statuses ...string) ([]Appeal, error) {
	args := make([]any, len(statuses))
	for i, st := range statuses {
		args[i] = st
	}
	return s.appeals(ctx, `a.status IN (`+placeholders(len(statuses))+`) ORDER BY a.created_at, a.rowid`, args...)
}

// TransitionAppeal moves an appeal from one of the statuses in from to status, setting the given
// timestamps and resolution fields. It returns ErrConflict when the appeal is in another status.
func (s *Store) TransitionAppeal(ctx context.Context, id string, from []string, status string, set AppealChange) error {
	args := []any{status, nullInt(set.VerifiedAt), nullInt(set.ResolvedAt), nullString(set.Outcome), nullString(set.Reasoning),
		nullString(set.ResolvedBy), id}
	for _, f := range from {
		args = append(args, f)
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE appeals SET status = ?, verified_at = coalesce(?, verified_at),
		resolved_at = coalesce(?, resolved_at), outcome = coalesce(?, outcome), reasoning = coalesce(?, reasoning),
		resolved_by = coalesce(?, resolved_by) WHERE id = ? AND status IN (`+placeholders(len(from))+`)`, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.GetAppeal(ctx, id); err != nil {
			return err
		}
		return ErrConflict
	}
	return nil
}

// AppealChange holds the optional fields a transition sets.
type AppealChange struct {
	VerifiedAt int64
	ResolvedAt int64
	Outcome    string
	Reasoning  string
	ResolvedBy string
}

// ExpireAppeals marks appeals still awaiting verification after the cutoff as expired and returns their source refs.
func (s *Store) ExpireAppeals(ctx context.Context, createdBefore, now int64) ([]int64, error) {
	rows, err := s.DB.QueryContext(ctx, `UPDATE appeals SET status = ?, resolved_at = ? WHERE status = ? AND created_at < ?
		RETURNING source_id`, AppealExpired, now, AppealAwaiting, createdBefore)
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

// AppealStats counts open appeals and the median days from filing to resolution of decided ones.
func (s *Store) AppealStats(ctx context.Context) (open int, medianDays sql.NullFloat64, err error) {
	err = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM appeals WHERE status IN (?, ?, ?)`,
		AppealAwaiting, AppealPendingManual, AppealUnderReview).Scan(&open)
	if err != nil {
		return
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT resolved_at - created_at FROM appeals WHERE status IN (?, ?)`, AppealUpheld, AppealDenied)
	if err != nil {
		return
	}
	defer rows.Close()
	var secs []float64
	for rows.Next() {
		var d int64
		if err = rows.Scan(&d); err != nil {
			return
		}
		secs = append(secs, float64(d))
	}
	if err = rows.Err(); err != nil || len(secs) == 0 {
		return
	}
	sort.Float64s(secs)
	m := secs[len(secs)/2]
	if len(secs)%2 == 0 {
		m = (secs[len(secs)/2-1] + secs[len(secs)/2]) / 2
	}
	medianDays = sql.NullFloat64{Float64: m / 86400, Valid: true}
	return
}
