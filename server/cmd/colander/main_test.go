package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/sign"
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

// seed-dev produces every verdict and appeal state, settles (a further pass changes nothing) and
// lists the contract fixture targets with the verdicts the extension's tests expect.
func TestSeedDev(t *testing.T) {
	ctx := context.Background()
	cfg := config{DB: filepath.Join(t.TempDir(), "dev.db"), KeyPath: "../../testdata/dev-signing.key"}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := seedDev(ctx, cfg, log); err != nil {
		t.Fatal(err)
	}
	if err := seedDev(ctx, cfg, log); err == nil {
		t.Fatal("seed-dev ran twice on the same database")
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	counts, _, _ := st.VerdictCounts(ctx)
	for v, n := range counts {
		if n == 0 {
			t.Errorf("no source is %s", v)
		}
	}
	for _, status := range []string{store.AppealAwaiting, store.AppealPendingManual, store.AppealUnderReview,
		store.AppealUpheld, store.AppealDenied, store.AppealExpired} {
		if list, _ := st.AppealsWithStatus(ctx, status); len(list) == 0 {
			t.Errorf("no appeal is %s", status)
		}
	}
	if open, _ := st.OpenReports(ctx); len(open) == 0 {
		t.Error("no open reports")
	}
	// The curator journey in e2e/ decides Fitness Tips AI from an open report in the side panel.
	ref, _ := st.FindSource(ctx, "ig", "fitness.tips.ai")
	if reports, _ := st.ReportsBySource(ctx, ref); len(reports) != 1 || reports[0].Status != "open" {
		t.Errorf("Fitness Tips AI reports = %+v, want one open report", reports)
	}
	var decided int
	if err := st.DB.QueryRowContext(ctx, `SELECT count(*) FROM reports WHERE status = 'decided'`).Scan(&decided); err != nil || decided == 0 {
		t.Errorf("no report closed with a verdict (err %v)", err)
	}
	escalations := map[string]bool{}
	if list, err := st.OpenEscalations(ctx); err == nil {
		for _, e := range list {
			escalations[e.Kind+": "+e.Summary] = true
		}
	}
	for _, want := range []string{"capped: Scores as Slop, held at Likely slop: audience size unknown, needs staff review",
		"appeal: Appeal filed more than 14 days ago still waits for staff to check its code"} {
		if !escalations[want] {
			t.Errorf("no open escalation %q in %v", want, escalations)
		}
	}

	engine := scoring.NewEngine(st, nil, nil, log)
	if n, err := engine.FullPass(ctx); err != nil || n != 0 {
		t.Fatalf("a pass after seeding changed %d targets (err %v)", n, err)
	}

	key, _ := sign.LoadKey(cfg.KeyPath)
	pub := lf.NewPublisher(st, key, log)
	if err := pub.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	snapBytes, _ := pub.Snapshot()
	snap, err := lf.Decode(snapBytes, key.Public)
	if err != nil {
		t.Fatal(err)
	}
	byHash := map[[8]byte]lf.Entry{}
	for _, e := range snap.Entries {
		byHash[e.Hash] = e
	}
	for key, want := range map[string]string{
		"yt:s:@aihistorydaily": "slop", "yt:s:UCaaaaaaaaaaaaaaaaaaaaaa": "slop", "yt:s:@catrescuetales": "likely_slop",
		"tt:s:@sloppyfacts": "disputed", "ig:s:handmadepottery": "clear", "fb:i:pfbid02abcDEF": "slop",
		"tt:i:7412345678901234567": "likely_slop", "tt:s:@petpalsai": "slop", "fb:s:100087654321098": "likely_slop",
		"yt:s:@galaxyfacts4k": "ai_made", "yt:i:demoGF00000": "ai_made", // a mixed source keeps its items' entries
	} {
		e, ok := byHash[lf.Hash(key)]
		if !ok || lf.Verdicts[e.Verdict] != want {
			t.Errorf("%s: verdict %v (listed %v), want %s", key, lf.Verdicts[e.Verdict], ok, want)
		}
	}
	if e := byHash[lf.Hash("tt:s:@sloppyfacts")]; e.Flags&lf.FlagLarge == 0 || e.Signals&lf.SigOpenAppeal == 0 {
		t.Errorf("@sloppyfacts entry = %+v, want large with an open appeal", e)
	}
	if e := byHash[lf.Hash("yt:s:@catrescuetales")]; e.Flags&lf.FlagImported == 0 {
		t.Errorf("@catrescuetales entry = %+v, want imported", e)
	}
}
