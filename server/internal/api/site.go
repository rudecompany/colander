package api

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// site serves the built website from SiteDir: exact files, then name.html and name/index.html,
// then the SPA fallback 200.html. Without a built site, site paths get a plain 404.
func (s *Server) site(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	hidden := strings.Contains(clean, "/.")
	candidates := []string{clean, clean + ".html", path.Join(clean, "index.html"), "/200.html"}
	if hidden {
		candidates = candidates[3:]
	}
	for _, c := range candidates {
		f, err := os.Open(filepath.Join(s.SiteDir, filepath.FromSlash(c)))
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			f.Close()
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
	http.NotFound(w, r)
}
