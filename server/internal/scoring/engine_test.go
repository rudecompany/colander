package scoring

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/store"
)

type fixture struct {
	t     *testing.T
	ctx   context.Context
	st    *store.Store
	eng   *Engine
	clock time.Time
	n     int
}

func newFixture(t *testing.T) *fixture {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &fixture{t: t, ctx: ctx, st: st, clock: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)}
	f.eng = NewEngine(st, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.eng.Now = func() time.Time { return f.clock }
	return f
}

// tags has n new installs tag a YouTube source; installs are created at the current clock.
func (f *fixture) tags(n int, source, verdict string, label bool) []string {
	var installs []string
	for range n {
		f.n++
		h := fmt.Sprintf("install-%04d", f.n)
		installs = append(installs, h)
		_, err := f.st.SaveTags(f.ctx, h, []store.TagInput{{ClientID: fmt.Sprintf("c%d", f.n), Platform: "yt", TargetType: "source",
			TargetID: source, SourceID: source, Verdict: verdict, Tests: lf.TestLowEffort | lf.TestMassProduced,
			PlatformLabel: label, CreatedAt: f.clock.Unix()}}, f.clock.Unix())
		if err != nil {
			f.t.Fatal(err)
		}
	}
	return installs
}

func (f *fixture) source(alias string) *store.Source {
	ref, err := f.st.FindSource(f.ctx, "yt", alias)
	if err != nil {
		f.t.Fatal(err)
	}
	src, err := f.st.GetSource(f.ctx, ref)
	if err != nil {
		f.t.Fatal(err)
	}
	return src
}

func (f *fixture) pass() {
	if err := f.eng.FullPass(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) escalations() map[string]bool {
	list, err := f.st.OpenEscalations(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]bool{}
	for _, e := range list {
		out[e.Kind] = true
	}
	return out
}

// highVolume records YouTube data showing 20 uploads a day, the behavior layer.
func (f *fixture) highVolume(alias string) {
	ref := f.source(alias).Ref
	if _, err := f.st.SetYouTube(f.ctx, ref, store.YouTubeInfo{ChannelID: "UCzzzzzzzzzzzzzzzzzzzzz1", Handle: alias,
		UploadsPerDay: sql.NullFloat64{Float64: 20, Valid: true}}, f.clock.Unix()); err != nil {
		f.t.Fatal(err)
	}
}

// A staff Slop decision lapses after 90 days; scored again as Slop, the source holds at Likely
// slop with an escalation until staff look again.
func TestExpiryLapse(t *testing.T) {
	f := newFixture(t)
	f.tags(8, "@farm", "slop", true)
	f.highVolume("@farm")
	f.clock = f.clock.Add(40 * 24 * time.Hour) // the taggers mature
	f.pass()
	src := f.source("@farm")
	if src.State.Verdict != "slop" {
		t.Fatalf("community verdict = %q, want slop", src.State.Verdict)
	}
	if err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: src.Ref, Verdict: "slop", Reason: "Confirmed.", Actor: "staff"}); err != nil {
		t.Fatal(err)
	}
	src = f.source("@farm")
	if src.State.Flags&lf.FlagStaffReviewed == 0 || src.State.RescoreAt != f.clock.Add(90*24*time.Hour).Unix() {
		t.Fatalf("after decision: %+v", src.State)
	}

	f.clock = f.clock.Add(91 * 24 * time.Hour)
	f.pass()
	src = f.source("@farm")
	if src.State.Verdict != "likely_slop" || !src.State.LapseHold || src.State.Flags&lf.FlagStaffReviewed != 0 {
		t.Fatalf("after lapse: %+v", src.State)
	}
	if !f.escalations()["lapsed"] {
		t.Fatal("no lapsed escalation")
	}
	// The hold stays through later passes, and a new decision lifts it.
	f.pass()
	if f.source("@farm").State.Verdict != "likely_slop" {
		t.Fatal("hold did not last")
	}
	if err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: src.Ref, Verdict: "slop", Reason: "Still slop.", Actor: "staff"}); err != nil {
		t.Fatal(err)
	}
	if s := f.source("@farm").State; s.Verdict != "slop" || s.LapseHold || f.escalations()["lapsed"] {
		t.Fatalf("after review: %+v, escalations %v", s, f.escalations())
	}
}

// More than 20 slop tags in an hour from installs younger than 7 days freeze consensus for 72 hours.
func TestBurstFreeze(t *testing.T) {
	f := newFixture(t)
	f.tags(3, "@target", "ai_fine", true)
	f.highVolume("@target")
	f.clock = f.clock.Add(40 * 24 * time.Hour)
	f.tags(25, "@target", "slop", true)
	f.clock = f.clock.Add(10 * time.Minute)
	f.pass()
	src := f.source("@target")
	if src.FrozenUntil != f.clock.Add(72*time.Hour).Unix() || !f.escalations()["burst"] {
		t.Fatalf("frozen until %d, escalations %v", src.FrozenUntil, f.escalations())
	}
	if src.State.Verdict == "slop" || src.State.Signals&lf.SigCommunityConsensus != 0 {
		t.Fatalf("frozen source reached %q with signals %v", src.State.Verdict, lf.SignalNames(src.State.Signals))
	}
}

// A denied appeal restores the scored verdict and logs the outcome; the log shows the whole story.
func TestAppealDeniedRestores(t *testing.T) {
	f := newFixture(t)
	f.tags(8, "@farm", "slop", true)
	f.highVolume("@farm")
	f.clock = f.clock.Add(40 * 24 * time.Hour)
	f.pass()
	ref := f.source("@farm").Ref
	a, err := f.st.CreateAppeal(f.ctx, store.Appeal{Platform: "yt", SourceRef: ref, Email: "x@example.test", Statement: "Not slop.",
		Code: "colander-TEST0001", SecretHash: "h", CreatedAt: f.clock.Unix()})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.eng.VerifyAppeal(f.ctx, a); err != nil {
		t.Fatal(err)
	}
	if v := f.source("@farm").State.Verdict; v != "disputed" {
		t.Fatalf("verified appeal: %q, want disputed", v)
	}
	rae, err := f.st.GrantRole(f.ctx, "rae@colander.test", "staff", f.clock.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if err := f.eng.ResolveAppeal(f.ctx, a, "denied", "Twenty generated uploads a day.", rae); err != nil {
		t.Fatal(err)
	}
	if v := f.source("@farm").State.Verdict; v != "slop" {
		t.Fatalf("denied appeal: %q, want the scored slop back", v)
	}
	log, err := f.st.Log(f.ctx, store.LogFilter{SourceRef: ref, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 3 || log[0].Actor != "appeal" || log[0].From != "disputed" || log[0].To != "slop" || log[2].Actor != "community" {
		t.Fatalf("log = %+v", log)
	}
}

// An unverified appeal expires after 14 days and never changes the verdict.
func TestAppealExpires(t *testing.T) {
	f := newFixture(t)
	f.tags(1, "@x", "slop", false)
	ref := f.source("@x").Ref
	a, err := f.st.CreateAppeal(f.ctx, store.Appeal{Platform: "yt", SourceRef: ref, Email: "x@example.test", Statement: "s",
		Code: "c", SecretHash: "h", CreatedAt: f.clock.Unix()})
	if err != nil {
		t.Fatal(err)
	}
	f.clock = f.clock.Add(15 * 24 * time.Hour)
	f.pass()
	if a, _ = f.st.GetAppeal(f.ctx, a.ID); a.Status != store.AppealExpired {
		t.Fatalf("status %s, want expired", a.Status)
	}
}

// Reputation reads tagging history only: an install with a trial and synced settings weighs
// exactly what an identical install without them weighs.
func TestReputationIgnoresPlanState(t *testing.T) {
	f := newFixture(t)
	installs := f.tags(2, "@farm", "slop", true)
	if err := f.st.StartTrial(f.ctx, installs[0], "trl_test", f.clock.Unix(), f.clock.Add(14*24*time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.PutSync(f.ctx, "trl_test", 0, `{"strictness":"strict"}`, f.clock.Unix()); err != nil {
		t.Fatal(err)
	}
	reps, err := f.st.Reputation(f.ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	a, b := reps[installs[0]], reps[installs[1]]
	if a != b {
		t.Fatalf("paying install %+v differs from free install %+v", a, b)
	}
	now := f.clock.Add(60 * 24 * time.Hour)
	if Default.Weight(time.Unix(a.FirstTagAt, 0), now, a.Agree, a.Decided) != Default.Weight(time.Unix(b.FirstTagAt, 0), now, b.Agree, b.Decided) {
		t.Fatal("weights differ")
	}
}
