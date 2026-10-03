package api

import (
	"encoding/json"
	"os"
	"testing"
)

// TestCanonicalSourceVectors runs the shared contract vectors that the extension also runs, so a
// page link and a seed list line always hash to the same list key on both sides.
func TestCanonicalSourceVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/contract/canonical-ids.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Sources []struct {
			Platform string  `json:"platform"`
			Raw      string  `json:"raw"`
			Source   *string `json:"source"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors.Sources {
		got, ok := CanonicalSource(v.Platform, v.Raw)
		switch {
		case v.Source == nil && ok:
			t.Errorf("%s %q: accepted as %q, want rejected", v.Platform, v.Raw, got)
		case v.Source != nil && (!ok || got != *v.Source):
			t.Errorf("%s %q: got %q (ok=%v), want %q", v.Platform, v.Raw, got, ok, *v.Source)
		}
	}
}
