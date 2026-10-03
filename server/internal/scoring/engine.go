package scoring

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/store"
	"github.com/rudecompany/colander/server/internal/youtube"
)

// Engine runs scoring against the store. Every verdict change goes through it, so every change
// writes a decision log entry and asks for a list publication.
type Engine struct {
	Store     *store.Store
	Th        Thresholds
	Now       func() time.Time
	Publisher *lf.Publisher   // nil in tools that do not publish
	YouTube   *youtube.Client // nil when YOUTUBE_API_KEY is unset
	Log       *slog.Logger

	// ponytail: one mutex serializes all scoring writes on this node; a full pass holds it for
	// its whole run. Per-source locks if passes grow long enough to delay reviewer decisions.
	mu sync.Mutex

	dirtyMu sync.Mutex
	dirty   map[int64]bool
	kick    chan struct{}
}

// NewEngine returns an engine with the default thresholds and the real clock.
func NewEngine(st *store.Store, pub *lf.Publisher, yt *youtube.Client, log *slog.Logger) *Engine {
	return &Engine{Store: st, Th: Default, Now: time.Now, Publisher: pub, YouTube: yt, Log: log,
		dirty: map[int64]bool{}, kick: make(chan struct{}, 1)}
}

// Cause attributes a change to a reviewer or an appeal instead of the scoring pass.
type Cause struct {
	ItemRef   int64 // the target the cause is about, 0 for the source
	Actor     string
	ActorName string
	Reason    string
	Always    bool // log the target even when its verdict does not change
}

// Run scores everything every pass interval and touched sources after the debounce, until ctx ends.
func (e *Engine) Run(ctx context.Context) {
	e.runPass(ctx)
	tick := time.NewTicker(e.Th.PassInterval)
	defer tick.Stop()
	var debounce <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			e.runPass(ctx)
		case <-e.kick:
			if debounce == nil {
				debounce = time.After(e.Th.Debounce)
			}
		case <-debounce:
			debounce = nil
			e.dirtyMu.Lock()
			refs := make([]int64, 0, len(e.dirty))
			for r := range e.dirty {
				refs = append(refs, r)
			}
			clear(e.dirty)
			e.dirtyMu.Unlock()
			for _, r := range refs {
				if err := e.Rescore(ctx, r, nil); err != nil && ctx.Err() == nil {
					e.Log.Error("rescore failed", "err", err)
				}
			}
		}
	}
}

func (e *Engine) runPass(ctx context.Context) {
	if _, err := e.FullPass(ctx); err != nil && ctx.Err() == nil {
		e.Log.Error("scoring pass failed", "err", err)
	}
}

// Touch schedules sources for a debounced rescore.
func (e *Engine) Touch(refs ...int64) {
	e.dirtyMu.Lock()
	for _, r := range refs {
		e.dirty[r] = true
	}
	e.dirtyMu.Unlock()
	select {
	case e.kick <- struct{}{}:
	default:
	}
}

func (e *Engine) requestPublish() {
	if e.Publisher != nil {
		e.Publisher.Request()
	}
}

// FullPass expires stale appeals, refreshes YouTube data and rescores every source.
// It returns the number of sources and items whose stored state changed.
// ponytail: every pass rescores every source (about 1 second per 13,000 sources); score only
// sources with new tags, due rescores or changed reputation once passes approach a minute.
func (e *Engine) FullPass(ctx context.Context) (int, error) {
	now := e.Now()
	if _, err := e.Store.ExpireAppeals(ctx, now.Add(-e.Th.AppealExpiry).Unix(), now.Unix()); err != nil {
		return 0, err
	}
	if e.YouTube != nil {
		// Network calls happen outside the scoring lock.
		if err := e.YouTube.EnrichStale(ctx, e.Store, now, 50); err != nil {
			e.Log.Warn("youtube enrichment failed", "err", err)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	start := time.Now()
	reps, err := e.Store.Reputation(ctx, 0)
	if err != nil {
		return 0, err
	}
	refs, err := e.Store.SourceRefs(ctx)
	if err != nil {
		return 0, err
	}
	changed := 0
	for _, ref := range refs {
		if ctx.Err() != nil {
			return changed, ctx.Err()
		}
		n, err := e.scoreSource(ctx, ref, reps, nil)
		if err != nil {
			return changed, fmt.Errorf("score source %d: %w", ref, err)
		}
		changed += n
	}
	e.Log.Info("scoring pass", "sources", len(refs), "changes", changed, "ms", time.Since(start).Milliseconds())
	// Always ask: the publisher only writes a sequence when the list really differs.
	e.requestPublish()
	return changed, nil
}

// Rescore scores one source and its items now. cause attributes the change in the log.
func (e *Engine) Rescore(ctx context.Context, ref int64, cause *Cause) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	n, err := e.scoreSource(ctx, ref, nil, cause)
	if n > 0 {
		e.requestPublish()
	}
	return err
}

// Evaluation is the scoring outcome for one source and its items, without writing anything.
type Evaluation struct {
	Data    *store.SourceData
	Input   Input
	Result  Result
	Items   []ItemEvaluation
	Burst   bool
	lapsing bool
}

// ItemEvaluation is the scoring outcome for one item.
type ItemEvaluation struct {
	Item    store.Item
	Input   Input
	Result  Result
	lapsing bool
}

// Evidence summarizes the community evidence on a source for its public page.
type Evidence struct {
	Taggers       int
	Slop          int
	AIFine        int
	NotSlop       int
	ItemsSeen     int
	AIItemShare   float64 // valid when ItemsSeen > 0
	UploadsPerDay float64 // < 0 when unknown
}

// Evidence returns the source's public evidence summary.
func (ev *Evaluation) Evidence() Evidence {
	out := Evidence{Taggers: len(ev.Input.Votes), ItemsSeen: ev.Input.ItemsSeen, UploadsPerDay: ev.Input.UploadsPerDay}
	for _, v := range ev.Input.Votes {
		switch v.Verdict {
		case "slop":
			out.Slop++
		case "ai_fine":
			out.AIFine++
		case "not_slop":
			out.NotSlop++
		}
	}
	if out.ItemsSeen > 0 {
		out.AIItemShare = float64(ev.Input.AIItems) / float64(out.ItemsSeen)
	}
	return out
}

// Explain evaluates a source with fresh reputation data and returns the outcome without writing.
func (e *Engine) Explain(ctx context.Context, ref int64) (*Evaluation, error) {
	reps, err := e.Store.Reputation(ctx, ref)
	if err != nil {
		return nil, err
	}
	d, err := e.Store.LoadSourceData(ctx, ref, e.Now().Unix())
	if err != nil {
		return nil, err
	}
	return e.evaluate(d, reps, e.Now()), nil
}

func (e *Engine) weights(reps map[string]store.Rep, now time.Time) func(string) float64 {
	return func(install string) float64 {
		r, ok := reps[install]
		if !ok {
			return e.Th.Weight(now, now, 0, 0)
		}
		return e.Th.Weight(time.Unix(r.FirstTagAt, 0), now, r.Agree, r.Decided)
	}
}

func toDecision(d *store.Decision) *Decision {
	if d == nil {
		return nil
	}
	return &Decision{Verdict: d.Verdict, Signals: d.Signals, SlopType: lf.SlopTypes[d.Detail&3], Tests: d.Detail &^ 3}
}

func isLapsing(st store.State, now int64) bool {
	return st.Verdict != "" && st.RescoreAt > 0 && now >= st.RescoreAt
}

func (e *Engine) evaluate(d *store.SourceData, reps map[string]store.Rep, now time.Time) *Evaluation {
	weight := e.weights(reps, now)
	src := d.Source
	ev := &Evaluation{Data: d}
	// The source with an empty ID holds items tagged without their source: each is scored on its
	// own, and nothing rolls up to it or freezes it.
	unattributed := src.CanonicalID == ""

	// Tag sums are per target (9.2): the source's sums come from tags on the source itself, one per
	// install even when it tagged two aliases. Item evidence reaches the source only through platform
	// labels and the 80% rule (9.3).
	perInstall := map[string]store.Vote{}
	labelInstalls, rollupLabels := map[string]bool{}, map[string]bool{}
	byItem := map[int64][]store.Vote{}
	burst := 0
	for _, v := range d.Votes {
		if v.PlatformLabel {
			rollupLabels[v.Install] = true
			if v.ItemRef == 0 {
				labelInstalls[v.Install] = true
			}
		}
		if v.ItemRef != 0 {
			byItem[v.ItemRef] = append(byItem[v.ItemRef], v)
		} else if cur, ok := perInstall[v.Install]; !ok || v.CreatedAt > cur.CreatedAt {
			perInstall[v.Install] = v
		}
		if v.Verdict == "slop" && now.Unix()-v.ReceivedAt < int64(e.Th.BurstWindow.Seconds()) &&
			now.Unix()-v.InstallCreatedAt < int64(e.Th.BurstInstallAge.Seconds()) {
			burst++
		}
	}
	toVote := func(v store.Vote) Vote {
		return Vote{Weight: weight(v.Install), Verdict: v.Verdict, SlopType: v.SlopType, Tests: v.Tests, PlatformLabel: v.PlatformLabel}
	}

	frozen := src.FrozenUntil > now.Unix()
	if !frozen && !unattributed && burst > e.Th.BurstTags {
		ev.Burst, frozen = true, true
	}

	// Items first: their AI evidence feeds the source's 80% rule. Only independent evidence makes an
	// item count as AI-made there: platform labels from enough installs or a reviewer decision, never
	// tags agreeing it is AI, so tags alone cannot make a source look mass-produced (9.3).
	aiItems, seen := 0, 0
	for _, it := range d.Items {
		in := Input{Item: true, Decision: toDecision(d.Decisions[it.Ref]), AppealOpen: d.AppealOpen, Frozen: frozen,
			LapseHold: it.State.LapseHold || isLapsing(it.State, now.Unix()), UploadsPerDay: -1}
		for _, v := range byItem[it.Ref] {
			in.Votes = append(in.Votes, toVote(v))
			if v.PlatformLabel {
				in.LabelInstalls++
			}
		}
		sums := SumVotes(in.Votes)
		dec := in.Decision
		switch {
		case dec != nil && (dec.Verdict == "slop" || dec.Verdict == "likely_slop" || dec.Verdict == "ai_made"):
			aiItems++
			seen++
		case dec != nil && dec.Verdict == "clear":
			seen++
		case in.LabelInstalls >= e.Th.LabelInstalls:
			aiItems++
			seen++
		case sums.N > 0 && sums.N > sums.S+sums.A:
			seen++
		}
		ev.Items = append(ev.Items, ItemEvaluation{Item: it, Input: in, lapsing: isLapsing(it.State, now.Unix())})
	}

	if unattributed {
		aiItems, seen, rollupLabels = 0, 0, nil
	}
	in := Input{
		Decision:            toDecision(d.Decisions[0]),
		AppealOpen:          d.AppealOpen,
		Frozen:              frozen,
		Imported:            src.ImportList,
		Reviewed:            src.ReviewedAt > 0,
		Large:               src.LargeStaff || (src.Subscribers.Valid && src.Subscribers.Int64 >= e.Th.LargeSubscribers),
		AudienceKnown:       src.Subscribers.Valid || src.SizeReviewedAt > 0,
		UploadsPerDay:       -1,
		ItemsSeen:           seen,
		AIItems:             aiItems,
		LabelInstalls:       len(labelInstalls),
		RollupLabelInstalls: len(rollupLabels),
	}
	if src.UploadsPerDay.Valid {
		in.UploadsPerDay = src.UploadsPerDay.Float64
	}
	ev.lapsing = isLapsing(src.State, now.Unix())
	in.LapseHold = src.State.LapseHold || ev.lapsing
	for _, v := range perInstall {
		in.Votes = append(in.Votes, toVote(v))
	}
	ev.Input, ev.Result = in, e.Th.Score(in)

	for i := range ev.Items {
		ev.Items[i].Input.SourceBehavior = ev.Result.Behavior
		ev.Items[i].Input.SourceVerdict = ev.Result.Verdict
		ev.Items[i].Input.SourceMixed = ev.Result.Mixed
		ev.Items[i].Result = e.Th.Score(ev.Items[i].Input)
	}
	return ev
}

// nextState turns a result into the stored state, keeping timestamps when the verdict is unchanged.
func (e *Engine) nextState(old store.State, r Result, in Input, dec *store.Decision, lapsing bool, now int64) store.State {
	st := store.State{Verdict: r.Verdict, Signals: r.Signals, Detail: lf.SlopTypeCode(r.SlopType) | r.Tests,
		Computed: r.Computed, ChangedAt: old.ChangedAt, RescoreAt: old.RescoreAt}
	if !in.Item {
		st.Mixed = r.Mixed
		if in.Large {
			st.Flags |= lf.FlagLarge
		}
		if in.Imported != "" && !in.Reviewed {
			st.Flags |= lf.FlagImported
		}
	}
	if r.Rule == 2 && r.Verdict != "" {
		st.Flags |= lf.FlagStaffReviewed
	}
	changed := old.Verdict != r.Verdict
	if changed {
		st.ChangedAt = now
	}
	switch {
	case r.Verdict == "":
		st.RescoreAt = 0
	case r.Rule == 2:
		st.RescoreAt = dec.ExpiresAt
	case changed || lapsing || old.RescoreAt == 0:
		st.RescoreAt = now + int64(e.Th.Rescore.Seconds())
	}
	st.LapseHold = (old.LapseHold || (lapsing && r.Rule == 6)) && r.Rule != 2
	return st
}

// scoreSource evaluates one source and writes what changed. It returns the number of targets changed.
func (e *Engine) scoreSource(ctx context.Context, ref int64, reps map[string]store.Rep, cause *Cause) (int, error) {
	now := e.Now()
	d, err := e.Store.LoadSourceData(ctx, ref, now.Unix())
	if errors.Is(err, store.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if reps == nil {
		if reps, err = e.Store.Reputation(ctx, ref); err != nil {
			return 0, err
		}
	}
	ev := e.evaluate(d, reps, now)
	src := d.Source
	if ev.Burst {
		until := now.Add(e.Th.BurstFreeze).Unix()
		if err := e.Store.SetFrozen(ctx, ref, until); err != nil {
			return 0, err
		}
		err := e.Store.SyncEscalations(ctx, ref, 0, nil, map[string]string{
			"burst": fmt.Sprintf("Burst of slop tags from new installs: consensus frozen for %d hours", int(e.Th.BurstFreeze.Hours())),
		}, now.Unix())
		if err != nil {
			return 0, err
		}
	}

	changed := 0
	apply := func(itemRef int64, targetID string, old store.State, r Result, in Input, lapsing bool) error {
		dec := d.Decisions[itemRef]
		st := e.nextState(old, r, in, dec, lapsing, now.Unix())
		forced := cause != nil && cause.Always && cause.ItemRef == itemRef
		if st == old && !forced {
			return nil
		}
		u := store.Update{SourceRef: ref, ItemRef: itemRef, Expect: old.Verdict, State: st}
		if old.Verdict != st.Verdict || forced {
			targetType := "source"
			if itemRef != 0 {
				targetType = "item"
			}
			u.Log = &store.LogEntry{At: now.Unix(), Platform: src.Platform, TargetType: targetType, TargetID: targetID,
				SourceRef: ref, SourceKey: src.CanonicalID, SourceName: src.Name, From: old.Verdict, To: st.Verdict,
				Signals: st.Signals, Actor: "community"}
			switch {
			case cause != nil && cause.ItemRef == itemRef:
				u.Log.Actor, u.Log.ActorName, u.Log.Reason = cause.Actor, cause.ActorName, cause.Reason
			case r.Rule == 2 && dec != nil:
				u.Log.Actor, u.Log.ActorName, u.Log.Reason = dec.Actor, dec.ActorName, dec.Reason
			case r.Rule == 1:
				u.Log.Actor, u.Log.Reason = "appeal", communityReason(r, in, src.ImportSource)
			default:
				u.Log.Reason = communityReason(r, in, src.ImportSource)
			}
		}
		ok, err := e.Store.ApplyUpdate(ctx, u)
		if ok {
			changed++
		}
		return err
	}

	for _, it := range ev.Items {
		if err := apply(it.Item.Ref, it.Item.ItemID, it.Item.State, it.Result, it.Input, it.lapsing); err != nil {
			return changed, err
		}
		want := map[string]string{}
		if it.Result.Rule == 6 && it.Result.CappedBy == "lapsed" && it.Result.Verdict != "" {
			want["lapsed"] = "Item " + it.Item.ItemID + ": " + escalationSummary("lapsed")
		}
		if err := e.Store.SyncEscalations(ctx, ref, it.Item.Ref, []string{"lapsed"}, want, now.Unix()); err != nil {
			return changed, err
		}
	}
	if err := apply(0, src.CanonicalID, src.State, ev.Result, ev.Input, ev.lapsing); err != nil {
		return changed, err
	}
	want := map[string]string{}
	switch r := ev.Result; {
	case r.Rule == 6 && r.CappedBy == "lapsed":
		want["lapsed"] = escalationSummary("lapsed")
	case r.Rule == 6 && r.CappedBy != "":
		want["capped"] = escalationSummary(r.CappedBy)
	}
	// A new list verdict closes the open reports (6.3), so they no longer count.
	openReports := d.OpenReports
	if ev.Result.Verdict != "" && ev.Result.Verdict != src.State.Verdict {
		openReports = 0
	}
	if openReports >= e.Th.ReportEscalation {
		want["reports"] = fmt.Sprintf("%d or more open reports", e.Th.ReportEscalation)
	}
	err = e.Store.SyncEscalations(ctx, ref, 0, []string{"capped", "lapsed", "reports"}, want, now.Unix())
	return changed, err
}
