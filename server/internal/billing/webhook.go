package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrSignature is returned for a webhook whose Stripe-Signature does not verify or is stale.
var ErrSignature = errors.New("stripe webhook signature does not verify")

// SignatureTolerance is how far a webhook's signed timestamp may be from now.
const SignatureTolerance = 5 * time.Minute

// VerifySignature checks a Stripe-Signature header ("t=...,v1=...,v1=...") over payload with the
// endpoint secret: HMAC-SHA256 of "t.payload", any v1 value may match, compared in constant time.
func VerifySignature(payload []byte, header, secret string, now time.Time) error {
	var ts string
	var sigs [][]byte
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "t":
			ts = v
		case "v1":
			if b, err := hex.DecodeString(v); err == nil {
				sigs = append(sigs, b)
			}
		}
	}
	t, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || len(sigs) == 0 || secret == "" {
		return ErrSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(payload)
	want := mac.Sum(nil)
	match := false
	for _, sig := range sigs {
		match = hmac.Equal(sig, want) || match // hmac.Equal is constant time; check every value
	}
	if !match {
		return ErrSignature
	}
	if d := now.Sub(time.Unix(t, 0)); d > SignatureTolerance || d < -SignatureTolerance {
		return fmt.Errorf("%w: timestamp is %s away", ErrSignature, d.Round(time.Second))
	}
	return nil
}

type event struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Data    struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

// HandleWebhook verifies and applies one Stripe event. An event handled before is ignored.
// It returns ErrSignature for a bad signature; any other error means Stripe should retry.
func (s *Service) HandleWebhook(ctx context.Context, payload []byte, signature string, now time.Time) error {
	if err := VerifySignature(payload, signature, s.WebhookSecret, now); err != nil {
		return err
	}
	var ev event
	if err := json.Unmarshal(payload, &ev); err != nil || ev.ID == "" {
		return fmt.Errorf("%w: payload is not a Stripe event", ErrSignature)
	}
	var seen int
	if err := s.Store.DB.QueryRowContext(ctx, `SELECT count(*) FROM billing_events WHERE id = ?`, ev.ID).Scan(&seen); err != nil {
		return err
	}
	if seen > 0 {
		return nil
	}
	if err := s.apply(ctx, ev, now.Unix()); err != nil {
		return fmt.Errorf("%s %s: %w", ev.Type, ev.ID, err)
	}
	// Every handler is an idempotent upsert, so two deliveries racing past the check above is harmless.
	_, err := s.Store.DB.ExecContext(ctx, `INSERT INTO billing_events (id, type, received_at) VALUES (?, ?, ?)
		ON CONFLICT (id) DO NOTHING`, ev.ID, ev.Type, now.Unix())
	return err
}

func (s *Service) apply(ctx context.Context, ev event, now int64) error {
	obj := ev.Data.Object
	switch ev.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		var cs checkoutSession
		if err := json.Unmarshal(obj, &cs); err != nil {
			return err
		}
		switch {
		case cs.Metadata["kind"] == "donation" && (cs.PaymentStatus == "paid" || cs.PaymentStatus == "no_payment_required"):
			return s.saveDonation(ctx, cs, ev.Created)
		case cs.Metadata["kind"] == "plus" && cs.Subscription != "":
			return s.syncSubscription(ctx, cs.Subscription, now)
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		var sub stripeSubscription
		if err := json.Unmarshal(obj, &sub); err != nil {
			return err
		}
		if sub.Metadata["kind"] == "plus" {
			return s.syncSubscription(ctx, sub.ID, now)
		}
	case "invoice.paid", "invoice.payment_failed":
		var inv stripeInvoice
		if err := json.Unmarshal(obj, &inv); err != nil {
			return err
		}
		details := inv.Parent.SubscriptionDetails
		if details.Subscription == "" || details.Metadata["kind"] == "donation" {
			return nil
		}
		if err := s.syncSubscription(ctx, details.Subscription, now); err != nil {
			return err
		}
		if ev.Type == "invoice.paid" && inv.AmountPaid > 0 {
			return s.syncPayment(ctx, details.Subscription, inv.ID)
		}
	case "charge.refunded":
		var ch stripeCharge
		if err := json.Unmarshal(obj, &ch); err != nil {
			return err
		}
		if ch.AmountRefunded > 0 {
			return s.markRefunded(ctx, ch.ID, ch.PaymentIntent, now)
		}
	}
	return nil
}

// syncSubscription fetches the subscription's current state from Stripe and stores it. Reading it
// fresh, rather than trusting the event's copy, makes events that arrive out of order harmless.
func (s *Service) syncSubscription(ctx context.Context, id string, now int64) error {
	var sub stripeSubscription
	if err := s.call(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(id), nil, "", &sub); err != nil {
		return err
	}
	return s.saveSubscription(ctx, sub, now)
}

// syncPayment stores the PaymentIntent (or Charge) that paid an invoice, so it can be refunded.
func (s *Service) syncPayment(ctx context.Context, subID, invoiceID string) error {
	var list struct {
		Data []invoicePayment `json:"data"`
	}
	q := url.Values{"invoice": {invoiceID}, "status": {"paid"}}
	if err := s.call(ctx, http.MethodGet, "/v1/invoice_payments", q, "", &list); err != nil {
		return err
	}
	var best invoicePayment
	for _, p := range list.Data {
		if p.Status == "paid" && p.StatusTransitions.PaidAt >= best.StatusTransitions.PaidAt {
			best = p
		}
	}
	ref := best.Payment.PaymentIntent
	if best.Payment.Type == "charge" {
		ref = best.Payment.Charge
	}
	if ref == "" {
		return nil
	}
	return s.recordPayment(ctx, subID, ref, best.StatusTransitions.PaidAt)
}
