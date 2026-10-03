package youtube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rudecompany/colander/server/internal/store"
)

const channelID = "UCzzzzzzzzzzzzzzzzzzzzz7"

// fakeAPI serves one channel with 28 uploads in the last 14 days, spread over two pages.
func fakeAPI(t *testing.T, now time.Time, description *atomic.Pointer[string]) (*httptest.Server, *atomic.Int32) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		q := r.URL.Query()
		if q.Get("key") != "test-key" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/channels":
			if q.Get("forHandle") != "@ancientwonders" && q.Get("id") != channelID {
				fmt.Fprint(w, `{"items":[]}`)
				return
			}
			fmt.Fprintf(w, `{"items":[{"id":%q,"snippet":{"title":"Ancient Wonders Daily AI","description":%q,"customUrl":"@AncientWonders"},
				"statistics":{"subscriberCount":"150000","hiddenSubscriberCount":false},
				"contentDetails":{"relatedPlaylists":{"uploads":"UUzzz"}}}]}`, channelID, *description.Load())
		case "/playlistItems":
			var items []string
			start, next := 0, `,"nextPageToken":"p2"`
			if q.Get("pageToken") == "p2" {
				start, next = 20, ""
			}
			for i := start; i < start+20; i++ {
				// Two uploads a day going back; items 28 and later are older than 14 days.
				at := now.Add(-time.Duration(i)*12*time.Hour - 6*time.Hour)
				items = append(items, fmt.Sprintf(`{"contentDetails":{"videoId":"v%d","videoPublishedAt":%q}}`, i, at.Format(time.RFC3339)))
			}
			fmt.Fprintf(w, `{"items":[%s]%s}`, strings.Join(items, ","), next)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestEnrichAndVerify(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	var description atomic.Pointer[string]
	text := "History videos every hour."
	description.Store(&text)
	srv, calls := fakeAPI(t, now, &description)
	c := New("test-key", st)
	c.BaseURL = srv.URL

	// Two sources that are really one channel, tagged under each alias.
	byHandle, _ := st.EnsureSource(ctx, "yt", "@ancientwonders", "", now.Unix())
	byID, _ := st.EnsureSource(ctx, "yt", channelID, "", now.Unix())
	if err := c.EnrichStale(ctx, st, now, 10); err != nil {
		t.Fatal(err)
	}
	refs, _ := st.SourceRefs(ctx)
	if len(refs) != 1 || refs[0] != min(byHandle, byID) {
		t.Fatalf("sources after enrichment: %v", refs)
	}
	src, _ := st.GetSource(ctx, refs[0])
	if src.CanonicalID != channelID || len(src.Aliases) != 2 || src.Name != "Ancient Wonders Daily AI" ||
		src.Subscribers.Int64 != 150_000 || src.UploadsPerDay.Float64 != 2 {
		t.Fatalf("enriched source = %+v", src)
	}

	// Cached for a week: a second enrichment of a fresh source costs no calls.
	before := calls.Load()
	if _, err := c.Channel(ctx, channelID, false); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != before {
		t.Fatal("cached channel lookup hit the API")
	}

	// Appeal verification always reads the live description.
	ok, err := c.DescriptionContains(ctx, channelID, "colander-7KQ2M9XD")
	if err != nil || ok {
		t.Fatalf("code found before it was added: %v %v", ok, err)
	}
	withCode := text + " colander-7KQ2M9XD"
	description.Store(&withCode)
	if ok, err := c.DescriptionContains(ctx, channelID, "colander-7KQ2M9XD"); err != nil || !ok {
		t.Fatalf("code not found after it was added: %v %v", ok, err)
	}

	if _, err := c.Channel(ctx, "@nobody", true); err != ErrNotFound {
		t.Fatalf("unknown handle: %v", err)
	}
	c.Key = "wrong-key"
	if _, err := c.Channel(ctx, "@other", true); err == nil || strings.Contains(err.Error(), "wrong-key") {
		t.Fatalf("API error must not leak the key: %v", err)
	}
}
