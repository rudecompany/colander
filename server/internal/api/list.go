package api

import (
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/rudecompany/colander/server/internal/store"
)

// hitCounter counts list requests per UTC hour in memory, with no identifier at all (contracts 9.6).
type hitCounter struct {
	mu     sync.Mutex
	counts map[int64]int64
}

func (c *hitCounter) add(now time.Time) {
	c.mu.Lock()
	if c.counts == nil {
		c.counts = map[int64]int64{}
	}
	c.counts[now.Unix()/3600]++
	c.mu.Unlock()
}

func (c *hitCounter) flush(ctx context.Context, st *store.Store) error {
	c.mu.Lock()
	counts := c.counts
	c.counts = nil
	c.mu.Unlock()
	for hour, n := range counts {
		if err := st.AddListRequests(ctx, hour, n); err != nil {
			// Put unflushed counts back so they are not lost.
			c.mu.Lock()
			if c.counts == nil {
				c.counts = map[int64]int64{}
			}
			c.counts[hour] += n
			c.mu.Unlock()
			return err
		}
	}
	return nil
}

// activeInstalls estimates active installs as list requests in the last 24 hours / 24.
func (s *Server) activeInstalls(ctx context.Context) (int64, error) {
	if err := s.listHit.flush(ctx, s.Store); err != nil {
		return 0, err
	}
	hour := s.Now().Unix() / 3600
	n, err := s.Store.ListRequestsSince(ctx, hour-23)
	return (n + 12) / 24, err
}

func (s *Server) listSnapshot(w http.ResponseWriter, r *http.Request) {
	s.listHit.add(s.Now())
	snap, seq := s.Publisher.Snapshot()
	if snap == nil {
		writeError(w, http.StatusServiceUnavailable, "list_unavailable", "The list has not been published yet. Try again shortly.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Colander-Sequence", strconv.FormatInt(seq.Seq, 10))
	h.Set("Cache-Control", "public, max-age=60")
	w.Write(snap)
}

func (s *Server) listDelta(w http.ResponseWriter, r *http.Request) {
	s.listHit.add(s.Now())
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil || since < 0 {
		writeError(w, http.StatusBadRequest, "invalid_since", "The since parameter must be a list sequence number.")
		return
	}
	b, status, err := s.Publisher.Delta(r.Context(), since)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	_, seq := s.Publisher.Snapshot()
	h := w.Header()
	h.Set("X-Colander-Sequence", strconv.FormatInt(seq.Seq, 10))
	switch status {
	case http.StatusGone:
		writeError(w, http.StatusGone, "sequence_unknown", "That list version is unknown or too old. Fetch the full snapshot.")
	case http.StatusNoContent:
		h.Set("Cache-Control", "public, max-age=60")
		w.WriteHeader(http.StatusNoContent)
	default:
		h.Set("X-Colander-Sequence", strconv.FormatUint(binary.LittleEndian.Uint64(b[8:16]), 10))
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Cache-Control", "public, max-age=60")
		w.Write(b)
	}
}

func (s *Server) adapterConfig(w http.ResponseWriter, r *http.Request) {
	env, err := s.Store.LatestAdapterConfig(r.Context())
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no_config", "There is no remote adapter configuration. Keep the bundled one.")
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write([]byte(env))
}
