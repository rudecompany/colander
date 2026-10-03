// Package store keeps all of Colander's state in one SQLite database (WAL mode, foreign keys on).
// Schema changes are numbered SQL files in migrations/, applied in order at Open.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/base32"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var migrations embed.FS

// ErrNotFound is returned when a looked-up row does not exist.
var ErrNotFound = errors.New("not found")

// Store wraps the database handle.
type Store struct {
	DB *sql.DB
}

// querier is satisfied by both *sql.DB and *sql.Tx.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Open opens (creating if needed) the database at path and applies pending migrations.
func Open(ctx context.Context, path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	q := url.Values{}
	for _, p := range []string{"foreign_keys(1)", "journal_mode(WAL)", "busy_timeout(10000)", "synchronous(NORMAL)"} {
		q.Add("_pragma", p)
	}
	// Immediate transactions take the write lock up front, so two writers never deadlock on upgrade.
	q.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	s := &Store{DB: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.DB.Close() }

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.DB.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`); err != nil {
		return err
	}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	type mig struct {
		version int
		name    string
	}
	var all []mig
	for _, n := range names {
		base := filepath.Base(n)
		num, _, ok := strings.Cut(base, "_")
		v, err := strconv.Atoi(num)
		if !ok || err != nil {
			return fmt.Errorf("migration %s must start with a number and an underscore", base)
		}
		all = append(all, mig{v, base})
	}
	slices.SortFunc(all, func(a, b mig) int { return a.version - b.version })
	for i := 1; i < len(all); i++ {
		if all[i].version == all[i-1].version {
			return fmt.Errorf("two migrations share number %d", all[i].version)
		}
	}
	for _, m := range all {
		var exists int
		if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + m.name)
		if err != nil {
			return err
		}
		err = s.Tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return fmt.Errorf("migration %s: %w", m.name, err)
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
				m.version, m.name, time.Now().Unix())
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// Tx runs fn in a write transaction and commits when fn returns nil.
func (s *Store) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

var idEncoding = base32.NewEncoding("abcdefghijkmnpqrstuvwxyz23456789").WithPadding(base32.NoPadding)

// NewID returns prefix + "_" + 16 random lowercase characters.
func NewID(prefix string) string {
	b := make([]byte, 10)
	rand.Read(b)
	return prefix + "_" + idEncoding.EncodeToString(b)
}

// nullString turns "" into NULL.
func nullString(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

// nullInt turns 0 into NULL.
func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

// placeholders returns "?, ?, ?" for n arguments.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}
