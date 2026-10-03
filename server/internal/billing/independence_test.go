package billing

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const module = "github.com/rudecompany/colander/server/"

// billingState matches the billing package and its tables in Go source.
var billingState = regexp.MustCompile(`internal/billing|\.Billing\b|\b(subscriptions|donations|billing_events)\b`)

// TestIndependence enforces the independence rule: paying or donating never changes tag weight,
// review order or a verdict, because scoring and the tag, report and review handlers cannot reach
// billing state. It checks scoring and every package it depends on, and the handler files.
func TestIndependence(t *testing.T) {
	seen := map[string]bool{}
	var walk func(pkg string, chain []string)
	walk = func(pkg string, chain []string) {
		if seen[pkg] {
			return
		}
		seen[pkg] = true
		chain = append(chain, strings.TrimPrefix(pkg, module))
		dir := filepath.Join("..", "..", strings.TrimPrefix(pkg, module))
		files, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil || len(files) == 0 {
			t.Fatalf("no Go files for %s in %s", pkg, dir)
		}
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			for _, imp := range checkFile(t, file, chain) {
				if strings.HasPrefix(imp, module) && !strings.HasPrefix(imp, module+"internal/billing") {
					walk(imp, chain)
				}
			}
		}
	}
	walk(module+"internal/scoring", nil)
	if !seen[module+"internal/store"] {
		t.Fatal("the import walk did not reach internal/store; the test is not looking where it should")
	}

	// The tag, report and review handlers live in package api next to the billing routes, so they
	// are checked file by file.
	for _, file := range []string{"../api/review.go", "../api/extension.go"} {
		checkFile(t, file, []string{"internal/api"})
	}
}

// checkFile fails the test when file imports billing or mentions billing state, and returns its imports.
func checkFile(t *testing.T, file string, chain []string) []string {
	t.Helper()
	src, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	f, err := parser.ParseFile(token.NewFileSet(), file, src, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	var imports []string
	for _, spec := range f.Imports {
		path, _ := strconv.Unquote(spec.Path.Value)
		imports = append(imports, path)
	}
	if loc := billingState.FindIndex(src); loc != nil {
		line := strings.Count(string(src[:loc[0]]), "\n") + 1
		t.Errorf("%s:%d reaches billing state (%q) via %s; scoring, tags and review must never read it",
			file, line, src[loc[0]:loc[1]], strings.Join(chain, " -> "))
	}
	return imports
}
