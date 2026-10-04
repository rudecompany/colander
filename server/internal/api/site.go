package api

import (
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// spaRoute reports whether a path is one of the website's client-rendered routes, which have no
// prerendered file and need the SPA fallback: /s/{platform}/{id}, /appeal/{platform}/{id} and
// /appeal/status/{id}.
func spaRoute(clean string) bool {
	parts := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	if len(parts) != 3 || parts[2] == "" {
		return false
	}
	switch parts[0] {
	case "s":
		return validPlatform(parts[1])
	case "appeal":
		return parts[1] == "status" || validPlatform(parts[1])
	}
	return false
}

// site serves the built website from SiteDir: exact files, then name.html and name/index.html.
// The client-rendered routes get the SPA fallback 200.html; any other path is a real 404, with the
// site's own 404.html (or the 200.html shell, which renders the same page). Without a built site,
// site paths get a plain 404.
func (s *Server) site(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	var candidates []string
	if !strings.Contains(clean, "/.") {
		candidates = []string{clean, clean + ".html", path.Join(clean, "index.html")}
	}
	if spaRoute(clean) {
		candidates = append(candidates, "/200.html")
	}
	for _, c := range candidates {
		f, info, ok := s.siteFile(c)
		if !ok {
			continue
		}
		h := w.Header()
		switch {
		case strings.HasPrefix(clean, "/_app/immutable/"):
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		case strings.HasSuffix(c, ".html"):
			h.Set("Cache-Control", "no-cache")
		default:
			h.Set("Cache-Control", "public, max-age=3600")
		}
		http.ServeContent(w, r, c, info.ModTime(), f)
		f.Close()
		return
	}
	f, _, ok := s.siteFile("/404.html")
	if !ok {
		f, _, ok = s.siteFile("/200.html") // the same shell, which renders the site's not-found page
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusNotFound)
	if r.Method == http.MethodGet {
		io.Copy(w, f)
	}
}

// siteFile opens a regular file under SiteDir.
func (s *Server) siteFile(name string) (*os.File, os.FileInfo, bool) {
	f, err := os.Open(filepath.Join(s.SiteDir, filepath.FromSlash(name)))
	if err != nil {
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		f.Close()
		return nil, nil, false
	}
	return f, info, true
}
