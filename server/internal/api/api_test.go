package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/rudecompany/colander/server/internal/auth"
	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
)

type harness struct {
	t     *testing.T
	ctx   context.Context
	srv   *Server
	h     http.Handler
	clock time.Time
	mail  *bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "colander.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	key, err := sign.LoadKey("../../testdata/dev-signing.key")
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, ctx: ctx, clock: time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC), mail: &bytes.Buffer{}}
	now := func() time.Time { return h.clock }
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	pub := lf.NewPublisher(st, key, log)
	pub.Now = now
	eng := scoring.NewEngine(st, pub, nil, log)
	eng.Now = now
	a := auth.New(st, true)
	a.Now = now
	h.srv = New(&Server{Store: st, Engine: eng, Publisher: pub, Key: key, Auth: a, Mail: mail.New("", "", true, h.mail, log),
		PublicURL: "http://localhost:8787", SiteDir: t.TempDir(), Now: now, Log: log})
	h.h = h.srv.Handler()
	h.publish()
	return h
}

func (h *harness) publish() {
	h.t.Helper()
	if err := h.srv.Publisher.Publish(h.ctx); err != nil {
		h.t.Fatal(err)
	}
}

// do sends a request. headers alternate name, value.
func (h *harness) do(method, path string, body any, headers ...string) *httptest.ResponseRecorder {
	h.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			h.t.Fatal(err)
		}
		r = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, r)
	req.RemoteAddr = "192.0.2.1:1234"
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	h.h.ServeHTTP(w, req)
	return w
}

func decodeBody[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", w.Body.String(), err)
	}
	return v
}

func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeBody[struct {
		Error apiError `json:"error"`
	}](t, w).Error.Code
}

func sqlInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: true} }

func installID(n int) string {
	b := make([]byte, 16)
	b[0] = byte(n)
	return base64.RawURLEncoding.EncodeToString(b)
}

func installAuth(n int) []string { return []string{"Authorization", "Install " + installID(n)} }

var tokenInMail = regexp.MustCompile(`token=([A-Za-z0-9_-]+)`)

// signIn runs the dev-mode magic link flow for email and returns the session cookie header.
func (h *harness) signIn(email string) string {
	h.t.Helper()
	h.mail.Reset()
	expect(h.t, h.do("POST", "/v1/auth/email", map[string]string{"email": email, "next": "/review"}), http.StatusAccepted)
	m := tokenInMail.FindStringSubmatch(h.mail.String())
	if m == nil {
		h.t.Fatalf("no sign-in link in dev mail output: %q", h.mail.String())
	}
	w := h.do("POST", "/v1/auth/verify", map[string]string{"token": m[1]})
	expect(h.t, w, http.StatusOK)
	for _, c := range w.Result().Cookies() {
		if c.Name == auth.CookieName {
			return c.Name + "=" + c.Value
		}
	}
	h.t.Fatal("no session cookie")
	return ""
}

func (h *harness) reviewer(email, role, name string) string {
	h.t.Helper()
	a, err := h.srv.Store.GrantRole(h.ctx, email, role, h.clock.Unix())
	if err != nil {
		h.t.Fatal(err)
	}
	if err := h.srv.Store.SetDisplayName(h.ctx, a.ID, name); err != nil {
		h.t.Fatal(err)
	}
	return h.signIn(email)
}

// uuid turns a readable test name into a stable client UUID.
func uuid(name string) string {
	h := fmt.Sprintf("%x", sha256.Sum256([]byte(name)))
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func tag(clientID, targetType, target, source, verdict string) map[string]any {
	t := map[string]any{"client_id": uuid(clientID), "platform": "yt", "target_type": targetType, "target_id": target,
		"verdict": verdict, "platform_label": true, "created_at": "2026-10-01T11:00:00Z", "ext_version": "1.0.0"}
	if source != "" {
		t["source_id"] = source
	}
	return t
}

func TestTagValidation(t *testing.T) {
	h := newHarness(t)
	unknown := `{"tags":[{"client_id":"a","platform":"yt","target_type":"source","target_id":"@x","verdict":"slop","page_url":"https://example.com"}]}`
	w := h.do("POST", "/v1/tags", unknown, installAuth(1)...)
	expect(t, w, http.StatusBadRequest)
	if code := errorCode(t, w); code != "unknown_field" {
		t.Fatalf("code %q, want unknown_field", code)
	}
	expect(t, h.do("POST", "/v1/tags", map[string]any{"tags": []any{tag("a", "source", "@x", "", "slop")}}), http.StatusUnauthorized)

	notUUID := tag("x", "source", "@somechannel", "", "slop")
	notUUID["client_id"] = "not-a-uuid"
	typedNotSlop := tag("typed-not-slop", "source", "@somechannel", "", "not_slop")
	typedNotSlop["slop_type"] = "filler"
	testedAIFine := tag("tested-ai-fine", "item", "abcdefghijk", "@somechannel", "ai_fine")
	testedAIFine["tests"] = []string{"hollow"}
	emptyExtras := tag("empty-extras", "source", "@other", "", "not_slop")
	emptyExtras["slop_type"], emptyExtras["tests"] = "", []string{}
	w = h.do("POST", "/v1/tags", map[string]any{"tags": []any{
		tag("ok-1", "item", "abcdefghijk", "@somechannel", "slop"),
		tag("no-source", "item", "bcdefghijkl", "", "slop"), // the card did not show the source
		emptyExtras,
		tag("bad-target", "source", "not a handle", "", "slop"),
		tag("bad-verdict", "source", "@somechannel", "", "fake"),
		notUUID,
		typedNotSlop,
		testedAIFine,
		tag("source-with-source", "source", "@somechannel", "@somechannel", "slop"),
	}}, installAuth(1)...)
	expect(t, w, http.StatusOK)
	got := decodeBody[struct {
		Accepted []string    `json:"accepted"`
		Rejected []rejection `json:"rejected"`
	}](t, w)
	wantAccepted := []string{uuid("ok-1"), uuid("no-source"), uuid("empty-extras")}
	want := []rejection{{uuid("bad-target"), "invalid_target"}, {uuid("bad-verdict"), "invalid_verdict"}, {"not-a-uuid", "invalid_field"},
		{uuid("typed-not-slop"), "invalid_field"}, {uuid("tested-ai-fine"), "invalid_field"}, {uuid("source-with-source"), "invalid_field"}}
	if fmt.Sprint(got.Accepted) != fmt.Sprint(wantAccepted) || fmt.Sprint(got.Rejected) != fmt.Sprint(want) {
		t.Fatalf("accepted %v rejected %v", got.Accepted, got.Rejected)
	}
	// The item without a source is kept apart from every real source.
	it, err := h.srv.Store.FindItem(h.ctx, "yt", "bcdefghijkl")
	if err != nil {
		t.Fatal(err)
	}
	if src, _ := h.srv.Store.GetSource(h.ctx, it.SourceRef); src.CanonicalID != "" {
		t.Fatalf("unattributed item filed under %q", src.CanonicalID)
	}
}

func TestTagIdempotencyAndLatestWins(t *testing.T) {
	h := newHarness(t)
	send := func(clientID, verdict, at string) {
		tg := tag(clientID, "source", "@somechannel", "", verdict)
		tg["created_at"] = at
		expect(t, h.do("POST", "/v1/tags", map[string]any{"tags": []any{tg}}, installAuth(1)...), http.StatusOK)
	}
	votes := func() []store.Vote {
		ref, err := h.srv.Store.FindSource(h.ctx, "yt", "@somechannel")
		if err != nil {
			t.Fatal(err)
		}
		d, err := h.srv.Store.LoadSourceData(h.ctx, ref, h.clock.Unix())
		if err != nil {
			t.Fatal(err)
		}
		return d.Votes
	}
	send("c1", "slop", "2026-10-01T10:00:00Z")
	send("c1", "slop", "2026-10-01T10:00:00Z") // a retry
	send("c2", "not_slop", "2026-10-01T10:30:00Z")
	send("c0", "ai_fine", "2026-10-01T09:00:00Z") // older, delivered late: ignored
	v := votes()
	if len(v) != 1 || v[0].Verdict != "not_slop" {
		t.Fatalf("votes = %+v, want one not_slop", v)
	}
}

func TestTagRateLimit(t *testing.T) {
	h := newHarness(t)
	batch := func(prefix string) map[string]any {
		var tags []any
		for i := range 40 {
			tags = append(tags, tag(fmt.Sprintf("%s-%d", prefix, i), "source", fmt.Sprintf("@channel%d", i), "", "slop"))
		}
		return map[string]any{"tags": tags}
	}
	expect(t, h.do("POST", "/v1/tags", batch("a"), installAuth(1)...), http.StatusOK)
	w := h.do("POST", "/v1/tags", batch("b"), installAuth(1)...)
	expect(t, w, http.StatusTooManyRequests)
	if ra := w.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q", ra)
	}
	// Another install is not affected, and the first recovers as time passes.
	expect(t, h.do("POST", "/v1/tags", batch("c"), installAuth(2)...), http.StatusOK)
	h.clock = h.clock.Add(time.Minute)
	expect(t, h.do("POST", "/v1/tags", batch("d"), installAuth(1)...), http.StatusOK)
}

func TestReportLifecycle(t *testing.T) {
	h := newHarness(t)
	report := map[string]any{"client_id": "r-1", "platform": "yt", "source_id": "@AncientWondersDaily", "source_name": "Ancient Wonders Daily AI",
		"examples": []string{"abcdefghijk"}, "reason": "Posts 40 AI history videos a day with the same voice.", "slop_type": "filler",
		"tests": []string{"mass_produced"}, "ext_version": "1.0.0"}
	w := h.do("POST", "/v1/reports", report, installAuth(1)...)
	expect(t, w, http.StatusCreated)
	created := decodeBody[struct{ Report reportJSON }](t, w).Report
	if created.Status != "under_review" || created.Verdict != nil || created.SourceID != "@ancientwondersdaily" {
		t.Fatalf("created report = %+v", created)
	}
	// The same client_id again is the same report.
	w = h.do("POST", "/v1/reports", report, installAuth(1)...)
	if decodeBody[struct{ Report reportJSON }](t, w).Report.ID != created.ID {
		t.Fatal("report retry created a second report")
	}
	// 48 list syncs in the last 24 hours means 2 active installs.
	for range 48 {
		expect(t, h.do("GET", "/v1/list/snapshot", nil), http.StatusOK)
	}

	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	decision := map[string]any{"verdict": "slop", "reason": "Staff review confirmed mass-produced narration.",
		"signals": []string{"high_volume", "community_consensus", "watermark"}, "slop_type": "filler", "tests": []string{"mass_produced", "low_effort"}}
	expect(t, h.do("POST", "/v1/review/sources/yt/@ancientwondersdaily/decision", decision, "Cookie", staff, "X-Colander-CSRF", "1"), http.StatusOK)

	w = h.do("GET", "/v1/reports", nil, installAuth(1)...)
	expect(t, w, http.StatusOK)
	list := decodeBody[struct{ Reports []reportJSON }](t, w).Reports
	if len(list) != 1 || list[0].Status != "slop" || list[0].Verdict == nil || *list[0].Verdict != "slop" || list[0].Protects != 2 {
		t.Fatalf("reports after decision = %+v", list)
	}
	// Another install sees none of them.
	w = h.do("GET", "/v1/reports", nil, installAuth(2)...)
	if n := len(decodeBody[struct{ Reports []reportJSON }](t, w).Reports); n != 0 {
		t.Fatalf("another install sees %d reports", n)
	}
	// The decision is public, with the reviewer's reason and name.
	w = h.do("GET", "/v1/sources/yt/@ancientwondersdaily", nil)
	expect(t, w, http.StatusOK)
	src := decodeBody[struct {
		Source  sourceJSON
		History []logJSON
	}](t, w)
	if src.Source.Verdict == nil || *src.Source.Verdict != "slop" || len(src.History) != 1 || src.History[0].Actor != "staff" ||
		src.History[0].ActorName == nil || *src.History[0].ActorName != "Rae" {
		t.Fatalf("source page = %+v", src)
	}
	if !strings.Contains(strings.Join(src.Source.Signals, ","), "staff_review") ||
		strings.Contains(strings.Join(src.Source.Signals, ","), "community_consensus") {
		t.Fatalf("signals = %v: staff_review expected, hand-set community_consensus must be ignored", src.Source.Signals)
	}
}

// listEntries decodes a delta and returns its entries by hash.
func listEntries(t *testing.T, h *harness, body []byte) map[[8]byte]lf.Entry {
	t.Helper()
	l, err := lf.Decode(body, h.srv.Key.Public)
	if err != nil {
		t.Fatal(err)
	}
	out := map[[8]byte]lf.Entry{}
	for _, e := range l.Entries {
		out[e.Hash] = e
	}
	return out
}

func TestAppealFlow(t *testing.T) {
	h := newHarness(t)
	st := h.srv.Store
	const channel = "UCzzzzzzzzzzzzzzzzzzzz42"
	ref, err := st.EnsureSource(h.ctx, "yt", "@oceanmysteries", "Ocean Mysteries", h.clock.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetYouTube(h.ctx, ref, store.YouTubeInfo{ChannelID: channel, Handle: "@oceanmysteries"}, h.clock.Unix()); err != nil {
		t.Fatal(err)
	}
	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	csrf := []string{"Cookie", staff, "X-Colander-CSRF", "1"}
	expect(t, h.do("POST", "/v1/review/sources/yt/@oceanmysteries/decision",
		map[string]any{"verdict": "slop", "reason": "Generated narration over stock clips.", "signals": []string{"templated", "watermark"}}, csrf...), http.StatusOK)
	h.publish()
	_, seq := h.srv.Publisher.Snapshot()

	// The creator appeals; the secret comes back once and by email.
	w := h.do("POST", "/v1/appeals", map[string]string{"platform": "yt", "source_id": channel, "email": "studio@example.test",
		"statement": "We film our own dives."})
	expect(t, w, http.StatusCreated)
	created := decodeBody[struct {
		Appeal appealJSON
		Secret string
	}](t, w)
	if created.Appeal.Status != "awaiting_verification" || !strings.HasPrefix(created.Appeal.Code, "colander-") ||
		!strings.Contains(h.mail.String(), created.Appeal.Code) {
		t.Fatalf("appeal = %+v", created.Appeal)
	}
	expect(t, h.do("GET", "/v1/appeals/"+created.Appeal.ID+"?secret=wrong", nil), http.StatusNotFound)
	// Without a YouTube key, the creator's verify request moves the appeal to staff.
	w = h.do("POST", "/v1/appeals/"+created.Appeal.ID+"/verify", map[string]string{"secret": created.Secret})
	expect(t, w, http.StatusOK)
	if s := decodeBody[struct{ Appeal appealJSON }](t, w).Appeal.Status; s != "pending_manual" {
		t.Fatalf("status after creator verify = %s", s)
	}

	// Staff confirm the code: Disputed at once, and the next delta carries it for every alias.
	expect(t, h.do("POST", "/v1/review/appeals/"+created.Appeal.ID+"/verify", nil, csrf...), http.StatusOK)
	h.publish()
	w = h.do("GET", fmt.Sprintf("/v1/list/delta?since=%d", seq.Seq), nil)
	expect(t, w, http.StatusOK)
	entries := listEntries(t, h, w.Body.Bytes())
	for _, alias := range []string{channel, "@oceanmysteries"} {
		e, ok := entries[lf.Hash(lf.TargetKey("yt", "source", alias))]
		if !ok || e.Verdict != lf.VerdictCode("disputed") || e.Signals&lf.SigOpenAppeal == 0 {
			t.Fatalf("delta entry for %s = %+v (present %v)", alias, e, ok)
		}
	}

	// Staff uphold it: Clear, with the reasoning in the public log.
	reason := "The creator films original dive footage."
	w = h.do("POST", "/v1/review/appeals/"+created.Appeal.ID+"/resolve", map[string]string{"outcome": "upheld", "reasoning": reason}, csrf...)
	expect(t, w, http.StatusOK)
	if a := decodeBody[struct{ Appeal appealJSON }](t, w).Appeal; a.Status != "upheld" || a.ResolvedAt == nil {
		t.Fatalf("resolved appeal = %+v", a)
	}
	w = h.do("GET", "/v1/log?limit=1", nil)
	entry := decodeBody[struct{ Entries []logJSON }](t, w).Entries[0]
	if entry.To == nil || *entry.To != "clear" || entry.From == nil || *entry.From != "disputed" || entry.Actor != "appeal" ||
		!strings.Contains(entry.Reason, reason) {
		t.Fatalf("log entry = %+v", entry)
	}
	h.publish()
	_, seq2 := h.srv.Publisher.Snapshot()
	w = h.do("GET", fmt.Sprintf("/v1/list/delta?since=%d", seq.Seq), nil)
	if e := listEntries(t, h, w.Body.Bytes())[lf.Hash("yt:s:@oceanmysteries")]; e.Verdict != lf.VerdictCode("clear") {
		t.Fatalf("coalesced delta entry = %+v, want clear", e)
	}
	if seq2.Seq <= seq.Seq {
		t.Fatal("no new sequence after the appeal")
	}
}

func TestDeltaStatuses(t *testing.T) {
	h := newHarness(t)
	_, seq := h.srv.Publisher.Snapshot()
	w := h.do("GET", fmt.Sprintf("/v1/list/delta?since=%d", seq.Seq), nil)
	expect(t, w, http.StatusNoContent)

	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	expect(t, h.do("POST", "/v1/review/sources/tt/@petpalsai/decision",
		map[string]any{"verdict": "slop", "reason": "Generated pet clips around the clock.", "signals": []string{"creator_statement"}},
		"Cookie", staff, "X-Colander-CSRF", "1"), http.StatusOK)
	h.publish()

	w = h.do("GET", fmt.Sprintf("/v1/list/delta?since=%d", seq.Seq), nil)
	expect(t, w, http.StatusOK)
	l, err := lf.Decode(w.Body.Bytes(), h.srv.Key.Public)
	if err != nil || l.Kind != lf.KindDelta || l.Base != uint64(seq.Seq) || len(l.Entries) != 1 ||
		w.Header().Get("X-Colander-Sequence") != fmt.Sprint(l.Sequence) {
		t.Fatalf("delta = %+v (err %v)", l, err)
	}
	expect(t, h.do("GET", "/v1/list/delta?since=999", nil), http.StatusGone)
	expect(t, h.do("GET", "/v1/list/delta?since=0", nil), http.StatusGone)
	// Sequences older than 30 days are gone too.
	h.clock = h.clock.Add(31 * 24 * time.Hour)
	expect(t, h.do("GET", fmt.Sprintf("/v1/list/delta?since=%d", seq.Seq), nil), http.StatusGone)

	w = h.do("GET", "/v1/list/snapshot", nil)
	expect(t, w, http.StatusOK)
	snap, err := lf.Decode(w.Body.Bytes(), h.srv.Key.Public)
	if err != nil || snap.Kind != lf.KindSnapshot || len(snap.Entries) != 1 || w.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("snapshot = %+v (err %v)", snap, err)
	}
}

func TestMagicLinkSignIn(t *testing.T) {
	h := newHarness(t)
	expect(t, h.do("GET", "/v1/account", nil), http.StatusUnauthorized)
	h.mail.Reset()
	expect(t, h.do("POST", "/v1/auth/email", map[string]string{"email": "Maya@Example.test", "next": "https://evil.example/"}), http.StatusAccepted)
	out := h.mail.String()
	m := tokenInMail.FindStringSubmatch(out)
	if m == nil || !strings.Contains(out, "http://localhost:8787/auth/callback?token=") || !strings.Contains(out, "next=%2Faccount") {
		t.Fatalf("dev mail = %q", out)
	}
	w := h.do("POST", "/v1/auth/verify", map[string]string{"token": m[1]})
	expect(t, w, http.StatusOK)
	var cookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == auth.CookieName {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure {
		t.Fatalf("session cookie = %+v", cookie)
	}
	w = h.do("GET", "/v1/account", nil, "Cookie", cookie.Name+"="+cookie.Value)
	expect(t, w, http.StatusOK)
	acct := decodeBody[struct{ Account map[string]any }](t, w).Account
	if acct["email"] != "maya@example.test" || acct["role"] != "member" || acct["plan"] != nil {
		t.Fatalf("account = %v", acct)
	}
	// Links work once.
	expect(t, h.do("POST", "/v1/auth/verify", map[string]string{"token": m[1]}), http.StatusBadRequest)
	// And expire after 20 minutes.
	h.mail.Reset()
	h.do("POST", "/v1/auth/email", map[string]string{"email": "maya@example.test"})
	late := tokenInMail.FindStringSubmatch(h.mail.String())[1]
	h.clock = h.clock.Add(21 * time.Minute)
	expect(t, h.do("POST", "/v1/auth/verify", map[string]string{"token": late}), http.StatusBadRequest)
}

func TestCSRFRequired(t *testing.T) {
	h := newHarness(t)
	cookie := h.signIn("sam@colander.test")
	w := h.do("PATCH", "/v1/account", map[string]string{"display_name": "Sam"}, "Cookie", cookie)
	expect(t, w, http.StatusForbidden)
	if errorCode(t, w) != "csrf_required" {
		t.Fatal("want csrf_required")
	}
	expect(t, h.do("POST", "/v1/auth/logout", nil, "Cookie", cookie), http.StatusForbidden)
	expect(t, h.do("PATCH", "/v1/account", map[string]string{"display_name": "Sam"}, "Cookie", cookie, "X-Colander-CSRF", "1"), http.StatusOK)
	expect(t, h.do("POST", "/v1/auth/logout", nil, "Cookie", cookie, "X-Colander-CSRF", "1"), http.StatusNoContent)
	expect(t, h.do("GET", "/v1/account", nil, "Cookie", cookie), http.StatusUnauthorized)
}

func TestCuratorLimitsAndReviewerToken(t *testing.T) {
	h := newHarness(t)
	st := h.srv.Store
	ref, err := st.EnsureSource(h.ctx, "yt", "@gossipnarrated", "Celebrity Gossip Narrated", h.clock.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetYouTube(h.ctx, ref, store.YouTubeInfo{ChannelID: "UCzzzzzzzzzzzzzzzzzzzz43", Handle: "@gossipnarrated",
		Subscribers: sqlInt(1_200_000)}, h.clock.Unix()); err != nil {
		t.Fatal(err)
	}
	member := h.signIn("maya@example.test")
	expect(t, h.do("POST", "/v1/account/reviewer-token", nil, "Cookie", member, "X-Colander-CSRF", "1"), http.StatusForbidden)

	curator := h.reviewer("sam@colander.test", "curator", "Sam")
	w := h.do("POST", "/v1/account/reviewer-token", nil, "Cookie", curator, "X-Colander-CSRF", "1")
	expect(t, w, http.StatusOK)
	token := decodeBody[struct{ Token string }](t, w).Token
	bearer := []string{"Authorization", "Bearer " + token}

	expect(t, h.do("GET", "/v1/review/queue", nil, bearer...), http.StatusOK)
	expect(t, h.do("GET", "/v1/review/queue", nil, "Authorization", "Bearer nope"), http.StatusUnauthorized)
	expect(t, h.do("GET", "/v1/review/queue", nil, "Cookie", member), http.StatusForbidden)

	decision := map[string]any{"verdict": "slop", "reason": "Generated gossip narration.", "signals": []string{"watermark"}}
	w = h.do("POST", "/v1/review/sources/yt/@gossipnarrated/decision", decision, bearer...)
	expect(t, w, http.StatusForbidden)
	if errorCode(t, w) != "staff_required" {
		t.Fatal("want staff_required for a large source")
	}
	// Slop needs AI evidence: without a provenance signal or met provenance layer it is refused.
	for _, v := range []string{"slop", "likely_slop"} {
		w = h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", map[string]any{"verdict": v, "reason": "Looks generated."}, bearer...)
		expect(t, w, http.StatusBadRequest)
		if errorCode(t, w) != "ai_evidence_required" {
			t.Fatalf("%s: want ai_evidence_required", v)
		}
	}
	w = h.do("POST", "/v1/review/items/yt/abcdefghijk/decision", map[string]any{"verdict": "slop", "reason": "Looks generated.",
		"source_id": "@smallslopfarm"}, bearer...)
	expect(t, w, http.StatusBadRequest)
	// Curators may decide sources that are not large, by bearer token without CSRF.
	expect(t, h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", decision, bearer...), http.StatusOK)
	expect(t, h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", map[string]any{"verdict": "slop", "reason": "x", "large": true},
		bearer...), http.StatusForbidden)

	w = h.do("POST", "/v1/appeals", map[string]string{"platform": "yt", "source_id": "@smallslopfarm", "email": "a@example.test", "statement": "Not slop."})
	expect(t, w, http.StatusCreated)
	id := decodeBody[struct{ Appeal appealJSON }](t, w).Appeal.ID
	w = h.do("POST", "/v1/review/appeals/"+id+"/verify", nil, bearer...)
	expect(t, w, http.StatusForbidden)
	if errorCode(t, w) != "staff_required" {
		t.Fatal("want staff_required for appeals")
	}
	expect(t, h.do("POST", "/v1/review/appeals/"+id+"/resolve", map[string]string{"outcome": "denied", "reasoning": "x"}, bearer...), http.StatusForbidden)

	// An appeal awaiting verification is unproven, so curators may still decide. Once the creator has
	// done their part (pending_manual, then under_review) only staff decide the source.
	clear := map[string]any{"verdict": "clear", "reason": "Original work."}
	expect(t, h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", decision, bearer...), http.StatusOK)
	w = h.do("POST", "/v1/appeals", map[string]string{"platform": "yt", "source_id": "@smallslopfarm", "email": "a@example.test", "statement": "Not slop."})
	appeal := decodeBody[struct {
		Appeal appealJSON
		Secret string
	}](t, w)
	expect(t, h.do("POST", "/v1/appeals/"+appeal.Appeal.ID+"/verify", map[string]string{"secret": appeal.Secret}), http.StatusOK)
	w = h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", clear, bearer...)
	expect(t, w, http.StatusForbidden)
	if errorCode(t, w) != "staff_required" {
		t.Fatal("want staff_required for a source with a pending_manual appeal")
	}
	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	expect(t, h.do("POST", "/v1/review/appeals/"+appeal.Appeal.ID+"/verify", nil, "Cookie", staff, "X-Colander-CSRF", "1"), http.StatusOK)
	w = h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", clear, bearer...)
	expect(t, w, http.StatusForbidden)
	expect(t, h.do("POST", "/v1/review/sources/yt/@smallslopfarm/decision", clear, "Cookie", staff, "X-Colander-CSRF", "1"), http.StatusOK)
}

// A report follows its source: once the list verdict changes after it was filed, it shows that verdict.
func TestReportFollowsCommunityVerdict(t *testing.T) {
	h := newHarness(t)
	w := h.do("POST", "/v1/reports", map[string]any{"client_id": uuid("r-1"), "platform": "yt", "source_id": "@farm",
		"reason": "Generated narration.", "ext_version": "1.0.0"}, installAuth(1)...)
	expect(t, w, http.StatusCreated)
	for range 24 {
		expect(t, h.do("GET", "/v1/list/snapshot", nil), http.StatusOK)
	}
	var tags []any
	for i := range 3 {
		tg := tag(fmt.Sprintf("ai-%d", i), "source", "@farm", "", "ai_fine")
		expect(t, h.do("POST", "/v1/tags", map[string]any{"tags": []any{tg}}, installAuth(10+i)...), http.StatusOK)
		tags = append(tags, tg)
	}
	if _, err := h.srv.Engine.FullPass(h.ctx); err != nil {
		t.Fatal(err)
	}
	w = h.do("GET", "/v1/reports", nil, installAuth(1)...)
	expect(t, w, http.StatusOK)
	list := decodeBody[struct{ Reports []reportJSON }](t, w).Reports
	if len(list) != 1 || list[0].Status != "ai_made" || list[0].Verdict == nil || *list[0].Verdict != "ai_made" || list[0].Protects != 1 {
		t.Fatalf("report after the community verdict = %+v", list)
	}
}

// An appeal staff must check by hand stays in the queue and, once it has waited 14 days, is also
// escalated at the top priority.
func TestPendingManualAppealInQueue(t *testing.T) {
	h := newHarness(t)
	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	csrf := []string{"Cookie", staff, "X-Colander-CSRF", "1"}
	expect(t, h.do("POST", "/v1/review/sources/yt/@farm/decision", map[string]any{"verdict": "ai_made", "reason": "Labelled AI.",
		"signals": []string{"platform_label"}}, csrf...), http.StatusOK)
	w := h.do("POST", "/v1/appeals", map[string]string{"platform": "yt", "source_id": "@farm", "email": "a@example.test", "statement": "Mine."})
	appeal := decodeBody[struct {
		Appeal appealJSON
		Secret string
	}](t, w)
	expect(t, h.do("POST", "/v1/appeals/"+appeal.Appeal.ID+"/verify", map[string]string{"secret": appeal.Secret}), http.StatusOK)
	h.clock = h.clock.Add(15 * 24 * time.Hour)
	if _, err := h.srv.Engine.FullPass(h.ctx); err != nil {
		t.Fatal(err)
	}
	w = h.do("GET", "/v1/review/queue", nil, csrf...)
	expect(t, w, http.StatusOK)
	items := decodeBody[struct{ Items []queueJSON }](t, w).Items
	var kinds []string
	for _, q := range items {
		if q.Priority != 1 {
			t.Errorf("%s %q has priority %d, want 1", q.Kind, q.Summary, q.Priority)
		}
		kinds = append(kinds, q.Kind)
	}
	if fmt.Sprint(kinds) != "[appeal escalation]" || !strings.Contains(items[1].Summary, "waits for staff to check its code") {
		t.Fatalf("queue = %+v", items)
	}
}

// A source held at Likely slop by the rule 6 cap shows in the queue with the list verdict and what
// scoring says without the cap, so reviewers see the Slop hint.
func TestCappedEscalationShowsScoredSlop(t *testing.T) {
	h := newHarness(t)
	for i := range 6 {
		tg := tag(fmt.Sprintf("slop-%d", i), "source", "@farm", "", "slop")
		tg["tests"] = []string{"low_effort", "mass_produced"}
		expect(t, h.do("POST", "/v1/tags", map[string]any{"tags": []any{tg}}, installAuth(20+i)...), http.StatusOK)
	}
	ref, err := h.srv.Store.FindSource(h.ctx, "yt", "@farm")
	if err != nil {
		t.Fatal(err)
	}
	// Twenty uploads a day, but the channel hides its subscriber count.
	if _, err := h.srv.Store.SetYouTube(h.ctx, ref, store.YouTubeInfo{ChannelID: "UCzzzzzzzzzzzzzzzzzzzz44", Handle: "@farm",
		UploadsPerDay: sql.NullFloat64{Float64: 20, Valid: true}}, h.clock.Unix()); err != nil {
		t.Fatal(err)
	}
	h.clock = h.clock.Add(40 * 24 * time.Hour)
	if _, err := h.srv.Engine.FullPass(h.ctx); err != nil {
		t.Fatal(err)
	}
	staff := h.reviewer("rae@colander.test", "staff", "Rae")
	w := h.do("GET", "/v1/review/queue?kind=escalations", nil, "Cookie", staff)
	expect(t, w, http.StatusOK)
	items := decodeBody[struct{ Items []queueJSON }](t, w).Items
	if len(items) != 1 || items[0].Verdict == nil || *items[0].Verdict != "likely_slop" || items[0].ComputedVerdict == nil ||
		*items[0].ComputedVerdict != "slop" || !strings.Contains(items[0].Summary, "audience size unknown") {
		t.Fatalf("queue = %+v", items)
	}
}

func TestCORS(t *testing.T) {
	h := newHarness(t)
	w := h.do("OPTIONS", "/v1/tags", nil, "Origin", "chrome-extension://abc", "Access-Control-Request-Method", "POST")
	expect(t, w, http.StatusNoContent)
	if w.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight headers = %v", w.Header())
	}
	for _, path := range []string{"/v1/list/snapshot", "/v1/sources/yt/@nobody", "/v1/config/adapters", "/v1/review/queue"} {
		w := h.do("GET", path, nil, "Origin", "chrome-extension://abc")
		if w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("%s: CORS headers %v", path, w.Header())
		}
	}
	for _, path := range []string{"/v1/account", "/v1/log", "/v1/stats", "/v1/auth/email"} {
		if got := h.do("GET", path, nil, "Origin", "https://evil.example").Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s answers cross-origin: %q", path, got)
		}
	}
	if h.do("GET", "/healthz", nil).Header().Get("X-Frame-Options") != "DENY" {
		t.Error("security headers missing")
	}
}

func TestTrialOncePerInstall(t *testing.T) {
	h := newHarness(t)
	w := h.do("POST", "/v1/trial", nil, installAuth(1)...)
	expect(t, w, http.StatusOK)
	token := decodeBody[struct{ Token string }](t, w).Token
	c, err := sign.VerifyPlanToken(h.srv.Key.Public, token, h.clock)
	if err != nil || !c.Trial || c.Plan != "plus" || c.EXP-c.IAT != 14*24*3600 {
		t.Fatalf("trial token %+v (err %v)", c, err)
	}
	w = h.do("POST", "/v1/trial", nil, installAuth(1)...)
	expect(t, w, http.StatusConflict)
	if errorCode(t, w) != "trial_used" {
		t.Fatal("want trial_used")
	}
}

func TestSyncVersions(t *testing.T) {
	h := newHarness(t)
	token := decodeBody[struct{ Token string }](t, h.do("POST", "/v1/trial", nil, installAuth(1)...)).Token
	plan := []string{"Authorization", "Plan " + token}
	expect(t, h.do("GET", "/v1/sync", nil), http.StatusUnauthorized)

	w := h.do("GET", "/v1/sync", nil, plan...)
	expect(t, w, http.StatusOK)
	if v := decodeBody[map[string]any](t, w); v["version"] != 0.0 || v["data"] != nil {
		t.Fatalf("empty sync = %v", v)
	}
	w = h.do("PUT", "/v1/sync", map[string]any{"version": 0, "data": map[string]any{"strictness": "strict"}}, plan...)
	expect(t, w, http.StatusOK)
	w = h.do("PUT", "/v1/sync", map[string]any{"version": 0, "data": map[string]any{"strictness": "label"}}, plan...)
	expect(t, w, http.StatusConflict)
	conflict := decodeBody[struct {
		Error   apiError
		Version int
		Data    map[string]string
	}](t, w)
	if conflict.Error.Code != "version_conflict" || conflict.Version != 1 || conflict.Data["strictness"] != "strict" {
		t.Fatalf("conflict body = %+v", conflict)
	}
	big := map[string]any{"version": 1, "data": map[string]string{"x": strings.Repeat("a", 70_000)}}
	expect(t, h.do("PUT", "/v1/sync", big, plan...), http.StatusRequestEntityTooLarge)
	expect(t, h.do("PUT", "/v1/sync", map[string]any{"version": 1, "data": []int{1}}, plan...), http.StatusBadRequest)

	h.clock = h.clock.Add(15 * 24 * time.Hour)
	expect(t, h.do("GET", "/v1/sync", nil, plan...), http.StatusUnauthorized)
}

func TestSite(t *testing.T) {
	h := newHarness(t)
	expect(t, h.do("GET", "/about", nil), http.StatusNotFound) // no build yet
	dir := h.srv.SiteDir
	os.MkdirAll(filepath.Join(dir, "_app/immutable"), 0o755)
	os.WriteFile(filepath.Join(dir, "200.html"), []byte("<!doctype html>app"), 0o644)
	os.WriteFile(filepath.Join(dir, "about.html"), []byte("<!doctype html>about"), 0o644)
	os.WriteFile(filepath.Join(dir, "_app/immutable/start.js"), []byte("export {}"), 0o644)

	if w := h.do("GET", "/about", nil); w.Body.String() != "<!doctype html>about" {
		t.Fatalf("/about = %d %q", w.Code, w.Body.String())
	}
	for _, p := range []string{"/s/yt/@x", "/appeal/tt/@y", "/appeal/status/apl_1"} {
		if w := h.do("GET", p, nil); w.Code != 200 || w.Body.String() != "<!doctype html>app" {
			t.Fatalf("SPA fallback for %s = %d %q", p, w.Code, w.Body.String())
		}
	}
	// Anything else is a real 404, not a soft one: with the shell, then with the site's 404 page.
	if w := h.do("GET", "/no-such-page", nil); w.Code != 404 || w.Body.String() != "<!doctype html>app" {
		t.Fatalf("unknown page without 404.html = %d %q", w.Code, w.Body.String())
	}
	os.WriteFile(filepath.Join(dir, "404.html"), []byte("<!doctype html>missing"), 0o644)
	for _, p := range []string{"/no-such-page", "/s/xx/@x", "/s/yt", "/appeal/yt/@x/extra"} {
		if w := h.do("GET", p, nil); w.Code != 404 || w.Body.String() != "<!doctype html>missing" {
			t.Fatalf("%s = %d %q", p, w.Code, w.Body.String())
		}
	}
	if w := h.do("GET", "/_app/immutable/start.js", nil); !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("immutable cache = %q", w.Header().Get("Cache-Control"))
	}
	if w := h.do("GET", "/v1/nothing", nil); w.Code != 404 || errorCode(t, w) != "not_found" {
		t.Fatalf("unknown API route = %d %s", w.Code, w.Body.String())
	}
	if w := h.do("GET", "/../../etc/passwd", nil); strings.Contains(w.Body.String(), "root:") {
		t.Fatal("path traversal")
	}
}

func TestClientIPHeader(t *testing.T) {
	cases := []struct {
		header, values, want string
	}{
		{"", "", "192.0.2.1"},
		{"CF-Connecting-IP", "203.0.113.7", "203.0.113.7"},
		{"CF-Connecting-IP", "", "192.0.2.1"},
		{"CF-Connecting-IP", "nonsense", "192.0.2.1"},
		// The client can write anything on the left; the right-most public hop is the one our proxy saw.
		{"X-Forwarded-For", "1.1.1.1, 203.0.113.7", "203.0.113.7"},
		{"X-Forwarded-For", "1.1.1.1, 203.0.113.7, 10.0.0.2, 127.0.0.1", "203.0.113.7"},
		{"X-Forwarded-For", "spoofed, 203.0.113.7:4711", "203.0.113.7"},
		{"X-Forwarded-For", "2001:db8::1, ::ffff:10.1.2.3", "2001:db8::1"},
		// All hops are our own network: the outermost one a trusted proxy reported.
		{"X-Forwarded-For", "garbage, 10.0.0.9, 10.0.0.2", "10.0.0.9"},
		{"X-Forwarded-For", "10.0.0.9", "10.0.0.9"},
	}
	for _, c := range cases {
		s := &Server{ClientIPHeader: c.header}
		r, _ := http.NewRequest("POST", "/v1/appeals", nil)
		r.RemoteAddr = "192.0.2.1:1234"
		if c.values != "" {
			r.Header.Set("X-Forwarded-For", c.values)
			r.Header.Set("CF-Connecting-IP", c.values)
		}
		if got := s.clientIP(r); got != c.want {
			t.Errorf("%s: %q gives %q, want %q", c.header, c.values, got, c.want)
		}
	}
	// Two X-Forwarded-For lines are one list.
	r, _ := http.NewRequest("POST", "/", nil)
	r.RemoteAddr = "10.0.0.2:80"
	r.Header.Add("X-Forwarded-For", "203.0.113.7")
	r.Header.Add("X-Forwarded-For", "10.0.0.5")
	if got := (&Server{ClientIPHeader: "X-Forwarded-For"}).clientIP(r); got != "203.0.113.7" {
		t.Fatalf("two lines: %q", got)
	}
}
