// Package billingtest is a small in-memory fake of the Stripe endpoints Colander uses. Tests point
// STRIPE_API_BASE at it, inspect the requests it recorded and pay checkout sessions to get the
// webhook events Stripe would send. It never talks to Stripe.
package billingtest

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Request is one API call the fake received.
type Request struct {
	Method, Path string
	Form         url.Values // body for POST, query for GET
	Header       http.Header
}

// Price is a recurring price configured in the fake's catalog.
type Price struct {
	Amount   int64
	Interval string // month | year
}

// Fake is an in-memory Stripe.
type Fake struct {
	*httptest.Server
	Prices map[string]Price
	Now    func() time.Time
	// WebhookURL and WebhookSecret are used by the hosted /pay page, which delivers events itself.
	WebhookURL, WebhookSecret string

	mu       sync.Mutex
	n        int
	requests []Request
	sessions map[string]map[string]any
	subs     map[string]map[string]any
	payments map[string][]map[string]any // invoice id to invoice payments
	refunds  map[string]bool             // refunded PaymentIntents
}

// New starts a fake. Close it when done.
func New() *Fake {
	f := &Fake{Prices: map[string]Price{}, Now: time.Now, sessions: map[string]map[string]any{},
		subs: map[string]map[string]any{}, payments: map[string][]map[string]any{}, refunds: map[string]bool{}}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

// Requests returns the recorded API calls with this method and path ("" matches any).
func (f *Fake) Requests(method, path string) []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Request
	for _, r := range f.requests {
		if (method == "" || r.Method == method) && (path == "" || r.Path == path) {
			out = append(out, r)
		}
	}
	return out
}

func (f *Fake) id(prefix string) string {
	f.n++
	return fmt.Sprintf("%s_fake%04d", prefix, f.n)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func notFound(w http.ResponseWriter, what string) {
	writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{
		"type": "invalid_request_error", "code": "resource_missing", "message": "No such " + what}})
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/pay/") {
		f.pay(w, r)
		return
	}
	r.ParseForm()
	form := r.PostForm
	if r.Method == http.MethodGet {
		form = r.URL.Query()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, Request{Method: r.Method, Path: r.URL.Path, Form: form, Header: r.Header.Clone()})
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer sk_") {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"type": "invalid_request_error", "message": "Invalid API Key provided"}})
		return
	}
	switch p := r.URL.Path; {
	case r.Method == http.MethodPost && p == "/v1/checkout/sessions":
		id := f.id("cs_test")
		s := map[string]any{"id": id, "object": "checkout.session", "url": f.URL + "/pay/" + id, "mode": form.Get("mode"),
			"client_reference_id": form.Get("client_reference_id"), "customer": form.Get("customer"),
			"customer_email": form.Get("customer_email"), "success_url": form.Get("success_url"), "cancel_url": form.Get("cancel_url"),
			"metadata": nested(form, "metadata"), "payment_status": "unpaid", "status": "open", "form": form}
		f.sessions[id] = s
		writeJSON(w, http.StatusOK, s)
	case strings.HasPrefix(p, "/v1/subscriptions/"):
		sub := f.subs[strings.TrimPrefix(p, "/v1/subscriptions/")]
		if sub == nil {
			notFound(w, "subscription")
			return
		}
		switch r.Method {
		case http.MethodPost:
			if form.Get("cancel_at_period_end") == "true" {
				sub["cancel_at_period_end"] = true
			}
		case http.MethodDelete:
			sub["status"] = "canceled"
			sub["ended_at"] = f.Now().Unix()
		}
		writeJSON(w, http.StatusOK, sub)
	case r.Method == http.MethodGet && p == "/v1/invoice_payments":
		writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": f.payments[form.Get("invoice")], "has_more": false})
	case r.Method == http.MethodPost && p == "/v1/refunds":
		pi := form.Get("payment_intent")
		if f.refunds[pi] {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"type": "invalid_request_error", "code": "charge_already_refunded"}})
			return
		}
		f.refunds[pi] = true
		writeJSON(w, http.StatusOK, map[string]any{"id": f.id("re"), "object": "refund", "payment_intent": pi, "status": "succeeded"})
	default:
		notFound(w, "route "+r.Method+" "+p)
	}
}

// nested collects form keys like metadata[kind] into a map.
func nested(form url.Values, prefix string) map[string]string {
	out := map[string]string{}
	for k, v := range form {
		if inner, ok := strings.CutPrefix(k, prefix+"["); ok && strings.HasSuffix(inner, "]") && !strings.Contains(inner, "[") {
			out[strings.TrimSuffix(inner, "]")] = v[0]
		}
	}
	return out
}

// Pay completes a checkout session as if the customer paid, and returns the webhook payloads
// Stripe would send, in the order it usually sends them.
func (f *Fake) Pay(sessionID string) [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.sessions[sessionID]
	if s == nil {
		panic("billingtest: unknown checkout session " + sessionID)
	}
	form := s["form"].(url.Values)
	now := f.Now().Unix()
	if s["customer"] == "" {
		s["customer"] = f.id("cus")
	}
	s["status"], s["payment_status"] = "complete", "paid"
	amount, interval := f.priceOf(form)
	s["amount_total"], s["currency"] = amount, "usd"
	var events [][]byte
	if s["mode"] == "payment" {
		s["payment_intent"] = f.id("pi")
		return append(events, f.event("checkout.session.completed", s))
	}
	sub := map[string]any{"id": f.id("sub"), "object": "subscription", "customer": s["customer"], "status": "active",
		"cancel_at_period_end": false, "cancel_at": nil, "start_date": now, "metadata": nested(form, "subscription_data[metadata]"),
		"items": map[string]any{"object": "list", "data": []any{map[string]any{
			"current_period_start": now, "current_period_end": addInterval(now, interval),
			"price": map[string]any{"id": form.Get("line_items[0][price]"), "unit_amount": amount, "recurring": map[string]any{"interval": interval}},
		}}}}
	f.subs[sub["id"].(string)] = sub
	s["subscription"] = sub["id"]
	events = append(events, f.event("customer.subscription.created", sub))
	events = append(events, f.event("checkout.session.completed", s))
	return append(events, f.invoice(sub, amount, true))
}

// Renew starts the subscription's next period. When paid is false the renewal payment fails and
// the subscription becomes past_due; renewing a past_due subscription retries the same period.
func (f *Fake) Renew(subID string, paid bool) [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	sub := f.subs[subID]
	item := sub["items"].(map[string]any)["data"].([]any)[0].(map[string]any)
	if sub["status"] != "past_due" {
		start := item["current_period_end"].(int64)
		interval := item["price"].(map[string]any)["recurring"].(map[string]any)["interval"].(string)
		item["current_period_start"], item["current_period_end"] = start, addInterval(start, interval)
	}
	if paid {
		sub["status"] = "active"
	} else {
		sub["status"] = "past_due"
	}
	return [][]byte{f.invoice(sub, item["price"].(map[string]any)["unit_amount"].(int64), paid), f.event("customer.subscription.updated", sub)}
}

// Cancel ends a subscription now, as when the customer cancels through Link, and returns the event.
func (f *Fake) Cancel(subID string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs[subID]["status"] = "canceled"
	return f.event("customer.subscription.deleted", f.subs[subID])
}

// Refunded returns the charge.refunded event for a PaymentIntent refunded outside Colander.
func (f *Fake) Refunded(paymentIntent string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refunds[paymentIntent] = true
	return f.event("charge.refunded", map[string]any{"id": f.id("ch"), "object": "charge", "payment_intent": paymentIntent, "amount_refunded": 300})
}

// Subscription returns a copy of a subscription's JSON.
func (f *Fake) Subscription(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := json.Marshal(f.subs[id])
	var out map[string]any
	json.Unmarshal(b, &out)
	return out
}

func (f *Fake) invoice(sub map[string]any, amount int64, paid bool) []byte {
	id, pi, now := f.id("in"), f.id("pi"), f.Now().Unix()
	inv := map[string]any{"id": id, "object": "invoice", "customer": sub["customer"], "amount_paid": 0, "status": "open",
		"parent": map[string]any{"type": "subscription_details", "subscription_details": map[string]any{
			"subscription": sub["id"], "metadata": sub["metadata"]}}}
	if !paid {
		return f.event("invoice.payment_failed", inv)
	}
	inv["amount_paid"], inv["status"] = amount, "paid"
	f.payments[id] = []map[string]any{{"id": f.id("inpay"), "object": "invoice_payment", "invoice": id, "status": "paid",
		"amount_paid": amount, "payment": map[string]any{"type": "payment_intent", "payment_intent": pi},
		"status_transitions": map[string]any{"paid_at": now}}}
	return f.event("invoice.paid", inv)
}

func (f *Fake) priceOf(form url.Values) (int64, string) {
	if p, ok := f.Prices[form.Get("line_items[0][price]")]; ok {
		return p.Amount, p.Interval
	}
	amount, _ := strconv.ParseInt(form.Get("line_items[0][price_data][unit_amount]"), 10, 64)
	return amount, form.Get("line_items[0][price_data][recurring][interval]")
}

func addInterval(t int64, interval string) int64 {
	if interval == "year" {
		return time.Unix(t, 0).UTC().AddDate(1, 0, 0).Unix()
	}
	return time.Unix(t, 0).UTC().AddDate(0, 1, 0).Unix()
}

func (f *Fake) event(typ string, obj map[string]any) []byte {
	clean := map[string]any{}
	for k, v := range obj {
		if k != "form" {
			clean[k] = v
		}
	}
	b, _ := json.Marshal(map[string]any{"id": f.id("evt"), "object": "event", "type": typ, "created": f.Now().Unix(),
		"api_version": "2026-04-22.dahlia", "data": map[string]any{"object": clean}})
	return b
}

// Sign returns a Stripe-Signature header for payload, signed at t with secret.
func Sign(payload []byte, secret string, t time.Time) string {
	ts := strconv.FormatInt(t.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(payload)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// pay is the fake hosted checkout page: GET shows Pay and Cancel, POST pays, delivers the webhook
// events to WebhookURL and returns to the session's success URL.
func (f *Fake) pay(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/pay/")
	f.mu.Lock()
	s := f.sessions[id]
	f.mu.Unlock()
	if s == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		amount, interval := f.priceOf(s["form"].(url.Values))
		what := fmt.Sprintf("$%d.%02d", amount/100, amount%100)
		if interval != "" {
			what += " a " + interval
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><title>Fake checkout</title><h1>Fake checkout</h1><p>%s (test only, no card)</p>
<form method="post"><button>Pay</button></form><p><a href="%s">Cancel</a></p>`, html.EscapeString(what), html.EscapeString(s["cancel_url"].(string)))
		return
	}
	for _, ev := range f.Pay(id) {
		req, _ := http.NewRequest(http.MethodPost, f.WebhookURL, bytes.NewReader(ev))
		req.Header.Set("Stripe-Signature", Sign(ev, f.WebhookSecret, f.Now()))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			http.Error(w, "webhook delivery failed: "+err.Error(), http.StatusBadGateway)
			return
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			http.Error(w, "webhook answered "+resp.Status, http.StatusBadGateway)
			return
		}
	}
	http.Redirect(w, r, s["success_url"].(string), http.StatusSeeOther)
}
