package api

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/rudecompany/colander/server/internal/auth"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/store"
)

type appealJSON struct {
	ID         string  `json:"id"`
	Platform   string  `json:"platform"`
	SourceID   string  `json:"source_id"`
	SourceName *string `json:"source_name"`
	Code       string  `json:"code"`
	Status     string  `json:"status"`
	Statement  string  `json:"statement"`
	Outcome    *string `json:"outcome"`
	Reasoning  *string `json:"reasoning"`
	CreatedAt  string  `json:"created_at"`
	VerifiedAt *string `json:"verified_at"`
	ResolvedAt *string `json:"resolved_at"`
}

func toAppeal(a store.Appeal) appealJSON {
	return appealJSON{ID: a.ID, Platform: a.Platform, SourceID: a.SourceID, SourceName: optString(a.SourceName), Code: a.Code,
		Status: a.Status, Statement: a.Statement, Outcome: optString(a.Outcome), Reasoning: optString(a.Reasoning),
		CreatedAt: rfc3339(a.CreatedAt), VerifiedAt: optTime(a.VerifiedAt), ResolvedAt: optTime(a.ResolvedAt)}
}

func toAppeals(list []store.Appeal) []appealJSON {
	out := make([]appealJSON, len(list))
	for i, a := range list {
		out[i] = toAppeal(a)
	}
	return out
}

// appealCode is "colander-" plus 8 characters that are hard to misread.
func appealCode() string {
	const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return "colander-" + string(b)
}

func (s *Server) postAppeal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform  string `json:"platform"`
		SourceID  string `json:"source_id"`
		Email     string `json:"email"`
		Statement string `json:"statement"`
	}
	if !decode(w, r, 16<<10, &body) {
		return
	}
	statement := strings.TrimSpace(body.Statement)
	email, emailOK := auth.NormalizeEmail(body.Email)
	switch {
	case !validPlatform(body.Platform):
		writeError(w, http.StatusBadRequest, "invalid_platform", "platform must be yt, tt, ig or fb.")
		return
	case !emailOK:
		writeError(w, http.StatusBadRequest, "invalid_email", "Enter a valid email address.")
		return
	case utf8.RuneCountInString(statement) < 1 || utf8.RuneCountInString(statement) > 2000:
		writeError(w, http.StatusBadRequest, "invalid_statement", "Your statement must be 1 to 2,000 characters.")
		return
	}
	ok, retry := allow(s.Now(), s.clientIP(r), 1, s.limits.appeals)
	if !ok {
		tooMany(w, retry)
		return
	}
	ref, found := s.findSource(w, r, body.Platform, body.SourceID)
	if !found {
		return
	}
	src, err := s.Store.GetSource(r.Context(), ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if src.State.Verdict == "" {
		writeError(w, http.StatusNotFound, "not_rated", "This source has no verdict to appeal.")
		return
	}
	secret, secretHash := auth.NewToken()
	a, err := s.Store.CreateAppeal(r.Context(), store.Appeal{Platform: src.Platform, SourceRef: ref, Email: email,
		Statement: statement, Code: appealCode(), SecretHash: secretHash, CreatedAt: s.Now().Unix()})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	name := src.Name
	if name == "" {
		name = src.CanonicalID
	}
	link := s.PublicURL + "/appeal/status/" + a.ID + "?secret=" + url.QueryEscape(secret)
	subject, text := mail.Appeal(name, sourceNoun[src.Platform], a.Code, link)
	if err := s.Mail.Send(r.Context(), email, subject, text); err != nil {
		s.Log.Error("appeal email not sent", "err", err)
	}
	s.Engine.Touch(ref)
	writeJSON(w, http.StatusCreated, map[string]any{"appeal": toAppeal(*a), "secret": secret})
}

// appealWithSecret loads an appeal and checks its secret. A wrong secret looks like a missing appeal.
func (s *Server) appealWithSecret(w http.ResponseWriter, r *http.Request, secret string) (*store.Appeal, bool) {
	a, err := s.Store.GetAppeal(r.Context(), r.PathValue("id"))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.internalError(w, r, err)
		return nil, false
	}
	if a == nil || secret == "" || subtle.ConstantTimeCompare([]byte(auth.HashToken(secret)), []byte(a.SecretHash)) != 1 {
		writeError(w, http.StatusNotFound, "not_found", "No appeal matches this link.")
		return nil, false
	}
	return a, true
}

func (s *Server) getAppeal(w http.ResponseWriter, r *http.Request) {
	a, ok := s.appealWithSecret(w, r, r.URL.Query().Get("secret"))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"appeal": toAppeal(*a)})
}

func (s *Server) verifyAppeal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Secret string `json:"secret"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	a, ok := s.appealWithSecret(w, r, body.Secret)
	if !ok {
		return
	}
	ctx := r.Context()
	switch a.Status {
	case store.AppealUnderReview, store.AppealPendingManual:
		writeJSON(w, http.StatusOK, map[string]any{"appeal": toAppeal(*a)})
		return
	case store.AppealAwaiting:
	default:
		writeError(w, http.StatusConflict, "appeal_closed", "This appeal is already closed.")
		return
	}
	if a.Platform == "yt" && s.YouTube != nil {
		found, err := s.YouTube.DescriptionContains(ctx, a.SourceID, a.Code)
		switch {
		case err == nil && found:
			if err := s.Engine.VerifyAppeal(ctx, a); err != nil {
				s.internalError(w, r, err)
				return
			}
			s.respondAppeal(w, r, a.ID)
			return
		case err == nil:
			writeError(w, http.StatusUnprocessableEntity, "code_not_found",
				"We could not find "+a.Code+" in the channel description yet. Add it, wait a minute and try again.")
			return
		default:
			// The API is unavailable (quota or network): staff check by hand instead.
			s.Log.Warn("youtube appeal check failed, falling back to manual review", "err", err)
		}
	}
	err := s.Store.TransitionAppeal(ctx, a.ID, []string{store.AppealAwaiting}, store.AppealPendingManual, store.AppealChange{})
	if err != nil && !errors.Is(err, store.ErrConflict) {
		s.internalError(w, r, err)
		return
	}
	s.Engine.Touch(a.SourceRef)
	s.respondAppeal(w, r, a.ID)
}

func (s *Server) respondAppeal(w http.ResponseWriter, r *http.Request, id string) {
	a, err := s.Store.GetAppeal(r.Context(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"appeal": toAppeal(*a)})
}
