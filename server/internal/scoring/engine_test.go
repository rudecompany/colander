package scoring

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/sign"
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
		installs = append(installs, fmt.Sprintf("install-%04d", f.n+len(installs)+1))
	}
	f.tagAs(installs, "yt", "source", source, "", verdict, label)
	return installs
}

// tagAs has each install tag a target. source is an item's source, "" for source tags and for items
// tagged where the card does not show their source.
func (f *fixture) tagAs(installs []string, platform, targetType, target, source, verdict string, label bool) {
	if targetType == "source" {
		source = target
	}
	for _, h := range installs {
		f.n++
		in := store.TagInput{ClientID: fmt.Sprintf("c%d", f.n), Platform: platform, TargetType: targetType, TargetID: target,
			SourceID: source, Verdict: verdict, PlatformLabel: label, CreatedAt: f.clock.Unix()}
		if verdict == "slop" {
			in.Tests = lf.TestLowEffort | lf.TestMassProduced
		}
		if _, err := f.st.SaveTags(f.ctx, h, []store.TagInput{in}, f.clock.Unix()); err != nil {
			f.t.Fatal(err)
		}
	}
}

func (f *fixture) source(alias string) *store.Source { return f.sourceOn("yt", alias) }

func (f *fixture) sourceOn(platform, alias string) *store.Source {
	ref, err := f.st.FindSource(f.ctx, platform, alias)
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
	if _, err := f.eng.FullPass(f.ctx); err != nil {
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

// escalationsOf returns the open escalations on a source itself, kind to summary.
func (f *fixture) escalationsOf(ref int64) map[string]string {
	list, err := f.st.OpenEscalations(f.ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range list {
		if e.SourceRef == ref && e.ItemRef == 0 {
			out[e.Kind] = e.Summary
		}
	}
	return out
}

// highVolume records YouTube data showing 20 uploads a day (the behavior layer) and 50,000 subscribers.
func (f *fixture) highVolume(alias string) {
	ref := f.source(alias).Ref
	if _, err := f.st.SetYouTube(f.ctx, ref, store.YouTubeInfo{ChannelID: "UCzzzzzzzzzzzzzzzzzzzzz1", Handle: alias,
		Subscribers: sql.NullInt64{Int64: 50_000, Valid: true}, UploadsPerDay: sql.NullFloat64{Float64: 20, Valid: true}},
		f.clock.Unix()); err != nil {
		f.t.Fatal(err)
	}
}

func installs(from, n int) []string {
	var out []string
	for i := range n {
		out = append(out, fmt.Sprintf("install-%04d", 1000+from+i))
	}
	return out
}

// Six mature installs tagging a TikTok source and five of its items as slop never make it Slop.
// Without platform labels, tags alone never count an item as AI-made for the 80% rule; with labels,
// the source is still held at Likely slop because its audience size is unknown, until staff decide.
// A YouTube source with API uploads a day and a known audience under 100,000 can reach Slop.
func TestTagsAloneNeverMakeSlop(t *testing.T) {
	f := newFixture(t)
	six := installs(0, 6)
	for k, src := range []struct {
		alias string
		label bool
	}{{"@petfarm", false}, {"@labelfarm", true}} {
		f.tagAs(six, "tt", "source", src.alias, "", "slop", false)
		for i := range 5 {
			f.tagAs(six, "tt", "item", fmt.Sprintf("74%017d", 10*k+i), src.alias, "slop", src.label)
		}
	}
	f.tagAs(six, "yt", "source", "@ytfarm", "", "slop", true)
	f.highVolume("@ytfarm")
	f.clock = f.clock.Add(40 * 24 * time.Hour)
	f.pass()
	f.pass()

	pet := f.sourceOn("tt", "@petfarm")
	if pet.State.Verdict != "likely_slop" || pet.State.Signals&lf.SigMostlyAI != 0 {
		t.Fatalf("tag-only TikTok source = %q with %v, want likely_slop without mostly_ai",
			pet.State.Verdict, lf.SignalNames(pet.State.Signals))
	}

	label := f.sourceOn("tt", "@labelfarm")
	if label.State.Verdict != "likely_slop" || label.State.Computed != "likely_slop" || label.State.Signals&lf.SigMostlyAI == 0 {
		t.Fatalf("labelled TikTok source = %+v, want likely_slop with mostly_ai", label.State)
	}
	if got := f.escalationsOf(label.Ref)["capped"]; !strings.Contains(got, "audience size unknown") {
		t.Fatalf("capped escalation = %q", got)
	}
	log, err := f.st.Log(f.ctx, store.LogFilter{SourceRef: label.Ref, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 1 || !strings.Contains(log[0].Reason, "Held at Likely slop until staff review it, because its audience size is unknown.") {
		t.Fatalf("log = %+v", log)
	}
	// Only a reviewer makes it Slop.
	small := false
	if err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: label.Ref, Verdict: "slop", Reason: "Generated pet clips.", Actor: "staff",
		Large: &small}); err != nil {
		t.Fatal(err)
	}
	if v := f.sourceOn("tt", "@labelfarm").State.Verdict; v != "slop" {
		t.Fatalf("after staff review: %q, want slop", v)
	}

	yt := f.source("@ytfarm")
	if yt.State.Verdict != "slop" || len(f.escalationsOf(yt.Ref)) != 0 {
		t.Fatalf("YouTube source = %+v, escalations %v; want community slop", yt.State, f.escalationsOf(yt.Ref))
	}
}

// A mixed source: platform labels on its items never count toward its own provenance, and its items
// keep their own list entries even when they match its verdict.
func TestMixedSourceItems(t *testing.T) {
	f := newFixture(t)
	f.tagAs(installs(0, 3), "yt", "source", "@mixedchan", "", "slop", false)
	for i := range 10 {
		item := fmt.Sprintf("mixedItem%02d", i)
		if i < 3 {
			f.tagAs(installs(10+2*i, 2), "yt", "item", item, "@mixedchan", "ai_fine", true)
		} else {
			f.tagAs(installs(10+2*i, 2), "yt", "item", item, "@mixedchan", "not_slop", false)
		}
	}
	f.highVolume("@mixedchan")
	f.clock = f.clock.Add(40 * 24 * time.Hour)
	f.pass()
	if st := f.source("@mixedchan").State; st.Verdict != "" || !st.Mixed {
		t.Fatalf("mixed source with labels only on items = %+v, want not rated", st)
	}

	// With AI evidence on the source itself it is AI-made, and its AI-made items stay listed.
	f.tagAs(installs(40, 2), "yt", "source", "@mixedchan", "", "ai_fine", true)
	f.pass()
	if v := f.source("@mixedchan").State.Verdict; v != "ai_made" {
		t.Fatalf("mixed source with its own labels = %q, want ai_made", v)
	}
	key, err := sign.LoadKey("../../testdata/dev-signing.key")
	if err != nil {
		t.Fatal(err)
	}
	pub := lf.NewPublisher(f.st, key, f.eng.Log)
	if err := pub.Publish(f.ctx); err != nil {
		t.Fatal(err)
	}
	body, _ := pub.Snapshot()
	snap, err := lf.Decode(body, key.Public)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[[8]byte]uint8{}
	for _, e := range snap.Entries {
		listed[e.Hash] = e.Verdict
	}
	for i := range 3 {
		if v, ok := listed[lf.Hash(fmt.Sprintf("yt:i:mixedItem%02d", i))]; !ok || v != lf.VerdictCode("ai_made") {
			t.Errorf("item %d: listed %v as %d, want its own ai_made entry", i, ok, v)
		}
	}
}

// Slop and Likely slop decisions need AI evidence: the target's provenance layer, or a provenance signal.
func TestDecisionNeedsAIEvidence(t *testing.T) {
	f := newFixture(t)
	f.tags(1, "@quiet", "slop", false)
	ref := f.source("@quiet").Ref
	for _, v := range []string{"slop", "likely_slop"} {
		err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: ref, Verdict: v, Reason: "Looks generated.", Actor: "staff"})
		if !errors.Is(err, ErrAIEvidenceRequired) {
			t.Fatalf("%s without AI evidence: %v", v, err)
		}
	}
	if err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: ref, Verdict: "slop", Reason: "The creator says so.", Actor: "staff",
		Signals: lf.SigCreatorStatement}); err != nil {
		t.Fatal(err)
	}
	// The recorded signal is not evidence for the next decision, which replaces it.
	err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: ref, Verdict: "likely_slop", Reason: "Softer.", Actor: "staff"})
	if !errors.Is(err, ErrAIEvidenceRequired) {
		t.Fatalf("decision leaning on the one it replaces: %v", err)
	}
	f.tagAs(installs(0, 2), "yt", "source", "@quiet", "", "ai_fine", true)
	if err := f.eng.Decide(f.ctx, DecisionInput{SourceRef: ref, Verdict: "likely_slop", Reason: "Labelled.", Actor: "curator"}); err != nil {
		t.Fatal(err)
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

// Run rescores touched sources after the debounce: three open reports raise an escalation
// without waiting for the next full pass.
func TestRunRescoresTouchedSources(t *testing.T) {
	f := newFixture(t)
	f.eng.Th.PassInterval, f.eng.Th.Debounce = time.Hour, 10*time.Millisecond
	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan struct{})
	go func() {
		f.eng.Run(ctx)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	for i := range 3 {
		rp, _, err := f.st.CreateReport(f.ctx, store.ReportInput{InstallHash: fmt.Sprintf("i%d", i), ClientID: "r",
			Platform: "yt", SourceID: "@farm", Reason: "Generated narration.", Examples: []string{}}, f.clock.Unix())
		if err != nil {
			t.Fatal(err)
		}
		f.eng.Touch(rp.SourceRef)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !f.escalations()["reports"] {
		if time.Now().After(deadline) {
			t.Fatal("no reports escalation after the debounce")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
