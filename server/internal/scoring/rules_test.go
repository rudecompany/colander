package scoring

import (
	"testing"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
)

func votes(n int, verdict string, w float64, tests uint8) []Vote {
	out := make([]Vote, n)
	for i := range out {
		out[i] = Vote{Weight: w, Verdict: verdict, Tests: tests}
	}
	return out
}

func join(lists ...[]Vote) []Vote {
	var out []Vote
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}

const lowHollow = lf.TestLowEffort | lf.TestHollow

func TestRules(t *testing.T) {
	th := Default
	slop5 := votes(5, "slop", 1, lowHollow)
	cases := []struct {
		name     string
		in       Input
		verdict  string
		rule     int
		capped   string
		signals  uint16 // must all be present
		excluded uint16 // must all be absent
	}{
		{
			name:    "tags alone never reach Slop: no behavior layer means Likely slop at most",
			in:      Input{Votes: votes(40, "slop", 1, lowHollow), UploadsPerDay: -1},
			verdict: "likely_slop", rule: 7,
			signals:  lf.SigCommunityConsensus | lf.SigRubricLowEffort | lf.SigRubricHollow,
			excluded: lf.SigMostlyAI | lf.SigHighVolume,
		},
		{
			name:    "provenance, behavior and consensus make Slop",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14},
			verdict: "slop", rule: 6,
			signals: lf.SigPlatformLabel | lf.SigHighVolume | lf.SigCommunityConsensus,
		},
		{
			name:    "80% rule over at least 5 items counts as behavior",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: -1, ItemsSeen: 5, AIItems: 4},
			verdict: "slop", rule: 6, signals: lf.SigMostlyAI,
		},
		{
			name:    "large source is capped at Likely slop and escalated",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, Large: true},
			verdict: "likely_slop", rule: 6, capped: "large",
		},
		{
			name:    "unreviewed import is capped at Likely slop and escalated",
			in:      Input{Votes: slop5, Imported: "blocklist", UploadsPerDay: -1},
			verdict: "likely_slop", rule: 6, capped: "imported", signals: lf.SigMostlyAI | lf.SigCommunityConsensus,
		},
		{
			name:    "reviewed import can reach Slop",
			in:      Input{Votes: slop5, Imported: "blocklist", Reviewed: true, UploadsPerDay: -1},
			verdict: "slop", rule: 6,
		},
		{
			name:    "blocklist seed alone is Likely slop",
			in:      Input{Imported: "blocklist", UploadsPerDay: -1},
			verdict: "likely_slop", rule: 7, signals: lf.SigMostlyAI,
		},
		{
			name:    "warnlist seed alone is AI-made",
			in:      Input{Imported: "warnlist", UploadsPerDay: -1},
			verdict: "ai_made", rule: 8,
		},
		{
			name:    "mixed source gets no source-level slop verdict",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, ItemsSeen: 10, AIItems: 3},
			verdict: "ai_made", rule: 8,
		},
		{
			name:    "split tags are Disputed",
			in:      Input{Votes: join(votes(3, "slop", 1, 0), votes(3, "not_slop", 1, 0)), LabelInstalls: 2, UploadsPerDay: 14},
			verdict: "disputed", rule: 5,
		},
		{
			name:    "verified appeal is Disputed whatever the evidence",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, AppealOpen: true},
			verdict: "disputed", rule: 1, signals: lf.SigOpenAppeal | lf.SigCommunityConsensus,
		},
		{
			name:    "appeal outranks a staff decision",
			in:      Input{Votes: slop5, AppealOpen: true, Decision: &Decision{Verdict: "slop"}, UploadsPerDay: -1},
			verdict: "disputed", rule: 1,
		},
		{
			name:    "staff decision wins over the computed verdict",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, Decision: &Decision{Verdict: "clear"}},
			verdict: "clear", rule: 2, signals: lf.SigStaffReview, excluded: lf.SigCommunityConsensus,
		},
		{
			name:    "staff decision none removes the rating",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, Decision: &Decision{Verdict: "none"}},
			verdict: "", rule: 2,
		},
		{
			name:    "staff behavior signals count as the behavior layer",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: -1, Decision: &Decision{Verdict: "slop", Signals: lf.SigLinkFunnel}},
			verdict: "slop", rule: 2, signals: lf.SigLinkFunnel | lf.SigStaffReview | lf.SigCommunityConsensus,
		},
		{
			name:    "not-slop consensus is Clear even without AI evidence",
			in:      Input{Votes: votes(4, "not_slop", 1, 0), UploadsPerDay: -1},
			verdict: "clear", rule: 3, signals: lf.SigNotSlopConsensus,
		},
		{
			name:    "no provenance is not rated",
			in:      Input{Votes: votes(2, "slop", 1, lowHollow), UploadsPerDay: 30},
			verdict: "", rule: 4,
		},
		{
			name:    "platform label from one install is not enough",
			in:      Input{Votes: votes(1, "slop", 1, 0), LabelInstalls: 1, UploadsPerDay: -1},
			verdict: "", rule: 4,
		},
		{
			name:    "AI evidence only is AI-made",
			in:      Input{Votes: votes(3, "ai_fine", 1, 0), LabelInstalls: 2, UploadsPerDay: -1},
			verdict: "ai_made", rule: 8, signals: lf.SigPlatformLabel,
		},
		{
			name:    "burst freeze removes the consensus layer",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, Frozen: true},
			verdict: "likely_slop", rule: 7, excluded: lf.SigCommunityConsensus,
		},
		{
			name:    "lapsed Slop holds at Likely slop until reviewed",
			in:      Input{Votes: slop5, LabelInstalls: 2, UploadsPerDay: 14, LapseHold: true},
			verdict: "likely_slop", rule: 6, capped: "lapsed",
		},
		{
			name: "items are scored on their own and inherit source behavior",
			in: Input{Item: true, Votes: slop5, LabelInstalls: 2, UploadsPerDay: -1,
				SourceBehavior: Layer{Met: true, Signals: lf.SigMostlyAI}},
			verdict: "slop", rule: 6, signals: lf.SigMostlyAI,
		},
		{
			name:    "large and imported caps never apply to items",
			in:      Input{Item: true, Votes: slop5, LabelInstalls: 2, Large: true, Imported: "blocklist", SourceBehavior: Layer{Met: true}},
			verdict: "slop", rule: 6,
		},
		{
			name:    "low-weight new installs cannot form consensus",
			in:      Input{Votes: votes(20, "slop", th.Weight(time.Now(), time.Now(), 0, 0), lowHollow), LabelInstalls: 2, UploadsPerDay: 14},
			verdict: "likely_slop", rule: 7, excluded: lf.SigCommunityConsensus,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := th.Score(c.in)
			if r.Verdict != c.verdict || r.Rule != c.rule || r.CappedBy != c.capped {
				t.Fatalf("got verdict %q rule %d capped %q, want %q rule %d capped %q",
					r.Verdict, r.Rule, r.CappedBy, c.verdict, c.rule, c.capped)
			}
			if r.Signals&c.signals != c.signals {
				t.Errorf("signals %v missing some of %v", lf.SignalNames(r.Signals), lf.SignalNames(c.signals))
			}
			if r.Signals&c.excluded != 0 {
				t.Errorf("signals %v include one of %v", lf.SignalNames(r.Signals), lf.SignalNames(c.excluded))
			}
		})
	}
}

func TestWeight(t *testing.T) {
	th := Default
	now := time.Now()
	if w := th.Weight(now, now, 0, 0); w != 0.1 {
		t.Errorf("new install weight = %v, want 0.1", w)
	}
	if w := th.Weight(now.Add(-60*24*time.Hour), now, 98, 98); w < 0.98 || w > 1 {
		t.Errorf("mature accurate install weight = %v, want close to 1", w)
	}
	if w := th.Weight(now.Add(-60*24*time.Hour), now, 0, 98); w > 0.11 {
		t.Errorf("mature inaccurate install weight = %v, want near the floor", w)
	}
}
