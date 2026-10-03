package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/rudecompany/colander/server/internal/auth"
	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
)

// installHash reads "Authorization: Install <id>" and returns the hashed install ID.
func installHash(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Install ")
	if !ok {
		writeError(w, http.StatusUnauthorized, "install_required", "Send the install ID as Authorization: Install <id>.")
		return "", false
	}
	h, err := auth.HashInstall(strings.TrimSpace(id))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_install", "The install ID is not valid.")
		return "", false
	}
	return h, true
}

var (
	clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	uuidPattern     = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`)
)

type tagJSON struct {
	ClientID      string   `json:"client_id"`
	Platform      string   `json:"platform"`
	TargetType    string   `json:"target_type"`
	TargetID      string   `json:"target_id"`
	SourceID      string   `json:"source_id"`
	Verdict       string   `json:"verdict"`
	SlopType      *string  `json:"slop_type"`
	Tests         []string `json:"tests"`
	PlatformLabel bool     `json:"platform_label"`
	CreatedAt     string   `json:"created_at"`
	ExtVersion    string   `json:"ext_version"`
}

type rejection struct {
	ClientID string `json:"client_id"`
	Error    string `json:"error"`
}

// validateTag returns the stored form of a tag, or a machine-readable rejection code.
// invalid_field marks a field the contract forbids in that place (6.2).
func validateTag(t tagJSON, now time.Time) (store.TagInput, string) {
	in := store.TagInput{ClientID: t.ClientID, Platform: t.Platform, TargetType: t.TargetType, Verdict: t.Verdict,
		PlatformLabel: t.PlatformLabel, ExtVersion: t.ExtVersion, CreatedAt: now.Unix()}
	if !uuidPattern.MatchString(t.ClientID) {
		return in, "invalid_field"
	}
	if !validPlatform(t.Platform) {
		return in, "invalid_platform"
	}
	var ok bool
	switch t.TargetType {
	case "source":
		if in.TargetID, ok = CanonicalSource(t.Platform, t.TargetID); !ok {
			return in, "invalid_target"
		}
		if t.SourceID != "" {
			return in, "invalid_field"
		}
		in.SourceID = in.TargetID
	case "item":
		if in.TargetID, ok = CanonicalItem(t.Platform, t.TargetID); !ok {
			return in, "invalid_target"
		}
		// Without a source (the card did not show it) the item is scored on its own and rolls up nowhere.
		if t.SourceID != "" {
			if in.SourceID, ok = CanonicalSource(t.Platform, t.SourceID); !ok {
				return in, "invalid_source"
			}
		}
	default:
		return in, "invalid_target"
	}
	switch t.Verdict {
	case "slop":
		if t.SlopType != nil && *t.SlopType != "" {
			if lf.SlopTypeCode(*t.SlopType) == 0 {
				return in, "invalid_slop_type"
			}
			in.SlopType = *t.SlopType
		}
		tests, err := lf.TestBits(t.Tests)
		if err != nil {
			return in, "invalid_tests"
		}
		in.Tests = tests
	case "ai_fine", "not_slop":
		// Type and tests only mean something on a slop tag.
		if (t.SlopType != nil && *t.SlopType != "") || len(t.Tests) > 0 {
			return in, "invalid_field"
		}
	default:
		return in, "invalid_verdict"
	}
	if t.CreatedAt != "" {
		at, err := time.Parse(time.RFC3339, t.CreatedAt)
		if err != nil {
			return in, "invalid_created_at"
		}
		in.CreatedAt = min(at.Unix(), now.Unix())
	}
	if len(t.ExtVersion) > 32 {
		return in, "invalid_ext_version"
	}
	return in, ""
}

func (s *Server) postTags(w http.ResponseWriter, r *http.Request) {
	install, ok := installHash(w, r)
	if !ok {
		return
	}
	var body struct {
		Tags []tagJSON `json:"tags"`
	}
	if !decode(w, r, 128<<10, &body) {
		return
	}
	if len(body.Tags) < 1 || len(body.Tags) > 50 {
		writeError(w, http.StatusBadRequest, "invalid_batch", "Send between 1 and 50 tags at a time.")
		return
	}
	now := s.Now()
	if ok, retry := allow(now, install, float64(len(body.Tags)), s.limits.tagsMinute, s.limits.tagsDay); !ok {
		tooMany(w, retry)
		return
	}
	resp := struct {
		Accepted []string    `json:"accepted"`
		Rejected []rejection `json:"rejected"`
	}{Accepted: []string{}, Rejected: []rejection{}}
	var valid []store.TagInput
	for _, t := range body.Tags {
		in, code := validateTag(t, now)
		if code != "" {
			resp.Rejected = append(resp.Rejected, rejection{ClientID: t.ClientID, Error: code})
			continue
		}
		valid = append(valid, in)
		resp.Accepted = append(resp.Accepted, t.ClientID)
	}
	if len(valid) > 0 {
		if _, err := s.Store.SaveTags(r.Context(), install, valid, now.Unix()); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type reportJSON struct {
	ID         string  `json:"id"`
	Platform   string  `json:"platform"`
	SourceID   string  `json:"source_id"`
	SourceName *string `json:"source_name"`
	Status     string  `json:"status"`
	Verdict    *string `json:"verdict"`
	Protects   int64   `json:"protects"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

func toReport(rp store.Report, activeInstalls int64) reportJSON {
	out := reportJSON{ID: rp.ID, Platform: rp.Platform, SourceID: rp.ReportedID, SourceName: optString(rp.SourceName),
		Status: "under_review", CreatedAt: rfc3339(rp.CreatedAt), UpdatedAt: rfc3339(rp.UpdatedAt)}
	switch rp.Status {
	case "dismissed":
		out.Status = "dismissed"
	case "decided":
		out.Status, out.Verdict, out.Protects = rp.Verdict, optString(rp.Verdict), activeInstalls
	}
	return out
}

func (s *Server) postReport(w http.ResponseWriter, r *http.Request) {
	install, ok := installHash(w, r)
	if !ok {
		return
	}
	var body struct {
		ClientID   string   `json:"client_id"`
		Platform   string   `json:"platform"`
		SourceID   string   `json:"source_id"`
		SourceName string   `json:"source_name"`
		Examples   []string `json:"examples"`
		Reason     string   `json:"reason"`
		SlopType   *string  `json:"slop_type"`
		Tests      []string `json:"tests"`
		ExtVersion string   `json:"ext_version"`
	}
	if !decode(w, r, 16<<10, &body) {
		return
	}
	in := store.ReportInput{InstallHash: install, ClientID: body.ClientID, Platform: body.Platform,
		SourceName: strings.TrimSpace(body.SourceName), Reason: strings.TrimSpace(body.Reason), ExtVersion: body.ExtVersion,
		Examples: []string{}}
	bad := func(code, msg string) { writeError(w, http.StatusBadRequest, code, msg) }
	var valid bool
	switch {
	case !clientIDPattern.MatchString(body.ClientID):
		bad("invalid_client_id", "client_id must be the client's UUID.")
		return
	case !validPlatform(body.Platform):
		bad("invalid_platform", "platform must be yt, tt, ig or fb.")
		return
	case utf8.RuneCountInString(in.Reason) < 1 || utf8.RuneCountInString(in.Reason) > 500:
		bad("invalid_reason", "The reason must be 1 to 500 characters.")
		return
	case utf8.RuneCountInString(in.SourceName) > 120:
		bad("invalid_source_name", "The source name must be at most 120 characters.")
		return
	case len(body.Examples) > 3:
		bad("invalid_examples", "Send at most three example items.")
		return
	case len(body.ExtVersion) > 32:
		bad("invalid_ext_version", "ext_version is too long.")
		return
	}
	if in.SourceID, valid = CanonicalSource(body.Platform, body.SourceID); !valid {
		bad("invalid_source", "source_id is not a canonical source ID for this platform.")
		return
	}
	for _, e := range body.Examples {
		id, ok := CanonicalItem(body.Platform, e)
		if !ok {
			bad("invalid_examples", "Each example must be a canonical item ID for this platform.")
			return
		}
		in.Examples = append(in.Examples, id)
	}
	if body.SlopType != nil && *body.SlopType != "" {
		if lf.SlopTypeCode(*body.SlopType) == 0 {
			bad("invalid_slop_type", "slop_type must be filler, bait or deceptive.")
			return
		}
		in.SlopType = *body.SlopType
	}
	tests, err := lf.TestBits(body.Tests)
	if err != nil {
		bad("invalid_tests", "tests may hold low_effort, mass_produced and hollow.")
		return
	}
	in.Tests = tests

	now := s.Now()
	if ok, retry := allow(now, install, 1, s.limits.reports); !ok {
		tooMany(w, retry)
		return
	}
	rp, _, err := s.Store.CreateReport(r.Context(), in, now.Unix())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Engine.Touch(rp.SourceRef)
	writeJSON(w, http.StatusCreated, map[string]any{"report": toReport(*rp, 0)})
}

func (s *Server) getReports(w http.ResponseWriter, r *http.Request) {
	install, ok := installHash(w, r)
	if !ok {
		return
	}
	list, err := s.Store.ReportsByInstall(r.Context(), install)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	active, err := s.activeInstalls(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]reportJSON, len(list))
	for i, rp := range list {
		out[i] = toReport(rp, active)
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": out})
}

const trialLength = 14 * 24 * time.Hour

func (s *Server) postTrial(w http.ResponseWriter, r *http.Request) {
	install, ok := installHash(w, r)
	if !ok {
		return
	}
	now := s.Now()
	claims := sign.PlanClaims{V: 1, Sub: store.NewID("trl"), Plan: "plus", Trial: true, IAT: now.Unix(), EXP: now.Add(trialLength).Unix()}
	err := s.Store.StartTrial(r.Context(), install, claims.Sub, claims.IAT, claims.EXP)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "trial_used", "This install has already used its free trial.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	token, err := s.Key.IssuePlanToken(claims)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// plan verifies "Authorization: Plan <token>" with the server's own key.
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
