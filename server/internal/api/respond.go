package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]apiError{"error": {Code: code, Message: message}})
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.Log.Error("internal error", "route", r.Pattern, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on our side. Please try again.")
}

func tooMany(w http.ResponseWriter, retry time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
	writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait a moment and try again.")
}

// decode reads one JSON object into v, rejecting unknown fields, trailing data and oversized bodies.
func decode(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	err := dec.Decode(v)
	if err == nil && dec.Decode(&struct{}{}) != io.EOF {
		err = errors.New("unexpected data after the JSON object")
	}
	if err == nil {
		return true
	}
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("The request body is larger than %d bytes.", limit))
	case strings.HasPrefix(err.Error(), "json: unknown field"):
		writeError(w, http.StatusBadRequest, "unknown_field", "The request has a field this API does not accept: "+
			strings.TrimPrefix(err.Error(), "json: unknown field ")+".")
	default:
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not valid JSON for this route.")
	}
	return false
}

func rfc3339(unix int64) string { return time.Unix(unix, 0).UTC().Format(time.RFC3339) }

// optTime is an RFC 3339 time, or null for zero.
func optTime(unix int64) *string {
	if unix == 0 {
		return nil
	}
	s := rfc3339(unix)
	return &s
}

// optString is the string, or null for "".
func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// limiter is a set of token buckets, one per key.
type limiter struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newLimiter(n int, per time.Duration) *limiter {
	return &limiter{rate: float64(n) / per.Seconds(), burst: float64(n), buckets: map[string]*bucket{}}
}

func (l *limiter) refill(key string, now time.Time) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) > 50_000 {
			// Drop buckets that have refilled completely; they hold no state worth keeping.
			for k, old := range l.buckets {
				if old.tokens+now.Sub(old.at).Seconds()*l.rate >= l.burst {
					delete(l.buckets, k)
				}
			}
		}
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.at).Seconds()*l.rate)
	b.at = now
	return b
}

// allow takes n tokens for key from every limiter, or none of them. When refused it returns
// how long until the request would fit.
func allow(now time.Time, key string, n float64, ls ...*limiter) (bool, time.Duration) {
	for _, l := range ls {
		l.mu.Lock()
		defer l.mu.Unlock()
	}
	var wait time.Duration
	for _, l := range ls {
		if b := l.refill(key, now); b.tokens < n {
			wait = max(wait, time.Duration((math.Min(n, l.burst)-b.tokens)/l.rate*float64(time.Second)))
		}
	}
	if wait > 0 {
		return false, wait
	}
	for _, l := range ls {
		l.buckets[key].tokens -= n
	}
	return true, 0
}

// clientIP is the address per-IP rate limits key on: the TCP peer, or the address a trusted reverse
// proxy reports in ClientIPHeader. Set that header only when the server is reachable through the
// proxy alone, or clients can choose their own address.
func (s *Server) clientIP(r *http.Request) string {
	if s.ClientIPHeader != "" {
		if ip := forwardedIP(r.Header.Values(s.ClientIPHeader)); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// forwardedIP picks the client out of a proxy header. Each proxy appends the address it saw on the
// right of X-Forwarded-For, and the left part is whatever the client sent, so the client is the
// right-most hop that is not one of our own proxies. Private, loopback and link-local hops count as
// our own proxies. When every hop is ours, or a hop does not parse, the last one we trust wins.
// A single-value header such as CF-Connecting-IP is a list of one.
func forwardedIP(values []string) string {
	var hops []string
	for _, v := range values {
		hops = append(hops, strings.Split(v, ",")...)
	}
	trusted := ""
	for i := len(hops) - 1; i >= 0; i-- {
		hop := strings.TrimSpace(hops[i])
		ip, err := netip.ParseAddr(hop)
		if err != nil {
			ap, err := netip.ParseAddrPort(hop) // some proxies add the port
			if err != nil {
				break
			}
			ip = ap.Addr()
		}
		ip = ip.Unmap()
		if !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified() {
			return ip.String()
		}
		trusted = ip.String()
	}
	return trusted
}
