package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/rudecompany/colander/server/internal/billing"
	"github.com/rudecompany/colander/server/internal/billing/billingtest"
	"github.com/rudecompany/colander/server/internal/sign"
)

const testWebhookSecret = "whsec_test_colander"

// stripe switches billing on against a fake Stripe that shares the harness clock.
func (h *harness) stripe(managed bool) *billingtest.Fake {
	h.t.Helper()
	f := billingtest.New()
	h.t.Cleanup(f.Close)
	f.Now = func() time.Time { return h.clock }
	f.Prices = map[string]billingtest.Price{"price_plus_year": {Amount: 3000, Interval: "year"}, "price_plus_month": {Amount: 300, Interval: "month"}}
	h.srv.Billing = billing.New(billing.Config{SecretKey: "sk_test_colander", WebhookSecret: testWebhookSecret,
		PriceMonthly: "price_plus_month", PriceYearly: "price_plus_year", ManagedPayments: managed, APIBase: f.URL,
		PublicURL: "http://localhost:8787"}, h.srv.Store, h.srv.Log)
	return f
}

// deliver posts signed webhook events and expects each to be accepted.
func (h *harness) deliver(events ...[]byte) {
	h.t.Helper()
	for _, ev := range events {
		expect(h.t, h.do("POST", "/v1/billing/webhook", string(ev), "Stripe-Signature", billingtest.Sign(ev, testWebhookSecret, h.clock)), http.StatusOK)
	}
}

// checkout starts a checkout as the signed-in cookie and returns the session id from its URL.
func (h *harness) checkout(cookie, price string) string {
	h.t.Helper()
	w := h.do("POST", "/v1/billing/checkout", map[string]string{"price": price}, "Cookie", cookie, "X-Colander-CSRF", "1")
	expect(h.t, w, http.StatusOK)
	return path.Base(decodeBody[struct{ URL string }](h.t, w).URL)
}

type testPlan struct {
	Plan              string `json:"plan"`
	Interval          string `json:"interval"`
	Status            string `json:"status"`
	CurrentPeriodEnd  string `json:"current_period_end"`
	CancelAtPeriodEnd bool   `json:"cancel_at_period_end"`
	Refundable        bool   `json:"refundable"`
}

func (h *harness) plan(cookie string) *testPlan {
	h.t.Helper()
	w := h.do("GET", "/v1/account", nil, "Cookie", cookie)
	expect(h.t, w, http.StatusOK)
	return decodeBody[struct{ Account struct{ Plan *testPlan } }](h.t, w).Account.Plan
}

func (h *harness) entitlement(cookie string) (string, int) {
	h.t.Helper()
	w := h.do("POST", "/v1/entitlement", nil, "Cookie", cookie, "X-Colander-CSRF", "1")
	return decodeBody[struct{ Token string }](h.t, w).Token, w.Code
}

func devPublicKey(t *testing.T) ed25519.PublicKey {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/dev-signing.pub")
	if err != nil {
		t.Fatal(err)
	}
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return pub
}

func TestBillingUnavailableWithoutKeys(t *testing.T) {
	h := newHarness(t)
	cookie := h.signIn("maya@example.test")
	csrf := []string{"Cookie", cookie, "X-Colander-CSRF", "1"}
	for _, c := range []struct {
		path string
		body any
	}{
		{"/v1/billing/checkout", map[string]string{"price": "plus_yearly"}},
		{"/v1/billing/donate", map[string]any{"amount_cents": 500, "recurring": false}},
		{"/v1/billing/cancel", map[string]bool{"refund": false}},
		{"/v1/billing/webhook", `{"id":"evt_1"}`},
	} {
		w := h.do("POST", c.path, c.body, csrf...)
		expect(t, w, http.StatusServiceUnavailable)
		if code := errorCode(t, w); code != "billing_unavailable" {
			t.Fatalf("%s: code %q", c.path, code)
		}
	}
	// Stored state still answers: no plan, no token, an empty supporters list.
	if p := h.plan(cookie); p != nil {
		t.Fatalf("plan = %+v", p)
	}
	if _, code := h.entitlement(cookie); code != http.StatusNotFound {
		t.Fatalf("entitlement status %d", code)
	}
	w := h.do("GET", "/v1/supporters", nil)
	expect(t, w, http.StatusOK)
	if strings.TrimSpace(w.Body.String()) != `{"supporters":[]}` {
		t.Fatalf("supporters = %s", w.Body.String())
	}
}

func TestCheckoutAndDonationParams(t *testing.T) {
	h := newHarness(t)
	f := h.stripe(true)
	cookie := h.signIn("maya@example.test")
	acct := decodeBody[struct{ Account struct{ ID string } }](t, h.do("GET", "/v1/account", nil, "Cookie", cookie)).Account

	h.checkout(cookie, "plus_yearly")
	req := f.Requests("POST", "/v1/checkout/sessions")[0]
	want := map[string]string{
		"mode": "subscription", "line_items[0][price]": "price_plus_year", "line_items[0][quantity]": "1",
		"managed_payments[enabled]": "true", "client_reference_id": acct.ID, "customer_email": "maya@example.test",
		"subscription_data[metadata][account_id]": acct.ID, "subscription_data[metadata][kind]": "plus",
		"success_url": "http://localhost:8787/plans/welcome", "cancel_url": "http://localhost:8787/plans?checkout=plus_yearly&cancelled=1",
	}
	for k, v := range want {
		if got := req.Form.Get(k); got != v {
			t.Errorf("checkout %s = %q, want %q", k, got, v)
		}
	}
	// Managed Payments rejects these, so they must never be sent.
	for k := range req.Form {
		if strings.HasPrefix(k, "automatic_tax") || strings.HasPrefix(k, "payment_method") || strings.HasPrefix(k, "shipping") ||
			strings.HasPrefix(k, "tax_id") || strings.HasPrefix(k, "customer_update") || k == "invoice_creation" {
			t.Errorf("checkout sends %s, which Managed Payments rejects", k)
		}
	}
	if req.Header.Get("Stripe-Version") != billing.APIVersion || req.Header.Get("Authorization") != "Bearer sk_test_colander" {
		t.Fatalf("checkout headers = %v", req.Header)
	}

	h.checkout(cookie, "plus_monthly")
	if got := f.Requests("POST", "/v1/checkout/sessions")[1].Form.Get("line_items[0][price]"); got != "price_plus_month" {
		t.Fatalf("monthly price = %q", got)
	}
	w := h.do("POST", "/v1/billing/checkout", map[string]string{"price": "family_yearly"}, "Cookie", cookie, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusBadRequest)
	expect(t, h.do("POST", "/v1/billing/checkout", map[string]string{"price": "plus_yearly"}), http.StatusForbidden) // no CSRF header

	// With Managed Payments switched off the flag is not sent at all.
	off := h.stripe(false)
	h.checkout(cookie, "plus_yearly")
	if _, sent := off.Requests("POST", "/v1/checkout/sessions")[0].Form["managed_payments[enabled]"]; sent {
		t.Fatal("managed_payments sent while switched off")
	}

	// Donations: regular Checkout, never Managed Payments, with the amount as price_data.
	f = h.stripe(true)
	donate := func(body map[string]any) *billingtest.Request {
		t.Helper()
		expect(t, h.do("POST", "/v1/billing/donate", body), http.StatusOK)
		reqs := f.Requests("POST", "/v1/checkout/sessions")
		return &reqs[len(reqs)-1]
	}
	once := donate(map[string]any{"amount_cents": 500, "recurring": false, "credit_name": "  Ana  "})
	for k, v := range map[string]string{"mode": "payment", "submit_type": "donate", "line_items[0][price_data][unit_amount]": "500",
		"line_items[0][price_data][currency]": "usd", "metadata[kind]": "donation", "metadata[credit_name]": "Ana",
		"success_url": "http://localhost:8787/support/thanks"} {
		if got := once.Form.Get(k); got != v {
			t.Errorf("donation %s = %q, want %q", k, got, v)
		}
	}
	monthly := donate(map[string]any{"amount_cents": 1000, "recurring": true})
	if monthly.Form.Get("mode") != "subscription" || monthly.Form.Get("line_items[0][price_data][recurring][interval]") != "month" ||
		monthly.Form.Get("subscription_data[metadata][kind]") != "donation" {
		t.Fatalf("monthly donation form = %v", monthly.Form)
	}
	for _, r := range []*billingtest.Request{once, monthly} {
		if _, sent := r.Form["managed_payments[enabled]"]; sent {
			t.Fatal("a donation must not use Managed Payments")
		}
		if _, sent := r.Form["metadata[credit_name]"]; sent && r == monthly {
			t.Fatal("an empty credit name must not be sent")
		}
	}
	for _, bad := range []map[string]any{{"amount_cents": 99}, {"amount_cents": 100001}, {"amount_cents": 500, "credit_name": "two\nlines"}} {
		expect(t, h.do("POST", "/v1/billing/donate", bad), http.StatusBadRequest)
	}
	// Donations are rate-limited per client IP.
	for range 8 {
		h.do("POST", "/v1/billing/donate", map[string]any{"amount_cents": 300})
	}
	expect(t, h.do("POST", "/v1/billing/donate", map[string]any{"amount_cents": 300}), http.StatusTooManyRequests)
}

func TestWebhookSignatureAndReplay(t *testing.T) {
	h := newHarness(t)
	f := h.stripe(true)
	cookie := h.signIn("maya@example.test")
	events := f.Pay(h.checkout(cookie, "plus_yearly"))
	created := events[0]
	post := func(body []byte, sig string) int {
		return h.do("POST", "/v1/billing/webhook", string(body), "Stripe-Signature", sig).Code
	}

	tampered := []byte(strings.Replace(string(created), `"active"`, `"trialing"`, 1))
	if code := post(tampered, billingtest.Sign(created, testWebhookSecret, h.clock)); code != http.StatusBadRequest {
		t.Fatalf("tampered event: status %d", code)
	}
	if code := post(created, billingtest.Sign(created, "whsec_wrong", h.clock)); code != http.StatusBadRequest {
		t.Fatalf("wrong secret: status %d", code)
	}
	if code := post(created, billingtest.Sign(created, testWebhookSecret, h.clock.Add(-6*time.Minute))); code != http.StatusBadRequest {
		t.Fatalf("stale event: status %d", code)
	}
	if code := post(created, ""); code != http.StatusBadRequest {
		t.Fatalf("unsigned event: status %d", code)
	}
	if p := h.plan(cookie); p != nil {
		t.Fatalf("a rejected event changed the plan: %+v", p)
	}
	// Stripe may send several v1 signatures while a secret rolls; any one may match.
	good := billingtest.Sign(created, testWebhookSecret, h.clock)
	rolled := good + ",v1=" + strings.Repeat("ab", 32)
	if code := post(created, rolled); code != http.StatusOK {
		t.Fatalf("valid event: status %d", code)
	}

	calls := len(f.Requests("", ""))
	if code := post(created, good); code != http.StatusOK {
		t.Fatalf("replayed event: status %d", code)
	}
	if len(f.Requests("", "")) != calls {
		t.Fatal("a replayed event was applied again")
	}
}

func TestPlusLifecycleAndEntitlements(t *testing.T) {
	h := newHarness(t)
	f := h.stripe(true)
	cookie := h.signIn("maya@example.test")
	acct := decodeBody[struct{ Account struct{ ID string } }](t, h.do("GET", "/v1/account", nil, "Cookie", cookie)).Account
	start := h.clock
	h.deliver(f.Pay(h.checkout(cookie, "plus_yearly"))...)

	periodEnd := start.AddDate(1, 0, 0)
	p := h.plan(cookie)
	if p == nil || p.Plan != "plus" || p.Interval != "year" || p.Status != "active" || p.CancelAtPeriodEnd || !p.Refundable ||
		p.CurrentPeriodEnd != periodEnd.UTC().Format(time.RFC3339) {
		t.Fatalf("plan after checkout = %+v", p)
	}
	w := h.do("POST", "/v1/billing/checkout", map[string]string{"price": "plus_monthly"}, "Cookie", cookie, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusConflict)

	// The token verifies with the published dev key and lasts until the period ends plus 3 days.
	token, code := h.entitlement(cookie)
	if code != http.StatusOK {
		t.Fatalf("entitlement status %d", code)
	}
	pub := devPublicKey(t)
	c, err := sign.VerifyPlanToken(pub, token, h.clock)
	if err != nil || c.Sub != acct.ID || c.Plan != "plus" || c.Trial || c.EXP != periodEnd.Add(billing.Grace).Unix() {
		t.Fatalf("plan token %+v (err %v)", c, err)
	}
	if _, err := sign.VerifyPlanToken(pub, token, time.Unix(c.EXP, 0)); !errors.Is(err, sign.ErrExpired) {
		t.Fatalf("token at exp: %v", err)
	}

	// Settings sync keeps working with a refreshed token, because sub is the account.
	planAuth := func(tok string) []string { return []string{"Authorization", "Plan " + tok} }
	expect(t, h.do("PUT", "/v1/sync", map[string]any{"version": 0, "data": map[string]any{"strictness": "strict"}}, planAuth(token)...), http.StatusOK)
	h.clock = h.clock.Add(24 * time.Hour)
	w = h.do("POST", "/v1/entitlement/refresh", map[string]string{"token": token})
	expect(t, w, http.StatusOK)
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("refresh must answer any origin")
	}
	fresh := decodeBody[struct{ Token string }](t, w).Token
	w = h.do("GET", "/v1/sync", nil, planAuth(fresh)...)
	expect(t, w, http.StatusOK)
	if !strings.Contains(w.Body.String(), `"strictness":"strict"`) {
		t.Fatalf("sync with a refreshed token = %s", w.Body.String())
	}

	// A failed renewal keeps Plus for 3 days of grace from the start of the unpaid period.
	h.clock = periodEnd.Add(time.Hour)
	cookie = h.signIn("maya@example.test") // sessions last 30 days
	h.deliver(f.Renew(subID(t, h), false)...)
	if p := h.plan(cookie); p.Status != "past_due" || p.Refundable {
		t.Fatalf("plan after a failed renewal = %+v", p)
	}
	token, _ = h.entitlement(cookie)
	if c, _ := sign.VerifyPlanToken(pub, token, h.clock); c.EXP != periodEnd.Add(billing.Grace).Unix() {
		t.Fatalf("past_due token exp %d", c.EXP)
	}
	h.deliver(f.Renew(subID(t, h), true)...)

	// Cancel at period end: one click, Plus stays on, a calm email.
	h.mail.Reset()
	w = h.do("POST", "/v1/billing/cancel", map[string]bool{"refund": false}, "Cookie", cookie, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusOK)
	got := decodeBody[struct{ Account struct{ Plan *testPlan } }](t, w).Account.Plan
	if got == nil || got.Status != "active" || !got.CancelAtPeriodEnd {
		t.Fatalf("plan after cancel = %+v", got)
	}
	if !strings.Contains(h.mail.String(), "Plus stays on until") {
		t.Fatalf("cancel email = %q", h.mail.String())
	}
	if r := f.Requests("POST", "/v1/subscriptions/"+subID(t, h)); len(r) != 1 || r[0].Form.Get("cancel_at_period_end") != "true" {
		t.Fatal("cancel did not set cancel_at_period_end")
	}
	if _, code := h.entitlement(cookie); code != http.StatusOK {
		t.Fatal("Plus must stay on until the period ends")
	}

	// The period ends: Stripe deletes the subscription. No more tokens, and refresh says no_plan.
	h.deliver(f.Cancel(subID(t, h)))
	if p := h.plan(cookie); p.Status != "canceled" || p.Refundable {
		t.Fatalf("plan after the period ended = %+v", p)
	}
	if _, code := h.entitlement(cookie); code != http.StatusNotFound {
		t.Fatalf("entitlement after cancellation: %d", code)
	}
	w = h.do("POST", "/v1/entitlement/refresh", map[string]string{"token": fresh})
	expect(t, w, http.StatusNotFound)
	if errorCode(t, w) != "no_plan" {
		t.Fatal("want no_plan")
	}

	// Coming back reuses the Stripe customer.
	h.checkout(cookie, "plus_monthly")
	reqs := f.Requests("POST", "/v1/checkout/sessions")
	if last := reqs[len(reqs)-1].Form; last.Get("customer") == "" || last.Get("customer_email") != "" {
		t.Fatalf("returning checkout = %v", last)
	}
}

// subID is the id of the newest stored subscription.
func subID(t *testing.T, h *harness) string {
	t.Helper()
	var id string
	if err := h.srv.Store.DB.QueryRow(`SELECT id FROM subscriptions ORDER BY created_at DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestRefundWithinThirtyDays(t *testing.T) {
	h := newHarness(t)
	f := h.stripe(true)
	old := h.signIn("old@example.test")
	h.deliver(f.Pay(h.checkout(old, "plus_yearly"))...)
	h.clock = h.clock.Add(20 * 24 * time.Hour)
	recent := h.signIn("recent@example.test")
	h.deliver(f.Pay(h.checkout(recent, "plus_yearly"))...)
	h.clock = h.clock.Add(11 * 24 * time.Hour) // old paid 31 days ago, recent 11 days ago
	old = h.signIn("old@example.test")         // sessions last 30 days

	if p := h.plan(old); p.Refundable {
		t.Fatalf("a 31-day-old charge must not be refundable: %+v", p)
	}
	w := h.do("POST", "/v1/billing/cancel", map[string]bool{"refund": true}, "Cookie", old, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusConflict)
	if errorCode(t, w) != "not_refundable" || len(f.Requests("POST", "/v1/refunds")) != 0 {
		t.Fatal("an old charge was refunded")
	}
	if p := h.plan(old); p.Status != "active" || p.CancelAtPeriodEnd {
		t.Fatalf("a refused refund changed the plan: %+v", p)
	}

	if p := h.plan(recent); !p.Refundable {
		t.Fatalf("an 11-day-old charge must be refundable: %+v", p)
	}
	token, _ := h.entitlement(recent)
	planAuth := []string{"Authorization", "Plan " + token}
	expect(t, h.do("GET", "/v1/sync", nil, planAuth...), http.StatusOK)
	h.mail.Reset()
	w = h.do("POST", "/v1/billing/cancel", map[string]bool{"refund": true}, "Cookie", recent, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusOK)
	refunds := f.Requests("POST", "/v1/refunds")
	if len(refunds) != 1 || !strings.HasPrefix(refunds[0].Form.Get("payment_intent"), "pi_") || refunds[0].Header.Get("Idempotency-Key") == "" {
		t.Fatalf("refund requests = %+v", refunds)
	}
	sub := subOf(t, h, "recent@example.test")
	if len(f.Requests("DELETE", "/v1/subscriptions/"+sub)) != 1 || len(f.Requests("POST", "/v1/subscriptions/"+sub)) != 0 {
		t.Fatal("a refund must end the subscription now")
	}
	if p := decodeBody[struct{ Account struct{ Plan *testPlan } }](t, w).Account.Plan; p.Status != "canceled" || p.Refundable {
		t.Fatalf("plan after refund = %+v", p)
	}
	if !strings.Contains(h.mail.String(), "We refunded your last Plus charge") {
		t.Fatalf("refund email = %q", h.mail.String())
	}
	// Stripe's charge.refunded for our own refund changes nothing further.
	h.deliver(f.Refunded(refunds[0].Form.Get("payment_intent")))
	if _, code := h.entitlement(recent); code != http.StatusNotFound {
		t.Fatal("a refunded plan must not issue tokens")
	}
	// The token issued before the refund still verifies, but sync stops at once.
	w = h.do("PUT", "/v1/sync", map[string]any{"version": 0, "data": map[string]any{"strictness": "strict"}}, planAuth...)
	expect(t, w, http.StatusForbidden)
	if errorCode(t, w) != "no_plan" {
		t.Fatal("want no_plan for a refunded plan's token")
	}
	expect(t, h.do("GET", "/v1/sync", nil, planAuth...), http.StatusForbidden)
}

func subOf(t *testing.T, h *harness, email string) string {
	t.Helper()
	var id string
	err := h.srv.Store.DB.QueryRow(`SELECT s.id FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE a.email = ?`, email).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestTrialTokensNeverRefreshIntoPaid(t *testing.T) {
	h := newHarness(t)
	trial := decodeBody[struct{ Token string }](t, h.do("POST", "/v1/trial", nil, installAuth(1)...)).Token
	w := h.do("POST", "/v1/entitlement/refresh", map[string]string{"token": trial})
	expect(t, w, http.StatusNotFound)
	expect(t, h.do("POST", "/v1/entitlement/refresh", map[string]string{"token": "not.a-token"}), http.StatusBadRequest)
}

func TestSupporters(t *testing.T) {
	h := newHarness(t)
	f := h.stripe(true)
	give := func(name string, recurring bool) []byte {
		t.Helper()
		w := h.do("POST", "/v1/billing/donate", map[string]any{"amount_cents": 1000, "recurring": recurring, "credit_name": name})
		expect(t, w, http.StatusOK)
		events := f.Pay(path.Base(decodeBody[struct{ URL string }](t, w).URL))
		h.deliver(events...)
		h.clock = h.clock.Add(time.Hour)
		return events[len(events)-1]
	}
	give("Ana", false)
	give("", false)
	give("Tomasz K.", true)
	refundMe := give("Refunded Person", false)
	give("Ana", false) // a second gift keeps Ana's first date

	// Refund the last one-time donation, as from the Stripe dashboard.
	var cs struct {
		Data struct {
			Object struct {
				PaymentIntent string `json:"payment_intent"`
			}
		}
	}
	if err := json.Unmarshal(refundMe, &cs); err != nil {
		t.Fatal(err)
	}
	h.deliver(f.Refunded(cs.Data.Object.PaymentIntent))

	w := h.do("GET", "/v1/supporters", nil)
	expect(t, w, http.StatusOK)
	got := decodeBody[struct {
		Supporters []struct{ Name, Since string }
	}](t, w).Supporters
	if len(got) != 2 || got[0].Name != "Tomasz K." || got[1].Name != "Ana" || got[1].Since != "2026-10-01T12:00:00Z" {
		t.Fatalf("supporters = %+v", got)
	}
	if strings.Contains(w.Body.String(), "1000") || strings.Contains(w.Body.String(), "amount") || strings.Contains(w.Body.String(), "@") {
		t.Fatalf("supporters leak amounts or emails: %s", w.Body.String())
	}
	// A monthly donation is a Stripe subscription, but never a Plus plan.
	var n int
	h.srv.Store.DB.QueryRow(`SELECT count(*) FROM subscriptions`).Scan(&n)
	if n != 0 {
		t.Fatal("a monthly donation was stored as a Plus subscription")
	}
}
