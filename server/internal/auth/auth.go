// Package auth handles email sign-in links, sessions, reviewer tokens, install IDs and the CSRF header.
// Every secret is stored only as a SHA-256 hash.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/rudecompany/colander/server/internal/store"
)

// CookieName is the session cookie.
const CookieName = "colander_session"

// Auth issues and checks sign-in links, sessions and reviewer tokens.
type Auth struct {
	Store      *store.Store
	Now        func() time.Time
	Dev        bool // cookies without Secure, for http://localhost
	LinkTTL    time.Duration
	SessionTTL time.Duration
}

// New returns an Auth with the contract's lifetimes: 20-minute links and 30-day sessions.
func New(st *store.Store, dev bool) *Auth {
	return &Auth{Store: st, Now: time.Now, Dev: dev, LinkTTL: 20 * time.Minute, SessionTTL: 30 * 24 * time.Hour}
}

// NewToken returns a random URL-safe token and its hash.
func NewToken() (raw, hash string) {
	b := make([]byte, 32)
	rand.Read(b)
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, HashToken(raw)
}

// HashToken is the stored form of a token.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// ErrBadInstall is returned for an install ID that is not 16 bytes of unpadded base64url.
var ErrBadInstall = errors.New("install id must be 16 random bytes as unpadded base64url")

// HashInstall validates an install ID and returns hex(SHA-256("colander-install:" + id)).
func HashInstall(id string) (string, error) {
	if len(id) != 22 {
		return "", ErrBadInstall
	}
	if b, err := base64.RawURLEncoding.DecodeString(id); err != nil || len(b) != 16 {
		return "", ErrBadInstall
	}
	sum := sha256.Sum256([]byte("colander-install:" + id))
	return hex.EncodeToString(sum[:]), nil
}

// NormalizeEmail lowercases and validates a bare email address.
func NormalizeEmail(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) > 254 {
		return "", false
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || a.Name != "" {
		return "", false
	}
	return s, true
}

// SafeNext keeps a post-sign-in redirect on this site: a path, never another origin.
func SafeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") ||
		strings.ContainsAny(next, "\r\n") || len(next) > 512 {
		return "/account"
	}
	return next
}

// StartSignIn stores a single-use sign-in link for email and returns its raw token.
func (a *Auth) StartSignIn(ctx context.Context, email, next string) (string, error) {
	raw, hash := NewToken()
	now := a.Now()
	return raw, a.Store.CreateMagicLink(ctx, hash, email, SafeNext(next), now.Unix(), now.Add(a.LinkTTL).Unix())
}

// FinishSignIn consumes a sign-in link, creates a session and sets the cookie.
func (a *Auth) FinishSignIn(ctx context.Context, w http.ResponseWriter, token string) (*store.Account, error) {
	now := a.Now()
	acct, err := a.Store.UseMagicLink(ctx, HashToken(token), now.Unix())
	if err != nil {
		return nil, err
	}
	raw, hash := NewToken()
	expires := now.Add(a.SessionTTL)
	if err := a.Store.CreateSession(ctx, hash, acct.ID, now.Unix(), expires.Unix()); err != nil {
		return nil, err
	}
	a.setCookie(w, raw, expires)
	return acct, nil
}

func (a *Auth) setCookie(w http.ResponseWriter, value string, expires time.Time) {
	c := &http.Cookie{Name: CookieName, Value: value, Path: "/", HttpOnly: true, Secure: !a.Dev, SameSite: http.SameSiteLaxMode}
	if value == "" {
		c.MaxAge = -1
	} else {
		c.Expires = expires
		c.MaxAge = int(time.Until(expires).Seconds())
	}
	http.SetCookie(w, c)
}

// SignOut deletes the request's session and clears the cookie.
func (a *Auth) SignOut(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		if err := a.Store.DeleteSession(ctx, HashToken(c.Value)); err != nil {
			return err
		}
	}
	a.setCookie(w, "", time.Time{})
	return nil
}

// SessionAccount returns the signed-in account, or store.ErrNotFound when there is none.
func (a *Auth) SessionAccount(ctx context.Context, r *http.Request) (*store.Account, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil, store.ErrNotFound
	}
	return a.Store.SessionAccount(ctx, HashToken(c.Value), a.Now().Unix())
}

// IssueReviewerToken replaces the account's reviewer token and returns the new raw token.
func (a *Auth) IssueReviewerToken(ctx context.Context, accountID string) (string, error) {
	raw, hash := NewToken()
	return raw, a.Store.SetReviewerToken(ctx, accountID, hash, a.Now().Unix())
}

// ReviewerAccount returns the account behind a raw reviewer token.
func (a *Auth) ReviewerAccount(ctx context.Context, token string) (*store.Account, error) {
	return a.Store.ReviewerAccount(ctx, HashToken(token))
}

// CSRFOK reports whether a cookie-authenticated request may proceed: reads always,
// writes only with the X-Colander-CSRF: 1 header, which cross-site forms cannot send.
func CSRFOK(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return r.Header.Get("X-Colander-CSRF") == "1"
}
