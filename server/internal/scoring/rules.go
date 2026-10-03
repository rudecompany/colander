// Package scoring turns tags, reports, appeals and reviewer decisions into verdicts (contracts section 9).
// rules.go is the pure part: reputation, tag sums, the four layers and the verdict rules in order.
// engine.go runs it against the store and writes every change to the decision log.
package scoring

import (
	"math"
	"time"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
)

// Thresholds holds every tunable number from contracts section 9 in one place.
type Thresholds struct {
	// Reputation (9.1).
	BaseWeight, MinWeight, MaxWeight float64
	MaturityDays                     float64

	// Provenance (9.3).
	LabelInstalls       int
	AIConsensusSum      float64
	AIConsensusInstalls int
	AIConsensusRatio    float64

	// Behavior (9.3).
	UploadsPerDay    float64
	MostlyAIShare    float64
	MostlyAIMinItems int

	// Rubric (9.3).
	RubricShare float64

	// Consensus (9.3).
	SlopSum      float64
	SlopInstalls int
	SlopRatio    float64
	NotSlopSum   float64
	NotSlopRatio float64
	SplitSlop    float64
	SplitOther   float64
	SplitLow     float64
	SplitHigh    float64

	// Size, expiry and brigading (9.5).
	LargeSubscribers int64
	Rescore          time.Duration
	BurstTags        int
	BurstWindow      time.Duration
	BurstInstallAge  time.Duration
	BurstFreeze      time.Duration
	ReportEscalation int

	// Scheduling and appeals.
	PassInterval time.Duration
	Debounce     time.Duration
	AppealExpiry time.Duration
}

// Default holds the starting values from the contract.
var Default = Thresholds{
	BaseWeight: 0.1, MinWeight: 0.05, MaxWeight: 1.0, MaturityDays: 30,

	LabelInstalls: 2, AIConsensusSum: 3, AIConsensusInstalls: 3, AIConsensusRatio: 0.7,

	UploadsPerDay: 10, MostlyAIShare: 0.8, MostlyAIMinItems: 5,

	RubricShare: 0.5,

	SlopSum: 3, SlopInstalls: 3, SlopRatio: 0.7,
	NotSlopSum: 3, NotSlopRatio: 0.7,
	SplitSlop: 2, SplitOther: 2, SplitLow: 0.3, SplitHigh: 0.7,

	LargeSubscribers: 100_000,
	Rescore:          90 * 24 * time.Hour,
	BurstTags:        20,
	BurstWindow:      time.Hour,
	BurstInstallAge:  7 * 24 * time.Hour,
	BurstFreeze:      72 * time.Hour,
	ReportEscalation: 3,

	PassInterval: 5 * time.Minute,
	Debounce:     5 * time.Second,
	AppealExpiry: 14 * 24 * time.Hour,
}

// Weight is an install's tag weight (9.1). It reads only tagging history; plan, payment and
// donation state are never inputs.
func (th Thresholds) Weight(firstTag, now time.Time, agree, decided int) float64 {
	maturity := math.Min(1, math.Max(0, now.Sub(firstTag).Hours()/24/th.MaturityDays))
	accuracy := float64(agree+1) / float64(decided+2)
	w := th.BaseWeight + (1-th.BaseWeight)*maturity*accuracy
	return math.Min(th.MaxWeight, math.Max(th.MinWeight, w))
}

// Vote is one install's weighted tag.
type Vote struct {
	Weight        float64
	Verdict       string // slop | ai_fine | not_slop
	SlopType      string
	Tests         uint8 // detail test bits
	PlatformLabel bool
}

// Decision is an active staff, curator or appeal decision.
type Decision struct {
	Verdict  string // a verdict or "none"
	Signals  uint16
	SlopType string
	Tests    uint8
}

// Input is everything the rules read for one target.
type Input struct {
	Item          bool
	Votes         []Vote // one per install
	LabelInstalls int    // distinct installs that saw a platform AI label (for a source: on it or any item)
	Decision      *Decision
	AppealOpen    bool
	Frozen        bool // burst detection froze the consensus layer

	// Sources only.
	Imported      string // blocklist | warnlist | ""
	Reviewed      bool   // a staff or curator decision was ever recorded
	Large         bool
	UploadsPerDay float64 // < 0 when unknown
	ItemsSeen     int     // items with evidence either way
	AIItems       int     // of those, items with AI evidence

	// Items only: the behavior layer of the item's source.
	SourceBehavior Layer

	// LapseHold keeps a lapsed Slop verdict at Likely slop until a reviewer looks again.
	LapseHold bool
}

// Layer is one evidence layer's outcome.
type Layer struct {
	Met     bool
	Signals uint16
}

// Sums are the weighted tag sums of 9.2.
type Sums struct {
	S, A, N, T float64
	Installs   int
}

// Result is the outcome of the rules for one target.
type Result struct {
	Verdict  string // "" when not rated
	Signals  uint16
	SlopType string
	Tests    uint8
	Rule     int // the 9.4 rule that matched, 0 when none did
	Computed string

	Provenance, Behavior, Rubric, Consensus Layer
	NotSlop, Split, Mixed                   bool
	Sums                                    Sums
	// CappedBy is why rule 6 held Slop at Likely slop: "large", "imported" or "lapsed".
	// It raises an escalation only while rule 6 decides (Rule == 6).
	CappedBy string
}

// SumVotes computes S, A, N, T and n.
func SumVotes(votes []Vote) Sums {
	var s Sums
	for _, v := range votes {
		switch v.Verdict {
		case "slop":
			s.S += v.Weight
		case "ai_fine":
			s.A += v.Weight
		case "not_slop":
			s.N += v.Weight
		}
	}
	s.T = s.S + s.A + s.N
	s.Installs = len(votes)
	return s
}

func (th Thresholds) provenance(in Input, s Sums) Layer {
	var l Layer
	if in.LabelInstalls >= th.LabelInstalls {
		l.Met, l.Signals = true, lf.SigPlatformLabel
	}
	if in.Decision != nil && in.Decision.Signals&lf.ProvenanceSignals != 0 {
		l.Met, l.Signals = true, l.Signals|in.Decision.Signals&lf.ProvenanceSignals
	}
	if !in.Item && in.Imported != "" {
		l.Met = true
	}
	if s.S+s.A >= th.AIConsensusSum && s.Installs >= th.AIConsensusInstalls && s.T > 0 && (s.S+s.A)/s.T >= th.AIConsensusRatio {
		l.Met = true
	}
	return l
}

func (th Thresholds) behavior(in Input) Layer {
	if in.Item {
		return in.SourceBehavior
	}
	var l Layer
	if in.UploadsPerDay >= th.UploadsPerDay {
		l.Met, l.Signals = true, lf.SigHighVolume
	}
	if in.ItemsSeen >= th.MostlyAIMinItems && float64(in.AIItems)/float64(in.ItemsSeen) >= th.MostlyAIShare {
		l.Met, l.Signals = true, l.Signals|lf.SigMostlyAI
	}
	if in.Imported == "blocklist" {
		l.Met, l.Signals = true, l.Signals|lf.SigMostlyAI
	}
	if in.Decision != nil && in.Decision.Signals&lf.BehaviorSignals != 0 {
		l.Met, l.Signals = true, l.Signals|in.Decision.Signals&lf.BehaviorSignals
	}
	return l
}

// passingTests returns the tests chosen by a weighted share of slop votes at or above the rubric share,
// with mass_produced also passing when behavior is met.
func (th Thresholds) passingTests(votes []Vote, s Sums, behaviorMet bool) uint8 {
	var bits uint8
	if s.S > 0 {
		for _, t := range lf.Tests {
			var w float64
			for _, v := range votes {
				if v.Verdict == "slop" && v.Tests&t.Bit != 0 {
					w += v.Weight
				}
			}
			if w/s.S >= th.RubricShare {
				bits |= t.Bit
			}
		}
	}
	if behaviorMet {
		bits |= lf.TestMassProduced
	}
	return bits
}

func (th Thresholds) rubric(tests uint8, s Sums) Layer {
	var l Layer
	if s.S < 1 {
		return l
	}
	n := 0
	for _, t := range lf.Tests {
		if tests&t.Bit != 0 {
			n++
		}
	}
	if n >= 2 {
		l.Met = true
		if tests&lf.TestLowEffort != 0 {
			l.Signals |= lf.SigRubricLowEffort
		}
		if tests&lf.TestHollow != 0 {
			l.Signals |= lf.SigRubricHollow
		}
	}
	return l
}

// slopType is the weighted plurality among slop votes that named a type.
func slopType(votes []Vote) string {
	best, bestW := "", 0.0
	for _, t := range lf.SlopTypes[1:] {
		var w float64
		for _, v := range votes {
			if v.Verdict == "slop" && v.SlopType == t {
				w += v.Weight
			}
		}
		if w > bestW {
			best, bestW = t, w
		}
	}
	return best
}

// Score applies the layers and the verdict rules of 9.4, first match wins.
func (th Thresholds) Score(in Input) Result {
	s := SumVotes(in.Votes)
	r := Result{Sums: s}
	r.Provenance = th.provenance(in, s)
	r.Behavior = th.behavior(in)
	tests := th.passingTests(in.Votes, s, r.Behavior.Met)
	r.Rubric = th.rubric(tests, s)
	if !in.Frozen && s.S >= th.SlopSum && s.Installs >= th.SlopInstalls && s.S/s.T >= th.SlopRatio {
		r.Consensus = Layer{Met: true, Signals: lf.SigCommunityConsensus}
	}
	r.NotSlop = s.N >= th.NotSlopSum && s.T > 0 && s.N/s.T >= th.NotSlopRatio
	r.Split = s.S >= th.SplitSlop && s.N+s.A >= th.SplitOther && s.T > 0 && s.S/s.T >= th.SplitLow && s.S/s.T <= th.SplitHigh
	r.Mixed = !in.Item && in.ItemsSeen >= th.MostlyAIMinItems && float64(in.AIItems)/float64(in.ItemsSeen) < th.MostlyAIShare

	// Only met layers carry signals, so this is the union of the signals of the met layers.
	evidence := r.Provenance.Signals | r.Behavior.Signals | r.Rubric.Signals | r.Consensus.Signals

	// Rules 3 to 8 give the computed verdict, which the review queue shows next to the list verdict.
	switch {
	case r.NotSlop:
		r.Rule, r.Computed, r.Signals = 3, "clear", lf.SigNotSlopConsensus
	case !r.Provenance.Met:
		r.Rule = 4
	case r.Split:
		r.Rule, r.Computed, r.Signals = 5, "disputed", evidence
	case r.Behavior.Met && r.Consensus.Met && !r.Mixed:
		r.Rule, r.Computed, r.Signals = 6, "slop", evidence
		switch {
		case !in.Item && in.Large:
			r.CappedBy = "large"
		case !in.Item && in.Imported != "" && !in.Reviewed:
			r.CappedBy = "imported"
		case in.LapseHold:
			r.CappedBy = "lapsed"
		}
		if r.CappedBy != "" {
			r.Computed = "likely_slop"
		}
	case (r.Behavior.Met || r.Rubric.Met) && (s.S >= 1 || in.Imported == "blocklist") && !r.Mixed:
		r.Rule, r.Computed, r.Signals = 7, "likely_slop", evidence
	default:
		r.Rule, r.Computed, r.Signals = 8, "ai_made", evidence
	}
	r.Verdict = r.Computed
	if r.Verdict == "slop" || r.Verdict == "likely_slop" {
		r.SlopType, r.Tests = slopType(in.Votes), tests
	}

	// Rules 1 and 2 override the computed verdict.
	switch {
	case in.AppealOpen:
		r.Rule, r.Verdict, r.SlopType, r.Tests = 1, "disputed", "", 0
		r.Signals = evidence | lf.SigOpenAppeal
		if r.NotSlop {
			r.Signals |= lf.SigNotSlopConsensus
		}
	case in.Decision != nil:
		d := in.Decision
		r.Rule, r.Verdict, r.SlopType, r.Tests = 2, d.Verdict, "", 0
		switch d.Verdict {
		case "none":
			r.Verdict, r.Signals = "", 0
		case "clear", "disputed":
			r.Signals = d.Signals | lf.SigStaffReview
		default:
			r.Signals = evidence | d.Signals | lf.SigStaffReview
		}
		if d.Verdict == "slop" || d.Verdict == "likely_slop" {
			r.SlopType, r.Tests = d.SlopType, d.Tests
			if r.SlopType == "" {
				r.SlopType = slopType(in.Votes)
			}
			if r.Tests == 0 {
				r.Tests = tests
			}
		}
	}
	return r
}
