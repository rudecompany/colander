// Package billing is Colander's money path on Stripe: Plus checkout through Managed Payments,
// donations, cancellations and refunds, webhooks, and the subscription state behind paid plan
// tokens (contracts section 6.8).
//
// Independence rule: scoring, tagging and review never import this package or read its tables,
// so paying or donating can never change a verdict. independence_test.go enforces it.
package billing

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
)

// Config comes from the environment (contracts section 10).
type Config struct {
	SecretKey       string // STRIPE_SECRET_KEY; billing is off without it
	WebhookSecret   string // STRIPE_WEBHOOK_SECRET
	PriceMonthly    string // STRIPE_PRICE_PLUS_MONTHLY
	PriceYearly     string // STRIPE_PRICE_PLUS_YEARLY
	ManagedPayments bool   // STRIPE_MANAGED_PAYMENTS: Plus checkout with Stripe as merchant of record
	APIBase         string // STRIPE_API_BASE, https://api.stripe.com by default
	PublicURL       string // website origin for the checkout return pages
}

// Service talks to Stripe and keeps the billing tables.
type Service struct {
	Config
	Store *store.Store
	HTTP  *http.Client
	Log   *slog.Logger
}

// New returns a billing service. It is safe to use with an empty Config: every Stripe call then
// fails with ErrUnavailable, while plans, entitlements and supporters answer from stored state.
func New(cfg Config, st *store.Store, log *slog.Logger) *Service {
	if cfg.APIBase == "" {
		cfg.APIBase = "https://api.stripe.com"
	}
	cfg.APIBase = strings.TrimRight(cfg.APIBase, "/")
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	return &Service{Config: cfg, Store: st, HTTP: &http.Client{Timeout: 20 * time.Second}, Log: log}
}

// Enabled reports whether Stripe is configured.
func (s *Service) Enabled() bool { return s.SecretKey != "" }

var (
	ErrUnavailable       = errors.New("billing is not configured")
	ErrBadPrice          = errors.New("unknown price")
	ErrAlreadySubscribed = errors.New("the account already has Plus")
	ErrNoPlan            = errors.New("no active plan")
	ErrNotRefundable     = errors.New("no charge in the last 30 days to refund")
)

const (
	// Grace is how long a plan token outlives the paid period (contracts section 5).
	Grace = 3 * 24 * time.Hour
	// RefundWindow is how long after a charge Cancel and refund is offered.
	RefundWindow = 30 * 24 * time.Hour
)

// Subscription is a Plus subscription as stored.
type Subscription struct {
	ID, AccountID, CustomerID string
	Status                    string // Stripe status
	Interval                  string // month | year
	PeriodStart, PeriodEnd    int64
	CancelAtPeriodEnd         bool
	LatestPayment             string // PaymentIntent or Charge of the latest paid invoice
	LatestPaidAt, RefundedAt  int64
	CreatedAt                 int64
}

// Live reports whether the subscription still runs (Plus may still be on).
func (s *Subscription) Live() bool {
	switch s.Status {
	case "active", "trialing", "past_due":
		return true
	}
	return false
}

// PlanStatus maps the Stripe status onto the contract's active, trialing, past_due or canceled.
// unpaid, paused and incomplete_expired all mean Plus is off.
func (s *Subscription) PlanStatus() string {
	if s.Live() {
		return s.Status
	}
	return "canceled"
}

// Refundable reports whether the latest charge can still be refunded with Cancel and refund.
func (s *Subscription) Refundable(now time.Time) bool {
	return s.Live() && s.LatestPayment != "" && s.RefundedAt == 0 && now.Unix() < s.LatestPaidAt+int64(RefundWindow/time.Second)
}

// TokenExpiry is the end of the paid period plus grace, or 0 when Plus is off. While a renewal
// payment is retried (past_due) the paid period is the previous one, which ended when the unpaid
// period began.
func (s *Subscription) TokenExpiry() int64 {
	switch s.Status {
	case "active", "trialing":
		return s.PeriodEnd + int64(Grace/time.Second)
	case "past_due":
		return s.PeriodStart + int64(Grace/time.Second)
	}
	return 0
}

const subscriptionCols = `id, account_id, customer_id, status, interval, period_start, period_end, cancel_at_period_end,
	ifnull(latest_payment, ''), ifnull(latest_paid_at, 0), ifnull(refunded_at, 0), created_at`

// Current returns the account's subscription that decides its plan: a live one first, then the
// one that ended last. It returns nil when the account never subscribed.
func (s *Service) Current(ctx context.Context, accountID string) (*Subscription, error) {
	var sub Subscription
	err := s.Store.DB.QueryRowContext(ctx, `SELECT `+subscriptionCols+` FROM subscriptions
		WHERE account_id = ? AND status NOT IN ('incomplete', 'incomplete_expired')
		ORDER BY status IN ('active', 'trialing', 'past_due') DESC, period_end DESC LIMIT 1`, accountID).Scan(
		&sub.ID, &sub.AccountID, &sub.CustomerID, &sub.Status, &sub.Interval, &sub.PeriodStart, &sub.PeriodEnd,
		&sub.CancelAtPeriodEnd, &sub.LatestPayment, &sub.LatestPaidAt, &sub.RefundedAt, &sub.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

// PlanClaims returns the claims of a paid plan token for the account, or ErrNoPlan.
// sub is the account ID, so settings sync keeps one blob per account across renewals and browsers.
func (s *Service) PlanClaims(ctx context.Context, accountID string, now time.Time) (sign.PlanClaims, error) {
	sub, err := s.Current(ctx, accountID)
	if err != nil {
		return sign.PlanClaims{}, err
	}
	if sub == nil || sub.TokenExpiry() <= now.Unix() {
		return sign.PlanClaims{}, ErrNoPlan
	}
	return sign.PlanClaims{V: 1, Sub: accountID, Plan: "plus", Trial: sub.Status == "trialing", IAT: now.Unix(), EXP: sub.TokenExpiry()}, nil
}

// Checkout starts a hosted Stripe Checkout for Plus and returns its URL.
func (s *Service) Checkout(ctx context.Context, acct *store.Account, price string) (string, error) {
	var priceID string
	switch price {
	case "plus_yearly":
		priceID = s.PriceYearly
	case "plus_monthly":
		priceID = s.PriceMonthly
	default:
		return "", ErrBadPrice
	}
	if !s.Enabled() || priceID == "" {
		return "", ErrUnavailable
	}
	cur, err := s.Current(ctx, acct.ID)
	if err != nil {
		return "", err
	}
	if cur != nil && cur.Live() {
		return "", ErrAlreadySubscribed
	}
	form := url.Values{
		"mode":                                    {"subscription"},
		"line_items[0][price]":                    {priceID},
		"line_items[0][quantity]":                 {"1"},
		"client_reference_id":                     {acct.ID},
		"metadata[kind]":                          {"plus"},
		"metadata[account_id]":                    {acct.ID},
		"subscription_data[metadata][kind]":       {"plus"},
		"subscription_data[metadata][account_id]": {acct.ID},
		"success_url":                             {s.PublicURL + "/plans/welcome"},
		"cancel_url":                              {s.PublicURL + "/plans?checkout=" + price + "&cancelled=1"},
	}
	// Managed Payments makes Stripe the merchant of record. It rejects tax, shipping and
	// payment method parameters, so none are ever sent.
	if s.ManagedPayments {
		form.Set("managed_payments[enabled]", "true")
	}
	if cur != nil && cur.CustomerID != "" {
		form.Set("customer", cur.CustomerID)
	} else {
		form.Set("customer_email", acct.Email)
	}
	var cs checkoutSession
	if err := s.call(ctx, http.MethodPost, "/v1/checkout/sessions", form, "", &cs); err != nil {
		return "", err
	}
	return cs.URL, nil
}

// Donate starts a hosted Stripe Checkout for a donation of cents, once or monthly, and returns
// its URL. Donations are gifts rather than product sales, so they never use Managed Payments.
func (s *Service) Donate(ctx context.Context, cents int64, monthly bool, creditName string) (string, error) {
	if !s.Enabled() {
		return "", ErrUnavailable
	}
	form := url.Values{
		"line_items[0][price_data][currency]":    {"usd"},
		"line_items[0][price_data][unit_amount]": {strconv.FormatInt(cents, 10)},
		"line_items[0][quantity]":                {"1"},
		"metadata[kind]":                         {"donation"},
		"success_url":                            {s.PublicURL + "/support/thanks"},
		"cancel_url":                             {s.PublicURL + "/support?cancelled=1"},
	}
	if monthly {
		form.Set("mode", "subscription")
		form.Set("line_items[0][price_data][product_data][name]", "Monthly donation to Colander")
		form.Set("line_items[0][price_data][recurring][interval]", "month")
		form.Set("subscription_data[metadata][kind]", "donation")
	} else {
		form.Set("mode", "payment")
		form.Set("submit_type", "donate")
		form.Set("line_items[0][price_data][product_data][name]", "Donation to Colander")
	}
	if creditName != "" {
		form.Set("metadata[credit_name]", creditName)
	}
	var cs checkoutSession
	if err := s.call(ctx, http.MethodPost, "/v1/checkout/sessions", form, "", &cs); err != nil {
		return "", err
	}
	return cs.URL, nil
}

// Cancel ends the account's Plus at the end of the paid period. With refund it refunds the
// latest charge, when it is under 30 days old, and ends Plus now. It returns the subscription
// as it stands afterwards.
func (s *Service) Cancel(ctx context.Context, accountID string, refund bool, now time.Time) (*Subscription, error) {
	if !s.Enabled() {
		return nil, ErrUnavailable
	}
	sub, err := s.Current(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if sub == nil || !sub.Live() {
		return nil, ErrNoPlan
	}
	path := "/v1/subscriptions/" + url.PathEscape(sub.ID)
	var out stripeSubscription
	switch {
	case refund:
		// A refund recorded for the latest charge means an earlier try refunded it but did not
		// finish cancelling: cancel without refunding twice.
		alreadyRefunded := sub.RefundedAt != 0 && now.Unix() < sub.LatestPaidAt+int64(RefundWindow/time.Second)
		if !sub.Refundable(now) && !alreadyRefunded {
			return nil, ErrNotRefundable
		}
		if !alreadyRefunded {
			// Refund first: if cancelling then fails, the person is never left charged without Plus.
			form := url.Values{"reason": {"requested_by_customer"}, "metadata[account_id]": {accountID}}
			if strings.HasPrefix(sub.LatestPayment, "ch_") {
				form.Set("charge", sub.LatestPayment)
			} else {
				form.Set("payment_intent", sub.LatestPayment)
			}
			if err := s.call(ctx, http.MethodPost, "/v1/refunds", form, "colander-refund-"+sub.LatestPayment, nil); err != nil {
				return nil, err
			}
			if err := s.markRefunded(ctx, sub.LatestPayment, "", now.Unix()); err != nil {
				return nil, err
			}
		}
		if err := s.call(ctx, http.MethodDelete, path, nil, "", &out); err != nil {
			return nil, err
		}
	case sub.CancelAtPeriodEnd:
		return sub, nil
	default:
		if err := s.call(ctx, http.MethodPost, path, url.Values{"cancel_at_period_end": {"true"}}, "", &out); err != nil {
			return nil, err
		}
	}
	if err := s.saveSubscription(ctx, out, now.Unix()); err != nil {
		return nil, err
	}
	return s.Current(ctx, accountID)
}

// Supporter is one credited name on the supporters page. Amounts and emails are never shown.
type Supporter struct {
	Name  string
	Since int64
}

// Supporters lists credited donors, newest first. A name used for several donations appears once,
// since the first.
func (s *Service) Supporters(ctx context.Context) ([]Supporter, error) {
	rows, err := s.Store.DB.QueryContext(ctx, `SELECT credit_name, min(created_at) AS since FROM donations
		WHERE credit_name IS NOT NULL AND refunded_at IS NULL GROUP BY credit_name ORDER BY since DESC LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Supporter{}
	for rows.Next() {
		var sp Supporter
		if err := rows.Scan(&sp.Name, &sp.Since); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// saveSubscription mirrors a Stripe subscription. Only Plus subscriptions are kept: monthly
// donations are subscriptions too and are recorded as donations instead.
func (s *Service) saveSubscription(ctx context.Context, sub stripeSubscription, now int64) error {
	account := sub.Metadata["account_id"]
	if sub.Metadata["kind"] != "plus" || account == "" || len(sub.Items.Data) == 0 {
		return nil
	}
	item := sub.Items.Data[0]
	// Newer API versions can express cancel at period end as a cancel_at date.
	ending := sub.CancelAtPeriodEnd || sub.CancelAt != 0
	res, err := s.Store.DB.ExecContext(ctx, `INSERT INTO subscriptions (id, account_id, customer_id, status, interval,
			period_start, period_end, cancel_at_period_end, created_at, updated_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)
		ON CONFLICT (id) DO UPDATE SET status = excluded.status, interval = excluded.interval,
			period_start = excluded.period_start, period_end = excluded.period_end,
			cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
		sub.ID, account, sub.Customer, sub.Status, item.Price.Recurring.Interval, item.CurrentPeriodStart,
		item.CurrentPeriodEnd, ending, sub.StartDate, now, account)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		s.Log.Warn("stripe subscription for an unknown account ignored", "subscription", sub.ID)
	}
	return nil
}

// recordPayment stores the latest paid charge of a subscription, for refunds.
func (s *Service) recordPayment(ctx context.Context, subID, payment string, paidAt int64) error {
	_, err := s.Store.DB.ExecContext(ctx, `UPDATE subscriptions SET latest_payment = ?, latest_paid_at = ?, refunded_at = NULL
		WHERE id = ? AND ifnull(latest_paid_at, 0) <= ?`, payment, paidAt, subID, paidAt)
	return err
}

// markRefunded records a refund of the charge or PaymentIntent with these IDs ("" matches nothing).
func (s *Service) markRefunded(ctx context.Context, id1, id2 string, now int64) error {
	return s.Store.Tx(ctx, func(tx *sql.Tx) error {
		for _, table := range []string{"subscriptions SET refunded_at = ? WHERE latest_payment", "donations SET refunded_at = ? WHERE payment"} {
			if _, err := tx.ExecContext(ctx, `UPDATE `+table+` IN (?, ?) AND refunded_at IS NULL`, now, id1, id2); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Service) saveDonation(ctx context.Context, cs checkoutSession, at int64) error {
	var payment, subscription sql.NullString
	if cs.PaymentIntent != "" {
		payment = sql.NullString{String: cs.PaymentIntent, Valid: true}
	}
	if cs.Subscription != "" {
		subscription = sql.NullString{String: cs.Subscription, Valid: true}
	}
	var credit sql.NullString
	if name := strings.TrimSpace(cs.Metadata["credit_name"]); name != "" {
		credit = sql.NullString{String: name, Valid: true}
	}
	_, err := s.Store.DB.ExecContext(ctx, `INSERT INTO donations (id, amount_cents, currency, recurring, credit_name, payment,
		subscription_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
		cs.ID, cs.AmountTotal, cs.Currency, cs.Mode == "subscription", credit, payment, subscription, at)
	return err
}
