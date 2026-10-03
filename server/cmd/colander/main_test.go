package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rudecompany/colander/server/internal/store"
)

func TestImportSeed(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	cfg := config{DB: filepath.Join(dir, "c.db")}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	seed := filepath.Join(dir, "seed.txt")
	os.WriteFile(seed, []byte("! A tiny synthetic list\n@SlopFarmOne\n\nUCzzzzzzzzzzzzzzzzzzzzz9\nnot a channel\n"), 0o644)
	args := []string{"--file", seed, "--list", "blocklist", "--source-name", "AiSList", "--license", "CC BY-NC 4.0"}

	err := importSeed(ctx, cfg, log, args)
	if err == nil || !strings.Contains(err.Error(), "--accept-license") {
		t.Fatalf("import without --accept-license: %v", err)
	}
	if _, err := os.Stat(cfg.DB); err == nil {
		t.Fatal("a refused import must not touch the database")
	}

	if err := importSeed(ctx, cfg, log, append(args, "--accept-license")); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	refs, _ := st.SourceRefs(ctx)
	if len(refs) != 2 {
		t.Fatalf("%d sources imported, want 2", len(refs))
	}
	for _, ref := range refs {
		src, _ := st.GetSource(ctx, ref)
		// Imported blocklist entries are Likely slop at most until reviewed, with attribution kept.
		if src.ImportSource != "AiSList" || src.ImportLicense != "CC BY-NC 4.0" || src.ImportList != "blocklist" ||
			src.State.Verdict != "likely_slop" || src.State.Flags&(1<<5) == 0 {
			t.Fatalf("imported source = %+v", src)
		}
	}
	if _, err := st.FindSource(ctx, "yt", "@slopfarmone"); err != nil {
		t.Fatal("handle was not lowercased to its canonical form")
	}
	log2, _ := st.Log(ctx, store.LogFilter{Limit: 1})
	if len(log2) != 1 || !strings.Contains(log2[0].Reason, "AiSList") {
		t.Fatalf("log does not attribute the list: %+v", log2)
	}

	// A warnlist import is AI evidence only.
	warn := filepath.Join(dir, "warn.txt")
	os.WriteFile(warn, []byte("@aimadebutfine\n"), 0o644)
	if err := importSeed(ctx, cfg, log, []string{"--file", warn, "--list", "warnlist", "--source-name", "AiSList",
		"--license", "CC BY-NC 4.0", "--accept-license"}); err != nil {
		t.Fatal(err)
	}
	ref, _ := st.FindSource(ctx, "yt", "@aimadebutfine")
	if src, _ := st.GetSource(ctx, ref); src.State.Verdict != "ai_made" {
		t.Fatalf("warnlist entry = %q, want ai_made", src.State.Verdict)
	}
}
