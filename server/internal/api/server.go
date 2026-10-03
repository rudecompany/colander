// Package api is Colander's HTTP API (contracts section 6) plus the static website.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/rudecompany/colander/server/internal/auth"
	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
	"github.com/rudecompany/colander/server/internal/youtube"
)

// Server holds the API's dependencies.
type Server struct {
	Store     *store.Store
	Engine    *scoring.Engine
	Publisher *lf.Publisher
	Key       *sign.Key
	Auth      *auth.Auth
	Mail      *mail.Mailer
	YouTube   *youtube.Client // nil when not configured
	PublicURL string
	SiteDir   string
	// ClientIPHeader names the header a trusted reverse proxy puts the client address in, for
	// per-IP rate limits (COLANDER_CLIENT_IP_HEADER). Empty means the TCP peer address.
	ClientIPHeader string
	Now            func() time.Time
	Log            *slog.Logger

	limits  limits
	listHit hitCounter
}

// ponytail: rate limits live in process memory, so they hold per node only. Move them to the
// database or a shared store before running more than one server.
type limits struct {
	tagsMinute, tagsDay, reports, appeals, authEmail, authEmailIP *limiter
}

// New finishes wiring a server built from its exported fields and returns it.
func New(srv *Server) *Server {
	if srv.Now == nil {
		srv.Now = time.Now
	}
	srv.PublicURL = strings.TrimRight(srv.PublicURL, "/")
	srv.limits = limits{
		tagsMinute:  newLimiter(60, time.Minute),
		tagsDay:     newLimiter(500, 24*time.Hour),
		reports:     newLimiter(20, 24*time.Hour),
		appeals:     newLimiter(5, 24*time.Hour),
		authEmail:   newLimiter(5, time.Hour),
		authEmailIP: newLimiter(30, time.Hour),
	}
	return srv
}

// Run flushes the anonymous list request counter once a minute until ctx ends, then once more.
func (s *Server) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			s.listHit.flush(flushCtx, s.Store)
			cancel()
			return
		case <-t.C:
			if err := s.listHit.flush(ctx, s.Store); err != nil {
				s.Log.Error("flush list request counts", "err", err)
			}
		}
	}
}

// Handler returns the full HTTP handler: API routes, the website and the shared middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	route := func(pattern string, h http.HandlerFunc) { mux.HandleFunc(pattern, h) }

	route("GET /healthz", s.health)

	route("GET /v1/list/snapshot", s.listSnapshot)
	route("GET /v1/list/delta", s.listDelta)
	route("GET /v1/config/adapters", s.adapterConfig)

	route("POST /v1/tags", s.postTags)
	route("POST /v1/reports", s.postReport)
	route("GET /v1/reports", s.getReports)
	route("POST /v1/trial", s.postTrial)
	route("GET /v1/sync", s.getSync)
	route("PUT /v1/sync", s.putSync)

	route("GET /v1/sources/{platform}/{source_id}", s.getSource)
	route("GET /v1/log", s.getLog)
	route("GET /v1/stats", s.getStats)

	route("POST /v1/appeals", s.postAppeal)
	route("GET /v1/appeals/{id}", s.getAppeal)
	route("POST /v1/appeals/{id}/verify", s.verifyAppeal)

	route("POST /v1/auth/email", s.authEmail)
	route("POST /v1/auth/verify", s.authVerify)
	route("POST /v1/auth/logout", s.authLogout)
	route("GET /v1/account", s.getAccount)
	route("PATCH /v1/account", s.patchAccount)
	route("POST /v1/account/reviewer-token", s.reviewerToken)

	route("GET /v1/review/queue", s.reviewQueue)
	route("GET /v1/review/sources/{platform}/{source_id}", s.reviewSource)
	route("POST /v1/review/sources/{platform}/{source_id}/decision", s.reviewSourceDecision)
	route("POST /v1/review/items/{platform}/{item_id}/decision", s.reviewItemDecision)
	route("POST /v1/review/reports/{id}/dismiss", s.reviewDismissReport)
	route("POST /v1/review/appeals/{id}/verify", s.reviewVerifyAppeal)
	route("POST /v1/review/appeals/{id}/resolve", s.reviewResolveAppeal)

	route("/v1/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "There is no API route for this method and path.")
	})
	route("/", s.site)

	return s.recoverer(s.logRequests(securityHeaders(cors(mux))))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DB.PingContext(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unhealthy", "The database is not reachable.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// corsPrefixes are the routes the extension calls from any origin (contracts section 6).
var corsPrefixes = []string{"/v1/list/", "/v1/config/", "/v1/tags", "/v1/reports", "/v1/trial",
	"/v1/entitlement/refresh", "/v1/sync", "/v1/review/", "/v1/sources/"}

func isCORSPath(p string) bool {
	for _, pre := range corsPrefixes {
		if p == pre || strings.HasPrefix(p, pre) && (strings.HasSuffix(pre, "/") || p[len(pre)] == '/') {
			return true
		}
	}
	return false
}

// cors answers any origin on the public extension routes, without credentials, and handles preflight.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isCORSPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Expose-Headers", "X-Colander-Sequence, Retry-After")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// logRequests logs the route pattern, never the raw path: paths can carry item and source IDs,
// and the log must never pair those with an install (contracts section 8).
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		route := r.Pattern
		switch route {
		case "":
			route = r.Method + " (preflight)" // answered by the CORS middleware before routing
		case "/":
			route = r.Method + " (site)"
		}
		s.Log.Info("request", "route", route, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Log.Error("panic", "value", v, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on our side.")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
