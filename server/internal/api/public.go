package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/store"
)

type logJSON struct {
	ID         string   `json:"id"`
	At         string   `json:"at"`
	Platform   string   `json:"platform"`
	TargetType string   `json:"target_type"`
	TargetID   string   `json:"target_id"`
	SourceID   string   `json:"source_id"`
	SourceName *string  `json:"source_name"`
	From       *string  `json:"from"`
	To         *string  `json:"to"`
	Reason     string   `json:"reason"`
	Signals    []string `json:"signals"`
	Actor      string   `json:"actor"`
	ActorName  *string  `json:"actor_name"`
}

func toLog(e store.LogEntry) logJSON {
	return logJSON{ID: "log_" + strconv.FormatInt(e.ID, 10), At: rfc3339(e.At), Platform: e.Platform, TargetType: e.TargetType,
		TargetID: e.TargetID, SourceID: e.SourceKey, SourceName: optString(e.SourceName), From: optString(e.From),
		To: optString(e.To), Reason: e.Reason, Signals: lf.SignalNames(e.Signals), Actor: e.Actor, ActorName: optString(e.ActorName)}
}

func toLogs(list []store.LogEntry) []logJSON {
	out := make([]logJSON, len(list))
	for i, e := range list {
		out[i] = toLog(e)
	}
	return out
}

type tagCounts struct {
	Slop    int `json:"slop"`
	AIFine  int `json:"ai_fine"`
	NotSlop int `json:"not_slop"`
}

type evidenceJSON struct {
	Taggers       int       `json:"taggers"`
	Tags          tagCounts `json:"tags"`
	ItemsSeen     int       `json:"items_seen"`
	AIItemShare   *float64  `json:"ai_item_share"`
	UploadsPerDay *float64  `json:"uploads_per_day"`
}

type sourceJSON struct {
	Platform   string       `json:"platform"`
	ID         string       `json:"id"`
	Aliases    []string     `json:"aliases"`
	Name       *string      `json:"name"`
	Verdict    *string      `json:"verdict"`
	Signals    []string     `json:"signals"`
	SlopType   *string      `json:"slop_type"`
	Tests      []string     `json:"tests"`
	Large      bool         `json:"large"`
	Imported   bool         `json:"imported"`
	AppealOpen bool         `json:"appeal_open"`
	UpdatedAt  *string      `json:"updated_at"`
	RescoreAt  *string      `json:"rescore_at"`
	Evidence   evidenceJSON `json:"evidence"`
}

func round2(f float64) *float64 {
	v := float64(int64(f*100+0.5)) / 100
	return &v
}

func toSource(ev *scoring.Evaluation) sourceJSON {
	src, st := ev.Data.Source, ev.Data.Source.State
	e := ev.Evidence()
	out := sourceJSON{
		Platform: src.Platform, ID: src.CanonicalID, Aliases: src.Aliases, Name: optString(src.Name),
		Verdict: optString(st.Verdict), Signals: lf.SignalNames(st.Signals), SlopType: optString(lf.SlopTypes[st.Detail&3]),
		Tests: lf.TestNames(st.Detail), Large: ev.Input.Large, Imported: src.ImportList != "", AppealOpen: ev.Data.AppealOpen,
		UpdatedAt: optTime(st.ChangedAt), RescoreAt: optTime(st.RescoreAt),
		Evidence: evidenceJSON{Taggers: e.Taggers, Tags: tagCounts{e.Slop, e.AIFine, e.NotSlop}, ItemsSeen: e.ItemsSeen},
	}
	if out.Aliases == nil {
		out.Aliases = []string{}
	}
	if e.ItemsSeen > 0 {
		out.Evidence.AIItemShare = round2(e.AIItemShare)
	}
	if e.UploadsPerDay >= 0 {
		out.Evidence.UploadsPerDay = round2(e.UploadsPerDay)
	}
	return out
}

// lookupSource resolves the {platform} and {source_id} path values to a source ref.
func (s *Server) lookupSource(w http.ResponseWriter, r *http.Request) (int64, bool) {
	return s.findSource(w, r, r.PathValue("platform"), r.PathValue("source_id"))
}

// findSource resolves a platform and any alias to a source ref, answering 404 not_rated itself.
func (s *Server) findSource(w http.ResponseWriter, r *http.Request, platform, alias string) (int64, bool) {
	id, ok := CanonicalSource(platform, alias)
	if ok {
		ref, err := s.Store.FindSource(r.Context(), platform, id)
		if err == nil {
			return ref, true
		}
		if !errors.Is(err, store.ErrNotFound) {
			s.internalError(w, r, err)
			return 0, false
		}
	}
	writeError(w, http.StatusNotFound, "not_rated", "Colander has no information about this source.")
	return 0, false
}

func (s *Server) getSource(w http.ResponseWriter, r *http.Request) {
	ref, ok := s.lookupSource(w, r)
	if !ok {
		return
	}
	ev, err := s.Engine.Explain(r.Context(), ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	history, err := s.Store.Log(r.Context(), store.LogFilter{SourceRef: ref, Limit: 50})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"source": toSource(ev), "history": toLogs(history)})
}

func (s *Server) getLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.LogFilter{Platform: q.Get("platform"), Verdict: q.Get("verdict"), Limit: 50}
	if f.Platform != "" && !validPlatform(f.Platform) {
		writeError(w, http.StatusBadRequest, "invalid_platform", "platform must be yt, tt, ig or fb.")
		return
	}
	if f.Verdict != "" && (lf.VerdictCode(f.Verdict) == 0) {
		writeError(w, http.StatusBadRequest, "invalid_verdict", "verdict must be one of the five verdicts.")
		return
	}
	if c := q.Get("cursor"); c != "" {
		id, err := strconv.ParseInt(strings.TrimPrefix(c, "log_"), 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_cursor", "The cursor is not valid.")
			return
		}
		f.Before = id
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be a number from 1 to 200.")
			return
		}
		f.Limit = min(n, 200)
	}
	limit := f.Limit
	f.Limit++
	list, err := s.Store.Log(r.Context(), f)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var next *string
	if len(list) > limit {
		list = list[:limit]
		c := "log_" + strconv.FormatInt(list[limit-1].ID, 10)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": toLogs(list), "next_cursor": next})
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := s.Now()
	counts, items, err := s.Store.VerdictCounts(ctx)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	decisions, err := s.Store.LogCountSince(ctx, now.Add(-7*24*time.Hour).Unix())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	open, median, err := s.Store.AppealStats(ctx)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	active, err := s.activeInstalls(ctx)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_, seq := s.Publisher.Snapshot()
	appeals := map[string]any{"open": open, "median_days": nil}
	if median.Valid {
		appeals["median_days"] = round2(median.Float64)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sources": counts, "items": items, "decisions_7d": decisions, "appeals": appeals,
		"active_installs": active, "list_sequence": seq.Seq, "list_updated_at": optTime(seq.CreatedAt),
	})
}
