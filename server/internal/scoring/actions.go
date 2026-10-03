package scoring

import (
	"context"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/store"
)

// DecisionInput is a reviewer's decision on a source or one of its items.
type DecisionInput struct {
	SourceRef int64
	ItemRef   int64  // 0 for the source itself
	Verdict   string // a verdict or "none"
	Reason    string
	Signals   uint16
	SlopType  string
	Tests     uint8
	Large     *bool  // sources only: the staff view of the source's size
	Actor     string // curator | staff | appeal
	AccountID string
	ActorName string
}

// Decide records a decision, applies it at once and logs it, even when the verdict stays the same.
func (e *Engine) Decide(ctx context.Context, in DecisionInput) error {
	now := e.Now()
	_, err := e.Store.AddDecision(ctx, store.Decision{
		SourceRef: in.SourceRef, ItemRef: in.ItemRef, Verdict: in.Verdict, Reason: in.Reason, Signals: in.Signals,
		Detail: lf.SlopTypeCode(in.SlopType) | in.Tests, Actor: in.Actor, AccountID: in.AccountID, ActorName: in.ActorName,
		CreatedAt: now.Unix(), ExpiresAt: now.Add(e.Th.Rescore).Unix(),
	}, in.Large)
	if err != nil {
		return err
	}
	return e.Rescore(ctx, in.SourceRef, &Cause{ItemRef: in.ItemRef, Actor: in.Actor, ActorName: in.ActorName,
		Reason: in.Reason, Always: true})
}

// VerifyAppeal marks an appeal verified. The source becomes Disputed at once.
func (e *Engine) VerifyAppeal(ctx context.Context, a *store.Appeal) error {
	now := e.Now().Unix()
	err := e.Store.TransitionAppeal(ctx, a.ID, []string{store.AppealAwaiting, store.AppealPendingManual},
		store.AppealUnderReview, store.AppealChange{VerifiedAt: now})
	if err != nil {
		return err
	}
	return e.Rescore(ctx, a.SourceRef, &Cause{Actor: "appeal", Always: true,
		Reason: "The creator verified control of the account and appealed. Shown as Disputed while staff review it."})
}

// ResolveAppeal closes an appeal. Upheld records a Clear decision; denied restores the scored verdict.
// Both write the decision log with the reviewer's reasoning.
func (e *Engine) ResolveAppeal(ctx context.Context, a *store.Appeal, outcome, reasoning string, reviewer *store.Account) error {
	now := e.Now().Unix()
	status := store.AppealDenied
	if outcome == "upheld" {
		status = store.AppealUpheld
	}
	err := e.Store.TransitionAppeal(ctx, a.ID, []string{store.AppealAwaiting, store.AppealPendingManual, store.AppealUnderReview},
		status, store.AppealChange{ResolvedAt: now, Outcome: outcome, Reasoning: reasoning, ResolvedBy: reviewer.ID})
	if err != nil {
		return err
	}
	if outcome == "upheld" {
		return e.Decide(ctx, DecisionInput{SourceRef: a.SourceRef, Verdict: "clear", Reason: "Appeal upheld. " + reasoning,
			Actor: "appeal", AccountID: reviewer.ID, ActorName: reviewer.DisplayName})
	}
	return e.Rescore(ctx, a.SourceRef, &Cause{Actor: "appeal", ActorName: reviewer.DisplayName, Always: true,
		Reason: "Appeal denied. " + reasoning})
}
