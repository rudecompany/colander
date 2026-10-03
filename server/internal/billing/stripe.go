package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// APIVersion pins the Stripe API version, so object shapes never change under the server.
const APIVersion = "2026-04-22.dahlia"

// StripeError is a failed Stripe call: an error answer, or no usable answer at all (Status 0).
type StripeError struct {
	Status  int
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *StripeError) Error() string {
	return fmt.Sprintf("stripe: status %d %s %s: %s", e.Status, e.Type, e.Code, e.Message)
}

// call sends one form-encoded request to Stripe and decodes the JSON answer into out.
// ponytail: plain net/http instead of stripe-go; a handful of endpoints do not need the SDK.
func (s *Service) call(ctx context.Context, method, path string, form url.Values, idempotencyKey string, out any) error {
	u := s.APIBase + path
	var body io.Reader
	if len(form) > 0 {
		if method == http.MethodGet {
			u += "?" + form.Encode()
		} else {
			body = strings.NewReader(form.Encode())
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.SecretKey)
	req.Header.Set("Stripe-Version", APIVersion)
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return &StripeError{Type: "network", Message: method + " " + path + ": " + err.Error()}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return &StripeError{Status: resp.StatusCode, Type: "network", Message: err.Error()}
	}
	if resp.StatusCode >= 300 {
		var e struct {
			Error StripeError `json:"error"`
		}
		json.Unmarshal(raw, &e)
		e.Error.Status = resp.StatusCode
		return &e.Error
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &StripeError{Status: resp.StatusCode, Type: "decode", Message: err.Error()}
	}
	return nil
}

// The Stripe objects below hold only the fields Colander reads (API version 2026-04-22.dahlia).

type stripeSubscription struct {
	ID                string            `json:"id"`
	Customer          string            `json:"customer"`
	Status            string            `json:"status"`
	CancelAtPeriodEnd bool              `json:"cancel_at_period_end"`
	CancelAt          int64             `json:"cancel_at"`
	StartDate         int64             `json:"start_date"`
	Metadata          map[string]string `json:"metadata"`
	Items             struct {
		Data []struct {
			// Since API version 2025-03-31.basil the billing period lives on the item.
			CurrentPeriodStart int64 `json:"current_period_start"`
			CurrentPeriodEnd   int64 `json:"current_period_end"`
			Price              struct {
				Recurring struct {
					Interval string `json:"interval"`
				} `json:"recurring"`
			} `json:"price"`
		} `json:"data"`
	} `json:"items"`
}

type checkoutSession struct {
	ID                string            `json:"id"`
	URL               string            `json:"url"`
	Mode              string            `json:"mode"`
	PaymentStatus     string            `json:"payment_status"`
	ClientReferenceID string            `json:"client_reference_id"`
	Customer          string            `json:"customer"`
	Subscription      string            `json:"subscription"`
	PaymentIntent     string            `json:"payment_intent"`
	AmountTotal       int64             `json:"amount_total"`
	Currency          string            `json:"currency"`
	Metadata          map[string]string `json:"metadata"`
}

type stripeInvoice struct {
	ID         string `json:"id"`
	AmountPaid int64  `json:"amount_paid"`
	// Since API version 2025-03-31.basil the subscription is under parent.subscription_details.
	Parent struct {
		SubscriptionDetails struct {
			Subscription string            `json:"subscription"`
			Metadata     map[string]string `json:"metadata"`
		} `json:"subscription_details"`
	} `json:"parent"`
}

// invoicePayment replaced invoice.charge and invoice.payment_intent in 2025-03-31.basil.
type invoicePayment struct {
	Status  string `json:"status"`
	Payment struct {
		Type          string `json:"type"`
		PaymentIntent string `json:"payment_intent"`
		Charge        string `json:"charge"`
	} `json:"payment"`
	StatusTransitions struct {
		PaidAt int64 `json:"paid_at"`
	} `json:"status_transitions"`
}

type stripeCharge struct {
	ID             string `json:"id"`
	PaymentIntent  string `json:"payment_intent"`
	AmountRefunded int64  `json:"amount_refunded"`
}
