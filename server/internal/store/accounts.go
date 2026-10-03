package store

import (
	"context"
	"database/sql"
	"errors"
)

// Account is a website account.
type Account struct {
	ID          string
	Email       string
	DisplayName string
	Role        string // member | curator | staff
	CreatedAt   int64
}

func scanAccount(row *sql.Row) (*Account, error) {
	var a Account
	err := row.Scan(&a.ID, &a.Email, &a.DisplayName, &a.Role, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &a, err
}

const accountCols = `a.id, a.email, ifnull(a.display_name, ''), a.role, a.created_at`

// GetAccount loads an account by id.
func (s *Store) GetAccount(ctx context.Context, id string) (*Account, error) {
	return scanAccount(s.DB.QueryRowContext(ctx, `SELECT `+accountCols+` FROM accounts a WHERE a.id = ?`, id))
}

// AccountByEmail loads an account by its normalized email.
func (s *Store) AccountByEmail(ctx context.Context, email string) (*Account, error) {
	return scanAccount(s.DB.QueryRowContext(ctx, `SELECT `+accountCols+` FROM accounts a WHERE a.email = ?`, email))
}

func ensureAccount(ctx context.Context, q querier, email string, now int64) error {
	_, err := q.ExecContext(ctx, `INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING`,
		NewID("acc"), email, now)
	return err
}

// GrantRole sets an account's role, creating the account when the email is new.
func (s *Store) GrantRole(ctx context.Context, email, role string, now int64) (*Account, error) {
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		if err := ensureAccount(ctx, tx, email, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE accounts SET role = ? WHERE email = ?`, role, email)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.AccountByEmail(ctx, email)
}

// SetDisplayName updates the public name ("" clears it).
func (s *Store) SetDisplayName(ctx context.Context, id, name string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE accounts SET display_name = ? WHERE id = ?`, nullString(name), id)
	return err
}

// CreateMagicLink stores a hashed sign-in token.
func (s *Store) CreateMagicLink(ctx context.Context, tokenHash, email, next string, now, expires int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO magic_links (token_hash, email, next, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, email, next, now, expires)
	return err
}

// UseMagicLink consumes an unexpired, unused link and returns the account it signs in,
// creating the account on first sign-in.
func (s *Store) UseMagicLink(ctx context.Context, tokenHash string, now int64) (*Account, error) {
	var email string
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
			RETURNING email`, now, tokenHash, now).Scan(&email)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := ensureAccount(ctx, tx, email, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM magic_links WHERE expires_at < ?`, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.AccountByEmail(ctx, email)
}

// CreateSession stores a hashed session token and drops expired sessions.
func (s *Store) CreateSession(ctx context.Context, tokenHash, accountID string, now, expires int64) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
			tokenHash, accountID, now, expires)
		return err
	})
}

// SessionAccount returns the account behind an unexpired session.
func (s *Store) SessionAccount(ctx context.Context, tokenHash string, now int64) (*Account, error) {
	return scanAccount(s.DB.QueryRowContext(ctx, `SELECT `+accountCols+` FROM sessions x JOIN accounts a ON a.id = x.account_id
		WHERE x.token_hash = ? AND x.expires_at > ?`, tokenHash, now))
}

// DeleteSession removes a session.
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// SetReviewerToken replaces an account's reviewer token.
func (s *Store) SetReviewerToken(ctx context.Context, accountID, tokenHash string, now int64) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO reviewer_tokens (token_hash, account_id, created_at) VALUES (?, ?, ?)
		ON CONFLICT (account_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
		tokenHash, accountID, now)
	return err
}

// ReviewerAccount returns the account behind a reviewer token.
func (s *Store) ReviewerAccount(ctx context.Context, tokenHash string) (*Account, error) {
	return scanAccount(s.DB.QueryRowContext(ctx, `SELECT `+accountCols+` FROM reviewer_tokens r JOIN accounts a ON a.id = r.account_id
		WHERE r.token_hash = ?`, tokenHash))
}
