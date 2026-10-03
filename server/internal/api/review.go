package api

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/store"
)

// reviewer authenticates a curator or staff member by bearer token or session cookie.
func (s *Server) reviewer(w http.ResponseWriter, r *http.Request) (*store.Account, bool) {
	var a *store.Account
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		acct, err := s.Auth.ReviewerAccount(r.Context(), strings.TrimSpace(token))
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "The reviewer token is not valid. Create a new one on the website.")
			return nil, false
		}
		if err != nil {
			s.internalError(w, r, err)
			return nil, false
		}
		a = acct
	} else {
		acct, ok := s.session(w, r)
		if !ok {
			return nil, false
		}
		a = acct
	}
	if a.Role != "curator" && a.Role != "staff" {
		writeError(w, http.StatusForbidden, "forbidden", "Only curators and staff can review.")
		return nil, false
	}
	return a, true
}

func staffRequired(w http.ResponseWriter, what string) {
	writeError(w, http.StatusForbidden, "staff_required", what+" need staff review.")
}

type queueJSON struct {
	ID              string  `json:"id"`
	Kind            string  `json:"kind"`
	Priority        int     `json:"priority"`
	CreatedAt       string  `json:"created_at"`
	Platform        string  `json:"platform"`
	SourceID        string  `json:"source_id"`
	SourceName      *string `json:"source_name"`
	Summary         string  `json:"summary"`
	Large           bool    `json:"large"`
	Verdict         *string `json:"verdict"`
	ComputedVerdict *string `json:"computed_verdict"`
	ReportCount     int     `json:"report_count"`
	created         int64
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func (s *Server) reviewQueue(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.reviewer(w, r); !ok {
		return
	}
	ctx := r.Context()
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "all"
	}
	if kind != "all" && kind != "reports" && kind != "appeals" && kind != "escalations" {
		writeError(w, http.StatusBadRequest, "invalid_kind", "kind must be all, reports, appeals or escalations.")
		return
	}
	offset := 0
	if c := r.URL.Query().Get("cursor"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid_cursor", "The cursor is not valid.")
			return
		}
		offset = n
	}

	reports, err := s.Store.OpenReports(ctx)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	bySource := map[int64][]store.Report{}
	for _, rp := range reports {
		bySource[rp.SourceRef] = append(bySource[rp.SourceRef], rp)
	}
	sources := map[int64]*store.Source{}
	var items []queueJSON
	add := func(ref int64, q queueJSON) error {
		src, ok := sources[ref]
		if !ok {
			var err error
			if src, err = s.Store.GetSource(ctx, ref); err != nil {
				return err
			}
			sources[ref] = src
		}
		q.Platform, q.SourceID, q.SourceName = src.Platform, src.CanonicalID, optString(src.Name)
		q.Large = src.State.Flags&lf.FlagLarge != 0 || src.LargeStaff
		q.Verdict, q.ComputedVerdict = optString(src.State.Verdict), optString(src.State.Computed)
		q.ReportCount = len(bySource[ref])
		if q.Large && q.Priority > 1 {
			q.Priority-- // triage by audience size
		}
		q.CreatedAt = rfc3339(q.created)
		items = append(items, q)
		return nil
	}

	if kind == "all" || kind == "appeals" {
		appeals, err := s.Store.AppealsWithStatus(ctx, store.AppealPendingManual, store.AppealUnderReview)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		for _, a := range appeals {
			summary := "Appeal under review: " + clip(a.Statement, 80)
			if a.Status == store.AppealPendingManual {
				summary = "Appeal waiting for a manual check of code " + a.Code
			}
			if err := add(a.SourceRef, queueJSON{ID: "q_" + a.ID, Kind: "appeal", Priority: 1, Summary: summary, created: a.CreatedAt}); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
	}
	if kind == "all" || kind == "escalations" {
		escalations, err := s.Store.OpenEscalations(ctx)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		for _, e := range escalations {
			q := queueJSON{ID: "q_esc_" + strconv.FormatInt(e.ID, 10), Kind: "escalation", Priority: 2, Summary: e.Summary, created: e.CreatedAt}
			if err := add(e.SourceRef, q); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
	}
	if kind == "all" || kind == "reports" {
		for ref, list := range bySource {
			summary := fmt.Sprintf("%d reports: %s", len(list), clip(list[0].Reason, 60))
			if len(list) == 1 {
				summary = "1 report: " + clip(list[0].Reason, 60)
			}
			q := queueJSON{ID: "q_rpt_" + strconv.FormatInt(ref, 10), Kind: "report", Priority: 3, Summary: summary, created: list[0].CreatedAt}
			if err := add(ref, q); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if a.created != b.created {
			return a.created < b.created
		}
		return a.ID < b.ID
	})
	const page = 50
	var next *string
	if offset > len(items) {
		offset = len(items)
	}
	end := min(offset+page, len(items))
	if end < len(items) {
		c := strconv.Itoa(end)
		next = &c
	}
	out := items[offset:end]
	if out == nil {
		out = []queueJSON{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "next_cursor": next})
}

type layerJSON struct {
	Met     bool     `json:"met"`
	Signals []string `json:"signals"`
	Detail  string   `json:"detail"`
}

// layers explains each evidence layer in one plain sentence for the review console.
func layers(ev *scoring.Evaluation) map[string]layerJSON {
	r, in, src := ev.Result, ev.Input, ev.Data.Source
	var prov []string
	if in.LabelInstalls > 0 {
		prov = append(prov, fmt.Sprintf("%d installs saw a platform AI label", in.LabelInstalls))
	}
	if src.ImportList != "" {
		prov = append(prov, fmt.Sprintf("imported from %s (%s) as a %s entry", src.ImportSource, src.ImportLicense, src.ImportList))
	}
	if r.Provenance.Met && r.Provenance.Signals == 0 && src.ImportList == "" {
		prov = append(prov, "taggers agree it is AI-made")
	}
	var beh []string
	if in.UploadsPerDay >= 0 {
		beh = append(beh, fmt.Sprintf("about %.1f uploads a day over the last 14 days", in.UploadsPerDay))
	}
	if in.ItemsSeen > 0 {
		beh = append(beh, fmt.Sprintf("%d of %d items with evidence carry AI evidence", in.AIItems, in.ItemsSeen))
	}
	if r.Mixed {
		beh = append(beh, "mixed source, so items are judged one by one")
	}
	sums := r.Sums
	cons := fmt.Sprintf("weighted tags: slop %.1f, AI-made but fine %.1f, not slop %.1f from %d installs", sums.S, sums.A, sums.N, sums.Installs)
	if in.Frozen {
		cons += "; frozen after a burst of tags from new installs"
	}
	rub := "needs slop tags with at least two tests chosen by half the weight"
	if t := lf.TestNames(r.Tests); len(t) > 0 && sums.S >= 1 {
		rub = "tests chosen: " + strings.ReplaceAll(strings.Join(t, ", "), "_", " ")
	}
	sentence := func(parts []string, none string) string {
		if len(parts) == 0 {
			return none
		}
		s := strings.Join(parts, "; ")
		return strings.ToUpper(s[:1]) + s[1:] + "."
	}
	return map[string]layerJSON{
		"provenance": {r.Provenance.Met, lf.SignalNames(r.Provenance.Signals), sentence(prov, "No AI evidence yet.")},
		"behavior":   {r.Behavior.Met, lf.SignalNames(r.Behavior.Signals), sentence(beh, "No sign of mass production yet.")},
		"rubric":     {r.Rubric.Met, lf.SignalNames(r.Rubric.Signals), sentence([]string{rub}, "")},
		"consensus":  {r.Consensus.Met, lf.SignalNames(r.Consensus.Signals), sentence([]string{cons}, "")},
	}
}

type reportDetailJSON struct {
	reportJSON
	Reason   string   `json:"reason"`
	Examples []string `json:"examples"`
	SlopType *string  `json:"slop_type"`
	Tests    []string `json:"tests"`
}

func toReportDetail(rp store.Report, active int64) reportDetailJSON {
	return reportDetailJSON{reportJSON: toReport(rp, active), Reason: rp.Reason, Examples: rp.Examples,
		SlopType: optString(rp.SlopType), Tests: lf.TestNames(rp.Tests)}
}

type itemJSON struct {
	Platform             string    `json:"platform"`
	ID                   string    `json:"id"`
	Verdict              *string   `json:"verdict"`
	Signals              []string  `json:"signals"`
	Tags                 tagCounts `json:"tags"`
	PlatformLabelReports int       `json:"platform_label_reports"`
}

func toItems(ev *scoring.Evaluation) []itemJSON {
	out := make([]itemJSON, 0, len(ev.Items))
	for _, it := range ev.Items {
		j := itemJSON{Platform: it.Item.Platform, ID: it.Item.ItemID, Verdict: optString(it.Item.State.Verdict),
			Signals: lf.SignalNames(it.Item.State.Signals), PlatformLabelReports: it.Input.LabelInstalls}
		for _, v := range it.Input.Votes {
			switch v.Verdict {
			case "slop":
				j.Tags.Slop++
			case "ai_fine":
				j.Tags.AIFine++
			case "not_slop":
				j.Tags.NotSlop++
			}
		}
		out = append(out, j)
	}
	return out
}

func (s *Server) reviewSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.reviewer(w, r); !ok {
		return
	}
	ref, ok := s.lookupSource(w, r)
	if !ok {
		return
	}
	s.writeReviewSource(w, r, ref)
}

func (s *Server) writeReviewSource(w http.ResponseWriter, r *http.Request, ref int64) {
	ctx := r.Context()
	ev, err := s.Engine.Explain(ctx, ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	reports, err := s.Store.ReportsBySource(ctx, ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	appeals, err := s.Store.AppealsBySource(ctx, ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	history, err := s.Store.Log(ctx, store.LogFilter{SourceRef: ref, Limit: 100})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	active, err := s.activeInstalls(ctx)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	details := make([]reportDetailJSON, len(reports))
	for i, rp := range reports {
		details[i] = toReportDetail(rp, active)
	}
	writeJSON(w, http.StatusOK, map[string]any{"source": toSource(ev), "layers": layers(ev), "reports": details,
		"appeals": toAppeals(appeals), "items": toItems(ev), "history": toLogs(history)})
}

type decisionBody struct {
	Verdict  string   `json:"verdict"`
	Reason   string   `json:"reason"`
	Signals  []string `json:"signals"`
	SlopType *string  `json:"slop_type"`
	Tests    []string `json:"tests"`
	Large    *bool    `json:"large"`
	SourceID string   `json:"source_id"`
}

// decisionInput validates a decision body. Only provenance and behavior signals are recorded;
// the other signals are computed and never set by hand.
func decisionInput(w http.ResponseWriter, b decisionBody, a *store.Account) (scoring.DecisionInput, bool) {
	in := scoring.DecisionInput{Verdict: b.Verdict, Reason: strings.TrimSpace(b.Reason), Actor: a.Role, AccountID: a.ID,
		ActorName: a.DisplayName, Large: b.Large}
	if b.Verdict != "none" && lf.VerdictCode(b.Verdict) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_verdict", "verdict must be one of the five verdicts or none.")
		return in, false
	}
	if n := utf8.RuneCountInString(in.Reason); n < 1 || n > 500 {
		writeError(w, http.StatusBadRequest, "invalid_reason", "The reason must be 1 to 500 characters. It is published in the decision log.")
		return in, false
	}
	signals, err := lf.SignalMask(b.Signals)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_signals", err.Error())
		return in, false
	}
	in.Signals = signals & (lf.ProvenanceSignals | lf.BehaviorSignals)
	if b.SlopType != nil && *b.SlopType != "" {
		if lf.SlopTypeCode(*b.SlopType) == 0 {
			writeError(w, http.StatusBadRequest, "invalid_slop_type", "slop_type must be filler, bait or deceptive.")
			return in, false
		}
		in.SlopType = *b.SlopType
	}
	if in.Tests, err = lf.TestBits(b.Tests); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_tests", "tests may hold low_effort, mass_produced and hollow.")
		return in, false
	}
	return in, true
}

func (s *Server) reviewSourceDecision(w http.ResponseWriter, r *http.Request) {
	a, ok := s.reviewer(w, r)
	if !ok {
		return
	}
	var body decisionBody
	if !decode(w, r, 16<<10, &body) {
		return
	}
	in, ok := decisionInput(w, body, a)
	if !ok {
		return
	}
	platform := r.PathValue("platform")
	id, valid := CanonicalSource(platform, r.PathValue("source_id"))
	if !validPlatform(platform) || !valid {
		writeError(w, http.StatusBadRequest, "invalid_source", "That is not a canonical source ID for this platform.")
		return
	}
	ctx := r.Context()
	ref, err := s.Store.EnsureSource(ctx, platform, id, "", s.Now().Unix())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	src, err := s.Store.GetSource(ctx, ref)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	large := src.LargeStaff || src.State.Flags&lf.FlagLarge != 0 ||
		(src.Subscribers.Valid && src.Subscribers.Int64 >= s.Engine.Th.LargeSubscribers)
	if a.Role != "staff" && (large || body.Large != nil) {
		staffRequired(w, "Large sources")
		return
	}
	in.SourceRef = ref
	if err := s.Engine.Decide(ctx, in); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.writeReviewSource(w, r, ref)
}

func (s *Server) reviewItemDecision(w http.ResponseWriter, r *http.Request) {
	a, ok := s.reviewer(w, r)
	if !ok {
		return
	}
	var body decisionBody
	if !decode(w, r, 16<<10, &body) {
		return
	}
	in, ok := decisionInput(w, body, a)
	if !ok {
		return
	}
	if body.Large != nil {
		writeError(w, http.StatusBadRequest, "invalid_large", "large applies to sources, not items.")
		return
	}
	platform := r.PathValue("platform")
	itemID, valid := CanonicalItem(platform, r.PathValue("item_id"))
	if !validPlatform(platform) || !valid {
		writeError(w, http.StatusBadRequest, "invalid_target", "That is not a canonical item ID for this platform.")
		return
	}
	ctx := r.Context()
	now := s.Now().Unix()
	item, err := s.Store.FindItem(ctx, platform, itemID)
	if errors.Is(err, store.ErrNotFound) {
		sourceID, ok := CanonicalSource(platform, body.SourceID)
		if !ok {
			writeError(w, http.StatusBadRequest, "missing_source", "source_id is required for an item Colander has not seen.")
			return
		}
		ref, err := s.Store.EnsureSource(ctx, platform, sourceID, "", now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if _, err := s.Store.EnsureItem(ctx, platform, itemID, ref, now); err != nil {
			s.internalError(w, r, err)
			return
		}
		item, err = s.Store.FindItem(ctx, platform, itemID)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	in.SourceRef, in.ItemRef = item.SourceRef, item.Ref
	if err := s.Engine.Decide(ctx, in); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.writeReviewSource(w, r, item.SourceRef)
}

func (s *Server) reviewDismissReport(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.reviewer(w, r); !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if n := utf8.RuneCountInString(reason); n < 1 || n > 500 {
		writeError(w, http.StatusBadRequest, "invalid_reason", "The reason must be 1 to 500 characters.")
		return
	}
	ctx := r.Context()
	err := s.Store.DismissReport(ctx, r.PathValue("id"), reason, s.Now().Unix())
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "No report has this ID.")
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "report_closed", "This report is already closed.")
		return
	case err != nil:
		s.internalError(w, r, err)
		return
	}
	rp, err := s.Store.GetReport(ctx, r.PathValue("id"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Engine.Touch(rp.SourceRef)
	writeJSON(w, http.StatusOK, map[string]any{"report": toReportDetail(*rp, 0)})
}

// staffAppeal loads the appeal for a staff-only appeal route.
func (s *Server) staffAppeal(w http.ResponseWriter, r *http.Request) (*store.Account, *store.Appeal, bool) {
	a, ok := s.reviewer(w, r)
	if !ok {
		return nil, nil, false
	}
	if a.Role != "staff" {
		staffRequired(w, "Appeals")
		return nil, nil, false
	}
	ap, err := s.Store.GetAppeal(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "No appeal has this ID.")
		return nil, nil, false
	}
	if err != nil {
		s.internalError(w, r, err)
		return nil, nil, false
	}
	return a, ap, true
}

func (s *Server) appealConflict(w http.ResponseWriter, r *http.Request, err error, id string) {
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "appeal_state", "The appeal is not in a state that allows this.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.respondAppeal(w, r, id)
}

func (s *Server) reviewVerifyAppeal(w http.ResponseWriter, r *http.Request) {
	_, ap, ok := s.staffAppeal(w, r)
	if !ok {
		return
	}
	var body struct{}
	if r.ContentLength > 0 && !decode(w, r, 1<<10, &body) {
		return
	}
	s.appealConflict(w, r, s.Engine.VerifyAppeal(r.Context(), ap), ap.ID)
}

func (s *Server) reviewResolveAppeal(w http.ResponseWriter, r *http.Request) {
	a, ap, ok := s.staffAppeal(w, r)
	if !ok {
		return
	}
	var body struct {
		Outcome   string `json:"outcome"`
		Reasoning string `json:"reasoning"`
	}
	if !decode(w, r, 8<<10, &body) {
		return
	}
	reasoning := strings.TrimSpace(body.Reasoning)
	if body.Outcome != "upheld" && body.Outcome != "denied" {
		writeError(w, http.StatusBadRequest, "invalid_outcome", "outcome must be upheld or denied.")
		return
	}
	if n := utf8.RuneCountInString(reasoning); n < 1 || n > 1000 {
		writeError(w, http.StatusBadRequest, "invalid_reasoning", "The reasoning must be 1 to 1,000 characters. It is published in the decision log.")
		return
	}
	s.appealConflict(w, r, s.Engine.ResolveAppeal(r.Context(), ap, body.Outcome, reasoning, a), ap.ID)
}
