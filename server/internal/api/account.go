package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/rudecompany/colander/server/internal/auth"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/store"
)

type accountJSON struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName *string `json:"display_name"`
	Role        string  `json:"role"`
	Plan        any     `json:"plan"`
	CreatedAt   string  `json:"created_at"`
}

// toAccount renders an account. Plans arrive with billing; until then plan is always null.
func toAccount(a *store.Account) accountJSON {
	return accountJSON{ID: a.ID, Email: a.Email, DisplayName: optString(a.DisplayName), Role: a.Role, CreatedAt: rfc3339(a.CreatedAt)}
}

// session returns the signed-in account. Writes need the CSRF header as well as the cookie.
func (s *Server) session(w http.ResponseWriter, r *http.Request) (*store.Account, bool) {
	if !auth.CSRFOK(r) {
		writeError(w, http.StatusForbidden, "csrf_required", "Send the X-Colander-CSRF: 1 header with this request.")
		return nil, false
	}
	a, err := s.Auth.SessionAccount(r.Context(), r)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "signed_out", "Sign in to continue.")
		return nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, false
	}
	return a, true
}

func (s *Server) authEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
		Next  string `json:"next"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	email, ok := auth.NormalizeEmail(body.Email)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_email", "Enter a valid email address.")
		return
	}
	if ok, retry := allow(s.Now(), auth.HashToken(email), 1, s.limits.authEmail); !ok {
		tooMany(w, retry)
		return
	}
	next := auth.SafeNext(body.Next)
	token, err := s.Auth.StartSignIn(r.Context(), email, next)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	link := s.PublicURL + "/auth/callback?token=" + url.QueryEscape(token) + "&next=" + url.QueryEscape(next)
	subject, text := mail.SignIn(link)
	if err := s.Mail.Send(r.Context(), email, subject, text); err != nil {
		s.Log.Error("sign-in email not sent", "err", err)
	}
	// Always 202, so the response never tells whether an account exists.
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (s *Server) authVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	a, err := s.Auth.FinishSignIn(r.Context(), w, strings.TrimSpace(body.Token))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "link_invalid", "This sign-in link has expired or was already used. Ask for a new one.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": toAccount(a)})
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) {
	if !auth.CSRFOK(r) {
		writeError(w, http.StatusForbidden, "csrf_required", "Send the X-Colander-CSRF: 1 header with this request.")
		return
	}
	if err := s.Auth.SignOut(r.Context(), w, r); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getAccount(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"account": toAccount(a)})
}

func (s *Server) patchAccount(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	var body struct {
		DisplayName *string `json:"display_name"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	name := ""
	if body.DisplayName != nil {
		name = strings.TrimSpace(*body.DisplayName)
	}
	if utf8.RuneCountInString(name) > 60 || strings.ContainsAny(name, "\r\n\t") {
		writeError(w, http.StatusBadRequest, "invalid_display_name", "The display name must be one line of at most 60 characters.")
		return
	}
	if err := s.Store.SetDisplayName(r.Context(), a.ID, name); err != nil {
		s.internalError(w, r, err)
		return
	}
	a.DisplayName = name
	writeJSON(w, http.StatusOK, map[string]any{"account": toAccount(a)})
}

func (s *Server) reviewerToken(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	if a.Role != "curator" && a.Role != "staff" {
		writeError(w, http.StatusForbidden, "forbidden", "Only curators and staff can create a reviewer token.")
		return
	}
	token, err := s.Auth.IssueReviewerToken(r.Context(), a.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}
