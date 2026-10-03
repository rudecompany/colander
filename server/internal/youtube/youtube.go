// Package youtube is a small YouTube Data API v3 client for source enrichment and appeal checks.
// Responses are cached in the store for 7 days to stay well inside the daily quota.
package youtube

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/rudecompany/colander/server/internal/store"
)

// Client calls the Data API with an API key.
type Client struct {
	Key      string
	BaseURL  string
	HTTP     *http.Client
	Store    *store.Store // response cache
	CacheTTL time.Duration
	// Window is how far back uploads are counted for uploads per day.
	Window time.Duration
}

// New returns a client for the public API.
func New(key string, st *store.Store) *Client {
	return &Client{Key: key, BaseURL: "https://www.googleapis.com/youtube/v3", HTTP: &http.Client{Timeout: 15 * time.Second},
		Store: st, CacheTTL: 7 * 24 * time.Hour, Window: 14 * 24 * time.Hour}
}

// ErrNotFound means the channel does not exist.
var ErrNotFound = errors.New("youtube channel not found")

// Channel is the part of a channel resource Colander uses.
type Channel struct {
	ID              string
	Handle          string // with @, lowercased
	Title           string
	Description     string
	Subscribers     int64
	HiddenCount     bool
	UploadsPlaylist string
}

// get fetches path with params, using the cache unless fresh is set.
func (c *Client) get(ctx context.Context, path string, params url.Values, fresh bool, out any) error {
	cacheKey := path + "?" + params.Encode()
	now := time.Now()
	if !fresh && c.Store != nil {
		body, ok, err := c.Store.CacheGet(ctx, cacheKey, now.Add(-c.CacheTTL).Unix())
		if err != nil {
			return err
		}
		if ok {
			return json.Unmarshal(body, out)
		}
	}
	q := url.Values{}
	for k, v := range params {
		q[k] = v
	}
	q.Set("key", c.Key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		// Never surface the URL: it carries the API key.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return fmt.Errorf("youtube %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("youtube %s: status %d", path, resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("youtube %s: %w", path, err)
	}
	if c.Store != nil {
		return c.Store.CachePut(ctx, cacheKey, body, now.Unix())
	}
	return nil
}

// Channel looks a channel up by channel ID (UC...) or handle (@name).
// fresh skips the cache, which appeal verification needs.
func (c *Client) Channel(ctx context.Context, alias string, fresh bool) (*Channel, error) {
	params := url.Values{"part": {"snippet,statistics,contentDetails"}}
	if strings.HasPrefix(alias, "@") {
		params.Set("forHandle", alias)
	} else {
		params.Set("id", alias)
	}
	var resp struct {
		Items []struct {
			ID      string `json:"id"`
			Snippet struct {
				Title       string `json:"title"`
				Description string `json:"description"`
				CustomURL   string `json:"customUrl"`
			} `json:"snippet"`
			Statistics struct {
				SubscriberCount       string `json:"subscriberCount"`
				HiddenSubscriberCount bool   `json:"hiddenSubscriberCount"`
			} `json:"statistics"`
			ContentDetails struct {
				RelatedPlaylists struct {
					Uploads string `json:"uploads"`
				} `json:"relatedPlaylists"`
			} `json:"contentDetails"`
		} `json:"items"`
	}
	if err := c.get(ctx, "/channels", params, fresh, &resp); err != nil {
		return nil, err
	}
	if len(resp.Items) == 0 {
		return nil, ErrNotFound
	}
	it := resp.Items[0]
	ch := &Channel{ID: it.ID, Title: it.Snippet.Title, Description: it.Snippet.Description,
		HiddenCount: it.Statistics.HiddenSubscriberCount, UploadsPlaylist: it.ContentDetails.RelatedPlaylists.Uploads}
	if h := strings.ToLower(it.Snippet.CustomURL); strings.HasPrefix(h, "@") {
		ch.Handle = h
	}
	ch.Subscribers, _ = strconv.ParseInt(it.Statistics.SubscriberCount, 10, 64)
	return ch, nil
}

// UploadsPerDay counts uploads in the window from the uploads playlist, newest first.
func (c *Client) UploadsPerDay(ctx context.Context, playlist string, now time.Time) (float64, error) {
	cutoff := now.Add(-c.Window)
	count, token := 0, ""
	// ponytail: at most 20 pages (1,000 uploads); enough to tell 10 a day from fewer.
	for page := 0; page < 20; page++ {
		params := url.Values{"part": {"contentDetails"}, "playlistId": {playlist}, "maxResults": {"50"}}
		if token != "" {
			params.Set("pageToken", token)
		}
		var resp struct {
			NextPageToken string `json:"nextPageToken"`
			Items         []struct {
				ContentDetails struct {
					VideoPublishedAt time.Time `json:"videoPublishedAt"`
				} `json:"contentDetails"`
			} `json:"items"`
		}
		if err := c.get(ctx, "/playlistItems", params, false, &resp); err != nil {
			return 0, err
		}
		older := false
		for _, it := range resp.Items {
			if it.ContentDetails.VideoPublishedAt.Before(cutoff) {
				older = true
				continue
			}
			count++
		}
		if older || resp.NextPageToken == "" {
			break
		}
		token = resp.NextPageToken
	}
	return float64(count) / (c.Window.Hours() / 24), nil
}

// DescriptionContains reports whether a channel's current description holds code.
func (c *Client) DescriptionContains(ctx context.Context, alias, code string) (bool, error) {
	ch, err := c.Channel(ctx, alias, true)
	if err != nil {
		return false, err
	}
	return strings.Contains(ch.Description, code), nil
}

// EnrichStale refreshes up to limit YouTube sources whose data is older than the cache TTL:
// both aliases, subscriber count and uploads per day. It stops at the first API error.
func (c *Client) EnrichStale(ctx context.Context, st *store.Store, now time.Time, limit int) error {
	stale, err := st.YouTubeStale(ctx, now.Add(-c.CacheTTL).Unix(), limit)
	if err != nil {
		return err
	}
	for _, src := range stale {
		ch, err := c.Channel(ctx, src.CanonicalID, false)
		if errors.Is(err, ErrNotFound) {
			if err := st.MarkYouTubeChecked(ctx, src.Ref, now.Unix()); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		info := store.YouTubeInfo{ChannelID: ch.ID, Handle: ch.Handle, Title: ch.Title}
		if !ch.HiddenCount {
			info.Subscribers = sql.NullInt64{Int64: ch.Subscribers, Valid: true}
		}
		if ch.UploadsPlaylist != "" {
			upd, err := c.UploadsPerDay(ctx, ch.UploadsPlaylist, now)
			if err != nil {
				return err
			}
			info.UploadsPerDay = sql.NullFloat64{Float64: upd, Valid: true}
		}
		if _, err := st.SetYouTube(ctx, src.Ref, info, now.Unix()); err != nil {
			return err
		}
	}
	return nil
}
