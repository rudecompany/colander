package api

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/rudecompany/colander/server/internal/billing"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/sign"
)

// planJSON is the plan object on an account (contracts section 6.8).
type planJSON struct {
	Plan              string `json:"plan"`
	Interval          string `json:"interval"`
	Status            string `json:"status"`
	CurrentPeriodEnd  string `json:"current_period_end"`
	CancelAtPeriodEnd bool   `json:"cancel_at_period_end"`
	Refundable        bool   `json:"refundable"`
}

func toPlan(sub *billing.Subscription, now time.Time) *planJSON {
	if sub == nil {
		return nil
	}
	return &planJSON{Plan: "plus", Interval: sub.Interval, Status: sub.PlanStatus(), CurrentPeriodEnd: rfc3339(sub.PeriodEnd),
		CancelAtPeriodEnd: sub.CancelAtPeriodEnd, Refundable: sub.Refundable(now)}
}

func billingUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusServiceUnavailable, "billing_unavailable", "Payments are switched off right now, so nothing was charged.")
}

// billingFailed answers a failed Stripe call or database write on a billing route.
func (s *Server) billingFailed(w http.ResponseWriter, r *http.Request, err error) {
	var se *billing.StripeError
	if errors.As(err, &se) {
		s.Log.Error("stripe call failed", "route", r.Pattern, "err", err)
		writeError(w, http.StatusBadGateway, "payment_provider_error",
			"Our payment provider did not answer as expected, so nothing was changed. Please try again in a moment.")
		return
	}
	s.internalError(w, r, err)
}

func (s *Server) billingCheckout(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	var body struct {
		Price string `json:"price"`
	}
	if !decode(w, r, 1<<10, &body) {
		return
	}
	url, err := s.Billing.Checkout(r.Context(), a, body.Price)
	switch {
	case errors.Is(err, billing.ErrBadPrice):
		writeError(w, http.StatusBadRequest, "invalid_price", "price must be plus_yearly or plus_monthly.")
	case errors.Is(err, billing.ErrUnavailable):
		billingUnavailable(w)
	case errors.Is(err, billing.ErrAlreadySubscribed):
		writeError(w, http.StatusConflict, "already_subscribed", "This account already has Plus. You can manage it on your account page.")
	case err != nil:
		s.billingFailed(w, r, err)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"url": url})
	}
}

func (s *Server) billingDonate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		AmountCents int64  `json:"amount_cents"`
		Recurring   bool   `json:"recurring"`
		CreditName  string `json:"credit_name"`
	}
	if !decode(w, r, 2<<10, &body) {
		return
	}
	if !s.Billing.Enabled() {
		billingUnavailable(w)
		return
	}
	name := strings.TrimSpace(body.CreditName)
	switch {
	case body.AmountCents < 100 || body.AmountCents > 100000:
		writeError(w, http.StatusBadRequest, "invalid_amount", "Choose an amount from $1 to $1,000.")
		return
	case utf8.RuneCountInString(name) > 80 || strings.ContainsFunc(name, unicode.IsControl):
		writeError(w, http.StatusBadRequest, "invalid_credit_name", "The name for the supporters page must be one line of at most 80 characters.")
		return
	}
	if ok, retry := allow(s.Now(), s.clientIP(r), 1, s.limits.donate); !ok {
		tooMany(w, retry)
		return
	}
	url, err := s.Billing.Donate(r.Context(), body.AmountCents, body.Recurring, name)
	if err != nil {
		s.billingFailed(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *Server) billingCancel(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	var body struct {
		Refund bool `json:"refund"`
	}
	if !decode(w, r, 1<<10, &body) {
		return
	}
	sub, err := s.Billing.Cancel(r.Context(), a.ID, body.Refund, s.Now())
	switch {
	case errors.Is(err, billing.ErrUnavailable):
		billingUnavailable(w)
		return
	case errors.Is(err, billing.ErrNoPlan):
		writeError(w, http.StatusNotFound, "no_plan", "There is no running Plus plan on this account to cancel.")
		return
	case errors.Is(err, billing.ErrNotRefundable):
		writeError(w, http.StatusConflict, "not_refundable",
			"Your last charge is more than 30 days old, so it cannot be refunded. You can still cancel, and Plus stays on until the end of the period.")
		return
	case err != nil:
		s.billingFailed(w, r, err)
		return
	}
	var subject, text string
	if body.Refund {
		subject, text = mail.PlusRefunded()
	} else {
		subject, text = mail.PlusCancelled(time.Unix(sub.PeriodEnd, 0))
	}
	if err := s.Mail.Send(r.Context(), a.Email, subject, text); err != nil {
		s.Log.Error("billing email not sent", "err", err)
	}
	s.writeAccount(w, r, a)
}

func (s *Server) billingWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.Billing.Enabled() || s.Billing.WebhookSecret == "" {
		billingUnavailable(w)
		return
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "The webhook body is too large.")
		return
	}
	err = s.Billing.HandleWebhook(r.Context(), payload, r.Header.Get("Stripe-Signature"), s.Now())
	if errors.Is(err, billing.ErrSignature) {
		s.Log.Warn("stripe webhook rejected", "err", err)
		writeError(w, http.StatusBadRequest, "invalid_signature", "The Stripe-Signature header does not verify.")
		return
	}
	if err != nil {
		// A 500 makes Stripe retry later.
		s.Log.Error("stripe webhook failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "The event could not be applied. Stripe will retry it.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"received": true})
}

func (s *Server) postEntitlement(w http.ResponseWriter, r *http.Request) {
	a, ok := s.session(w, r)
	if !ok {
		return
	}
	s.issuePlanToken(w, r, a.ID)
}

// refreshEntitlement re-issues a paid plan token while the subscription behind it runs. The token
// may have expired; its signature proves which account it was issued to. Trial tokens never
// become paid ones.
func (s *Server) refreshEntitlement(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if !decode(w, r, 4<<10, &body) {
		return
	}
	c, err := sign.VerifyPlanToken(s.Key.Public, body.Token, s.Now())
	if err != nil && !errors.Is(err, sign.ErrExpired) {
		writeError(w, http.StatusBadRequest, "invalid_plan", "The plan token is not valid.")
		return
	}
	if c.Trial {
		writeError(w, http.StatusNotFound, "no_plan", "A trial token cannot be refreshed. Get Plus to keep its features.")
		return
	}
	s.issuePlanToken(w, r, c.Sub)
}

func (s *Server) issuePlanToken(w http.ResponseWriter, r *http.Request, accountID string) {
	claims, err := s.Billing.PlanClaims(r.Context(), accountID, s.Now())
	if errors.Is(err, billing.ErrNoPlan) {
		writeError(w, http.StatusNotFound, "no_plan", "There is no active Plus plan on this account.")
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

func (s *Server) getSupporters(w http.ResponseWriter, r *http.Request) {
	list, err := s.Billing.Supporters(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	type supporterJSON struct {
		Name  string `json:"name"`
		Since string `json:"since"`
	}
	out := make([]supporterJSON, len(list))
	for i, sp := range list {
		out[i] = supporterJSON{Name: sp.Name, Since: rfc3339(sp.Since)}
	}
	writeJSON(w, http.StatusOK, map[string]any{"supporters": out})
}
