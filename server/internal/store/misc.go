package store

import (
	"context"
	"database/sql"
	"errors"
)

// SaveAdapterConfig stores a signed adapter configuration envelope (JSON text).
func (s *Store) SaveAdapterConfig(ctx context.Context, version int64, envelope string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO adapter_configs (version, envelope, created_at) VALUES (?, ?, ?)`, version, envelope, now)
	return err
}

// LatestAdapterConfig returns the newest stored envelope, or ErrNotFound.
func (s *Store) LatestAdapterConfig(ctx context.Context) (string, error) {
	var env string
	err := s.DB.QueryRowContext(ctx, `SELECT envelope FROM adapter_configs ORDER BY id DESC LIMIT 1`).Scan(&env)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return env, err
}

// StartTrial records the one trial an install may take. It returns ErrConflict when one was taken before.
func (s *Store) StartTrial(ctx context.Context, install, sub string, now, expires int64) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO installs (hash, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING`, install, now); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO trials (install_hash, sub, issued_at, expires_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (install_hash) DO NOTHING`, install, sub, now, expires)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrConflict
		}
		return nil
	})
}

// SyncBlob is a Plus user's synced settings.
type SyncBlob struct {
	Version   int64
	Data      string // a JSON object, "" when nothing was stored yet
	UpdatedAt int64
}

// GetSync returns the blob for sub, or a zero blob (version 0) when none exists.
func (s *Store) GetSync(ctx context.Context, sub string) (SyncBlob, error) {
	return getSync(ctx, s.DB, sub)
}

func getSync(ctx context.Context, q querier, sub string) (SyncBlob, error) {
	var b SyncBlob
	err := q.QueryRowContext(ctx, `SELECT version, data, updated_at FROM sync_blobs WHERE sub = ?`, sub).Scan(&b.Version, &b.Data, &b.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SyncBlob{}, nil
	}
	return b, err
}

// PutSync stores data when base equals the current version and returns the new blob. On a stale
// base it returns the current blob and ErrConflict.
func (s *Store) PutSync(ctx context.Context, sub string, base int64, data string, now int64) (SyncBlob, error) {
	var out SyncBlob
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := getSync(ctx, tx, sub)
		if err != nil {
			return err
		}
		if cur.Version != base {
			out = cur
			return ErrConflict
		}
		out = SyncBlob{Version: cur.Version + 1, Data: data, UpdatedAt: now}
		_, err = tx.ExecContext(ctx, `INSERT INTO sync_blobs (sub, version, data, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (sub) DO UPDATE SET version = excluded.version, data = excluded.data, updated_at = excluded.updated_at`,
			sub, out.Version, data, now)
		return err
	})
	return out, err
}

// CacheGet returns a cached YouTube response fetched at or after notBefore.
func (s *Store) CacheGet(ctx context.Context, key string, notBefore int64) ([]byte, bool, error) {
	var body []byte
	err := s.DB.QueryRowContext(ctx, `SELECT body FROM youtube_cache WHERE key = ? AND fetched_at >= ?`, key, notBefore).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	return body, err == nil, err
}

// CachePut stores a YouTube response.
func (s *Store) CachePut(ctx context.Context, key string, body []byte, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO youtube_cache (key, body, fetched_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`, key, body, now)
	return err
}

// VerdictCounts counts rated sources per verdict and rated items.
func (s *Store) VerdictCounts(ctx context.Context) (map[string]int, int, error) {
	out := map[string]int{"slop": 0, "likely_slop": 0, "ai_made": 0, "disputed": 0, "clear": 0}
	rows, err := s.DB.QueryContext(ctx, `SELECT verdict, count(*) FROM sources WHERE verdict IS NOT NULL GROUP BY verdict`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var v string
		var n int
		if err := rows.Scan(&v, &n); err != nil {
			return nil, 0, err
		}
		out[v] = n
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	var items int
	err = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM items WHERE verdict IS NOT NULL`).Scan(&items)
	return out, items, err
}

// LogCountSince counts decision log entries at or after a time.
func (s *Store) LogCountSince(ctx context.Context, since int64) (int, error) {
	var n int
	err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM decision_log WHERE at >= ?`, since).Scan(&n)
	return n, err
}
