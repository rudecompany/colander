package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
)

// plan verifies "Authorization: Plan <token>" with the server's own key and, for a paid token, that
// the account's plan still runs.
func (s *Server) plan(w http.ResponseWriter, r *http.Request) (sign.PlanClaims, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Plan ")
	if !ok {
		writeError(w, http.StatusUnauthorized, "plan_required", "Settings sync needs a Plus plan token.")
		return sign.PlanClaims{}, false
	}
	c, err := sign.VerifyPlanToken(s.Key.Public, token, s.Now())
	if errors.Is(err, sign.ErrExpired) {
		writeError(w, http.StatusUnauthorized, "plan_expired", "The Plus plan behind this token has ended.")
		return c, false
	}
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_plan", "The plan token is not valid.")
		return c, false
	}
	// A paid token is only as good as the plan behind it: a refund or an ended subscription stops
	// sync at once, not when the token expires. Install trials have no plan and run until they expire.
	if !strings.HasPrefix(c.Sub, trialPrefix+"_") {
		sub, err := s.Billing.Current(r.Context(), c.Sub)
		if err != nil {
			s.internalError(w, r, err)
			return c, false
		}
		if sub == nil || sub.TokenExpiry() <= s.Now().Unix() {
			writeError(w, http.StatusForbidden, "no_plan", "The Plus plan behind this token has ended.")
			return c, false
		}
	}
	return c, true
}

const syncLimit = 64 << 10

func syncBody(b store.SyncBlob) map[string]any {
	var data json.RawMessage
	if b.Data != "" {
		data = json.RawMessage(b.Data)
	}
	return map[string]any{"version": b.Version, "data": data, "updated_at": optTime(b.UpdatedAt)}
}

func (s *Server) getSync(w http.ResponseWriter, r *http.Request) {
	c, ok := s.plan(w, r)
	if !ok {
		return
	}
	b, err := s.Store.GetSync(r.Context(), c.Sub)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncBody(b))
}

func (s *Server) putSync(w http.ResponseWriter, r *http.Request) {
	c, ok := s.plan(w, r)
	if !ok {
		return
	}
	var body struct {
		Version *int64          `json:"version"`
		Data    json.RawMessage `json:"data"`
	}
	if !decode(w, r, syncLimit+1024, &body) {
		return
	}
	data := bytes.TrimSpace(body.Data)
	switch {
	case body.Version == nil || *body.Version < 0:
		writeError(w, http.StatusBadRequest, "invalid_version", "version must be the version you last saw (0 when none).")
		return
	case len(data) == 0 || data[0] != '{':
		writeError(w, http.StatusBadRequest, "invalid_data", "data must be a JSON object.")
		return
	case len(data) > syncLimit:
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Synced settings must be at most 64 KB.")
		return
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_data", "data must be a JSON object.")
		return
	}
	b, err := s.Store.PutSync(r.Context(), c.Sub, *body.Version, compact.String(), s.Now().Unix())
	if errors.Is(err, store.ErrConflict) {
		out := syncBody(b)
		out["error"] = apiError{Code: "version_conflict", Message: "Settings changed elsewhere. Merge with the current copy and try again."}
		writeJSON(w, http.StatusConflict, out)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, syncBody(b))
}
