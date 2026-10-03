package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/rudecompany/colander/server/internal/auth"
	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/store"
)

// seedDev fills an empty database with fictional demo data. Every verdict comes from the real code
// paths: tags and reports through the store, scoring passes, reviewer decisions and appeals through
// the engine. Names and IDs are invented; the fixture targets from testdata/contract are included.
func seedDev(ctx context.Context, cfg config, log *slog.Logger) error {
	key, err := loadKey(cfg)
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()
	if refs, err := st.SourceRefs(ctx); err != nil || len(refs) > 0 {
		if err == nil {
			err = fmt.Errorf("%s already has data; point COLANDER_DB at a fresh file for seed-dev", cfg.DB)
		}
		return err
	}
	quiet := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	s := &seeder{ctx: ctx, st: st, now: time.Now().UTC().Truncate(time.Second)}
	s.clock = s.now
	pub := lf.NewPublisher(st, key, quiet)
	pub.Now = func() time.Time { return s.clock }
	s.eng = scoring.NewEngine(st, pub, nil, quiet)
	s.eng.Now = func() time.Time { return s.clock }
	if err := s.run(pub); err != nil {
		return err
	}
	counts, items, _ := st.VerdictCounts(ctx)
	seq, _ := st.LatestSequence(ctx)
	fmt.Printf("Seeded %s with fictional demo data.\n", cfg.DB)
	fmt.Printf("Sources: %v, rated items: %d, list sequence %d.\n", counts, items, seq.Seq)
	fmt.Println("Reviewer accounts (sign in with COLANDER_DEV=1; the link prints to stdout):")
	fmt.Println("  rae@colander.test  staff")
	fmt.Println("  sam@colander.test  curator")
	if s.awaitingLink != "" {
		fmt.Println("An appeal awaiting verification:", s.awaitingLink)
	}
	return nil
}

type seeder struct {
	ctx          context.Context
	st           *store.Store
	eng          *scoring.Engine
	now          time.Time // the real time the seed ends at
	clock        time.Time // the simulated time
	mature       []string  // install hashes that started tagging long ago
	fresh        []string  // install hashes younger than a week at the end
	next         int
	staff        *store.Account
	curator      *store.Account
	awaitingLink string
	err          error
}

func (s *seeder) days(d float64) time.Time {
	return s.now.Add(-time.Duration(d * 24 * float64(time.Hour)))
}

func (s *seeder) at(t time.Time) { s.clock = t }

func (s *seeder) fail(err error) {
	if err != nil && s.err == nil {
		s.err = err
	}
}

func newInstall() string {
	b := make([]byte, 16)
	rand.Read(b)
	h, _ := auth.HashInstall(base64.RawURLEncoding.EncodeToString(b))
	return h
}

// tagOpt describes one batch of identical tags from several installs.
type tagOpt struct {
	verdict  string
	slopType string
	tests    uint8
	label    bool
}

const (
	low    = lf.TestLowEffort
	mass   = lf.TestMassProduced
	hollow = lf.TestHollow
)

// tag has each install tag the target. For items, source is the item's source.
func (s *seeder) tag(installs []string, platform, targetType, target, source string, o tagOpt) {
	if source == "" {
		source = target
	}
	for _, h := range installs {
		s.next++
		in := store.TagInput{ClientID: fmt.Sprintf("seed-%06d", s.next), Platform: platform, TargetType: targetType,
			TargetID: target, SourceID: source, Verdict: o.verdict, PlatformLabel: o.label, CreatedAt: s.clock.Unix(),
			ExtVersion: "1.0.0"}
		if o.verdict == "slop" {
			in.SlopType, in.Tests = o.slopType, o.tests
		}
		_, err := s.st.SaveTags(s.ctx, h, []store.TagInput{in}, s.clock.Unix())
		s.fail(err)
	}
}

func (s *seeder) ref(platform, alias string) int64 {
	ref, err := s.st.FindSource(s.ctx, platform, alias)
	s.fail(err)
	return ref
}

func (s *seeder) source(platform, alias, name string) int64 {
	ref, err := s.st.EnsureSource(s.ctx, platform, alias, name, s.clock.Unix())
	s.fail(err)
	return ref
}

// youtube records what the Data API would report, through the same store call enrichment uses.
func (s *seeder) youtube(alias, channelID, handle, title string, subs int64, uploadsPerDay float64) {
	ref := s.source("yt", alias, title)
	_, err := s.st.SetYouTube(s.ctx, ref, store.YouTubeInfo{ChannelID: channelID, Handle: handle, Title: title,
		Subscribers: sql.NullInt64{Int64: subs, Valid: true}, UploadsPerDay: sql.NullFloat64{Float64: uploadsPerDay, Valid: true}},
		s.clock.Unix())
	s.fail(err)
}

// pass scores until nothing changes, since reputation feeds on the verdicts of the pass before.
func (s *seeder) pass() {
	for range 5 {
		if s.err != nil {
			return
		}
		n, err := s.eng.FullPass(s.ctx)
		s.fail(err)
		if n == 0 {
			return
		}
	}
}

func (s *seeder) decide(acct *store.Account, platform, alias, itemID, verdict, reason string, signals uint16, slopType string, tests uint8, large *bool) {
	if s.err != nil {
		return
	}
	ref := s.ref(platform, alias)
	in := scoring.DecisionInput{SourceRef: ref, Verdict: verdict, Reason: reason, Signals: signals, SlopType: slopType,
		Tests: tests, Large: large, Actor: acct.Role, AccountID: acct.ID, ActorName: acct.DisplayName}
	if itemID != "" {
		it, err := s.st.FindItem(s.ctx, platform, itemID)
		if err != nil {
			s.fail(err)
			return
		}
		in.ItemRef = it.Ref
	}
	s.fail(s.eng.Decide(s.ctx, in))
}

func (s *seeder) report(install, platform, source, name, reason, slopType string, tests uint8, examples ...string) string {
	s.next++
	rp, _, err := s.st.CreateReport(s.ctx, store.ReportInput{InstallHash: install, ClientID: fmt.Sprintf("seed-report-%04d", s.next),
		Platform: platform, SourceID: source, SourceName: name, Examples: append([]string{}, examples...), Reason: reason,
		SlopType: slopType, Tests: tests, ExtVersion: "1.0.0"}, s.clock.Unix())
	if err != nil {
		s.fail(err)
		return ""
	}
	return rp.ID
}

func (s *seeder) appeal(platform, alias, email, statement string) *store.Appeal {
	if s.err != nil {
		return nil
	}
	secret, hash := auth.NewToken()
	a, err := s.st.CreateAppeal(s.ctx, store.Appeal{Platform: platform, SourceRef: s.ref(platform, alias), Email: email,
		Statement: statement, Code: "colander-DEMO" + fmt.Sprintf("%04d", s.next), SecretHash: hash, CreatedAt: s.clock.Unix()})
	s.next++
	if err != nil {
		s.fail(err)
		return nil
	}
	if a.Status == store.AppealAwaiting && s.awaitingLink == "" {
		s.awaitingLink = "/appeal/status/" + a.ID + "?secret=" + secret // the website page, not the API route
	}
	return a
}

func pick(list []string, from, n int) []string { return list[from : from+n] }

func (s *seeder) run(pub *lf.Publisher) error {
	ctx, st := s.ctx, s.st
	for range 70 {
		s.mature = append(s.mature, newInstall())
	}
	for range 30 {
		s.fresh = append(s.fresh, newInstall())
	}
	m, f := s.mature, s.fresh

	// Reviewers.
	s.at(s.days(120))
	var err error
	if s.staff, err = st.GrantRole(ctx, "rae@colander.test", "staff", s.clock.Unix()); err != nil {
		return err
	}
	if s.curator, err = st.GrantRole(ctx, "sam@colander.test", "curator", s.clock.Unix()); err != nil {
		return err
	}
	s.fail(st.SetDisplayName(ctx, s.staff.ID, "Rae"))
	s.fail(st.SetDisplayName(ctx, s.curator.ID, "Sam"))
	s.staff.DisplayName, s.curator.DisplayName = "Rae", "Sam"

	// An old staff decision that lapses: Quantum Recipes was confirmed as Slop 95 days ago.
	s.at(s.days(100))
	s.youtube("@quantumrecipesai", "UCdemo000000000000000014", "@quantumrecipesai", "Quantum Recipes AI", 8_200, 16)
	s.tag(pick(m, 0, 8), "yt", "source", "@quantumrecipesai", "", tagOpt{verdict: "slop", slopType: "filler", tests: low | mass, label: true})
	s.at(s.days(95))
	s.decide(s.staff, "yt", "@quantumrecipesai", "", "slop", "Staff review confirmed a narration template over stock footage, posted many times a day.",
		lf.SigTemplated, "filler", low|mass, nil)

	// Seed lists, imported through the same call the import-seed command uses. The names are fictional.
	s.at(s.days(45))
	for _, alias := range []string{"@catrescuetales", "@dailymotivationmachine"} {
		_, err := st.ImportSeed(ctx, "yt", alias, "blocklist", "Demo list", "CC0 (fictional demo)", s.clock.Unix())
		s.fail(err)
	}
	_, err = st.ImportSeed(ctx, "yt", "@biblestoriesanimated", "warnlist", "Demo list", "CC0 (fictional demo)", s.clock.Unix())
	s.fail(err)

	// The bulk of community tagging happens a month ago, by installs that are mature at the end.
	s.at(s.days(40))
	s.youtube("@aihistorydaily", "UCaaaaaaaaaaaaaaaaaaaaaa", "@aihistorydaily", "AI History Daily", 48_000, 22)
	s.youtube("@ancientwondersdaily", "UCdemo000000000000000001", "@ancientwondersdaily", "Ancient Wonders Daily AI", 61_000, 31)
	s.youtube("@lostcivsexplained", "UCdemo000000000000000002", "@lostcivsexplained", "Lost Civilizations Explained", 23_000, 2.5)
	s.youtube("@gossipnarrated", "UCdemo000000000000000003", "@gossipnarrated", "Celebrity Gossip Narrated", 1_240_000, 19)
	s.youtube("@galaxyfacts4k", "UCdemo000000000000000004", "@galaxyfacts4k", "Galaxy Facts 4K", 87_000, 3)
	s.youtube("@grandpasworkshop", "UCdemo000000000000000005", "@grandpasworkshop", "Grandpa's Workshop", 132_000, 0.3)
	s.youtube("@priyaraohistory", "UCdemo000000000000000006", "@priyaraohistory", "Priya Rao History", 9_400, 0.4)
	s.youtube("@oceanmysteriesunveiled", "UCdemo000000000000000007", "@oceanmysteriesunveiled", "Ocean Mysteries Unveiled", 15_000, 12)
	s.youtube("@spacekidssongs", "UCdemo000000000000000008", "@spacekidssongs", "Space Kids Songs", 77_000, 25)
	s.youtube("@forestsoundsrelax", "UCdemo000000000000000009", "@forestsoundsrelax", "Forest Sounds Relax", 4_100, 1)
	s.youtube("@catrescuetales", "UCdemo000000000000000010", "@catrescuetales", "Kitty Rescue Stories", 39_000, 9)

	slop := func(t uint8, kind string, label bool) tagOpt {
		return tagOpt{verdict: "slop", slopType: kind, tests: t, label: label}
	}
	notSlop := tagOpt{verdict: "not_slop"}
	aiFine := tagOpt{verdict: "ai_fine", label: true}

	// YouTube.
	s.tag(pick(m, 0, 12), "yt", "source", "@aihistorydaily", "", slop(low|mass, "filler", true))
	s.tag(pick(m, 10, 11), "yt", "source", "@ancientwondersdaily", "", slop(low|mass|hollow, "filler", true))
	for i := range 6 {
		s.tag(pick(m, 20+i, 3), "yt", "item", fmt.Sprintf("demoAW%05d", i), "@ancientwondersdaily", slop(low|hollow, "filler", true))
	}
	s.tag(pick(m, 25, 4), "yt", "source", "@lostcivsexplained", "", slop(low|hollow, "filler", true))
	s.tag(pick(m, 30, 9), "yt", "source", "@gossipnarrated", "", slop(low|hollow|mass, "deceptive", true))
	for i := range 3 {
		s.tag(pick(m, 40+i, 2), "yt", "item", fmt.Sprintf("demoGF%05d", i), "@galaxyfacts4k", aiFine)
	}
	for i := 3; i < 7; i++ {
		s.tag(pick(m, 40+i, 2), "yt", "item", fmt.Sprintf("demoGF%05d", i), "@galaxyfacts4k", notSlop)
	}
	s.tag(pick(m, 44, 7), "yt", "source", "@galaxyfacts4k", "", slop(hollow, "filler", true))
	s.tag(pick(m, 0, 6), "yt", "source", "@catrescuetales", "", slop(mass|hollow, "deceptive", false))
	s.tag(pick(m, 50, 8), "yt", "source", "@grandpasworkshop", "", notSlop)
	s.tag(pick(m, 55, 3), "yt", "source", "@priyaraohistory", "", slop(low, "filler", false))
	s.tag(pick(m, 58, 2), "yt", "source", "@priyaraohistory", "", tagOpt{verdict: "slop", label: true})
	s.tag(pick(m, 0, 9), "yt", "source", "@oceanmysteriesunveiled", "", slop(low|mass, "filler", true))
	s.tag(pick(m, 12, 10), "yt", "source", "@spacekidssongs", "", slop(low|hollow|mass, "filler", true))
	s.tag(pick(m, 22, 3), "yt", "source", "@forestsoundsrelax", "", slop(low, "filler", true))
	s.tag(pick(m, 25, 3), "yt", "source", "@forestsoundsrelax", "", notSlop)
	s.tag(pick(m, 60, 3), "yt", "source", "@biblestoriesanimated", "", aiFine)

	// TikTok.
	s.tag(pick(m, 30, 5), "tt", "source", "@sloppyfacts", "", tagOpt{verdict: "ai_fine", label: true})
	s.tag(pick(m, 35, 8), "tt", "source", "@petpalsai", "", slop(low|mass, "filler", false))
	for i := range 6 {
		s.tag(pick(m, 45+i, 2), "tt", "item", fmt.Sprintf("74000000000000%05d", i), "@petpalsai", slop(low, "filler", true))
	}
	s.tag(pick(m, 0, 4), "tt", "source", "@miraclecuresdaily", "", slop(hollow|low, "bait", true))
	s.tag(pick(m, 5, 5), "tt", "source", "@historyinshorts", "", slop(low|hollow, "filler", true))
	s.tag(pick(m, 10, 9), "tt", "source", "@chefmarta", "", notSlop)
	s.tag(pick(m, 20, 6), "tt", "source", "@dancewithjules", "", notSlop)
	s.tag(pick(m, 26, 6), "tt", "source", "@aiartgallery", "", aiFine)
	s.tag(pick(m, 33, 4), "tt", "source", "@newsflash24ai", "", slop(hollow, "deceptive", true))
	s.tag(pick(m, 40, 3), "tt", "item", "7412345678901234567", "@trendrecaps", slop(low|hollow, "filler", true))

	// Instagram.
	s.tag(pick(m, 0, 8), "ig", "source", "handmadepottery", "", notSlop)
	s.tag(pick(m, 8, 9), "ig", "source", "dreamy.landscapes.ai", "", slop(low|mass, "filler", true))
	for i := range 5 {
		s.tag(pick(m, 18+i, 2), "ig", "item", fmt.Sprintf("Cdemo%05d", i), "dreamy.landscapes.ai", slop(low, "filler", true))
	}
	s.tag(pick(m, 24, 4), "ig", "source", "cute.animals.daily", "", slop(low|hollow, "filler", true))
	s.tag(pick(m, 28, 3), "ig", "source", "fitness.tips.ai", "", slop(hollow|low, "bait", true))
	s.tag(pick(m, 31, 7), "ig", "source", "marco.photo.walks", "", notSlop)
	s.tag(pick(m, 38, 4), "ig", "source", "astro.wonders.ai", "", aiFine)
	s.tag(pick(m, 42, 9), "ig", "source", "luxury.life.ai", "", slop(low|mass|hollow, "bait", true))
	for i := range 5 {
		s.tag(pick(m, 51+i, 2), "ig", "item", fmt.Sprintf("Cluxe%05d", i), "luxury.life.ai", slop(low, "bait", true))
	}
	s.tag(pick(m, 56, 3), "ig", "source", "garden.with.ana", "", slop(low|hollow, "filler", true))

	// Facebook.
	s.tag(pick(m, 0, 4), "fb", "source", "amazingworldpics", "", aiFine)
	s.tag(pick(m, 0, 4), "fb", "item", "pfbid02abcDEF", "amazingworldpics", slop(hollow|low, "bait", true))
	s.tag(pick(m, 9, 8), "fb", "source", "grandmasrecipesofficial", "", slop(low|hollow, "bait", true))
	s.tag(pick(m, 17, 10), "fb", "source", "100087654321098", "", slop(low|mass, "filler", true))
	for i := range 5 {
		s.tag(pick(m, 27+i, 2), "fb", "item", fmt.Sprintf("pfbiddemo%04d", i), "100087654321098", slop(low, "filler", true))
	}
	s.tag(pick(m, 32, 4), "fb", "source", "veterans.tribute.page", "", slop(hollow|low, "deceptive", true))
	s.tag(pick(m, 36, 8), "fb", "source", "springfield.bakery", "", notSlop)
	for i := range 2 {
		s.tag(pick(m, 44+i, 2), "fb", "item", fmt.Sprintf("pfbidwood%04d", i), "woodworking.hub.daily", aiFine)
	}
	for i := 2; i < 6; i++ {
		s.tag(pick(m, 44+i, 2), "fb", "item", fmt.Sprintf("pfbidwood%04d", i), "woodworking.hub.daily", notSlop)
	}
	s.tag(pick(m, 50, 4), "fb", "source", "woodworking.hub.daily", "", tagOpt{verdict: "ai_fine", label: true})
	s.tag(pick(m, 54, 5), "fb", "source", "heartwarming.moments.ai", "", slop(hollow, "deceptive", true))
	s.tag(pick(m, 59, 5), "fb", "source", "kindness.stories.daily", "", slop(hollow|low, "filler", true))

	// Names for sources that only appear through tags.
	for _, n := range [][3]string{
		{"tt", "@sloppyfacts", "Sloppy Facts"}, {"tt", "@petpalsai", "Pet Pals AI"}, {"tt", "@miraclecuresdaily", "Miracle Cures Daily"},
		{"tt", "@historyinshorts", "History in Shorts"}, {"tt", "@chefmarta", "Chef Marta"}, {"tt", "@dancewithjules", "Dance with Jules"},
		{"tt", "@aiartgallery", "AI Art Gallery"}, {"tt", "@newsflash24ai", "Newsflash 24 AI"}, {"tt", "@trendrecaps", "Trend Recaps"},
		{"ig", "handmadepottery", "Handmade Pottery"}, {"ig", "dreamy.landscapes.ai", "Dreamy Landscapes AI"},
		{"ig", "cute.animals.daily", "Cute Animals Daily"}, {"ig", "fitness.tips.ai", "Fitness Tips AI"},
		{"ig", "marco.photo.walks", "Marco's Photo Walks"}, {"ig", "astro.wonders.ai", "Astro Wonders AI"},
		{"ig", "luxury.life.ai", "Luxury Life AI"}, {"ig", "garden.with.ana", "Garden with Ana"},
		{"fb", "amazingworldpics", "Amazing World Pics"}, {"fb", "grandmasrecipesofficial", "Grandma's Recipes Official"},
		{"fb", "100087654321098", "Divine Ocean Art"}, {"fb", "veterans.tribute.page", "Veterans Tribute Page"},
		{"fb", "springfield.bakery", "Springfield Bakery"}, {"fb", "woodworking.hub.daily", "Woodworking Hub Daily"},
		{"fb", "heartwarming.moments.ai", "Heartwarming Moments AI"}, {"fb", "kindness.stories.daily", "Kindness Stories Daily"},
		{"yt", "@dailymotivationmachine", "Daily Motivation Machine"}, {"yt", "@biblestoriesanimated", "Bible Stories AI Animated"},
	} {
		s.source(n[0], n[1], n[2])
	}

	// First scoring pass a month ago: community verdicts land.
	s.at(s.days(30))
	s.pass()

	// Reports from viewers.
	s.at(s.days(28))
	rptAW1 := s.report(m[1], "yt", "@ancientwondersdaily", "Ancient Wonders Daily AI", "Posts 30 AI history videos a day with the same voice and stock clips.", "filler", mass|low, "demoAW00001", "demoAW00002")
	s.report(m[2], "yt", "@ancientwondersdaily", "Ancient Wonders Daily AI", "Same narration template on every video.", "filler", mass)
	s.report(m[3], "yt", "@galaxyfacts4k", "Galaxy Facts 4K", "Some of these space videos look generated.", "", 0, "demoGF00001")
	rptGrandpa := s.report(m[4], "yt", "@grandpasworkshop", "Grandpa's Workshop", "Looks too polished to be real.", "", 0)
	for i := range 3 {
		s.report(m[60+i], "tt", "@newsflash24ai", "Newsflash 24 AI", "Invented news events with a synthetic anchor voice.", "deceptive", hollow)
	}
	s.report(m[63], "ig", "fitness.tips.ai", "Fitness Tips AI", "Every post pushes the same supplement link.", "bait", hollow)
	s.report(m[64], "fb", "veterans.tribute.page", "Veterans Tribute Page", "Generated photos of veterans presented as real, with a donation link.", "deceptive", hollow|low)
	_ = rptAW1

	// Reviewer decisions over the following weeks.
	s.at(s.days(26))
	s.decide(s.staff, "yt", "@aihistorydaily", "", "slop", "Staff review confirmed mass-produced narration over stock footage.", 0, "filler", low|mass, nil)
	s.at(s.days(25))
	s.decide(s.staff, "yt", "@ancientwondersdaily", "", "slop", "Staff review confirmed a single narration template across hundreds of uploads.", lf.SigTemplated, "filler", low|mass, nil)
	s.at(s.days(24))
	s.decide(s.curator, "fb", "grandmasrecipesofficial", "", "slop", "Every post routes to the same recipe-card site full of ads.", lf.SigLinkFunnel, "bait", hollow|low, nil)
	s.decide(s.curator, "tt", "@miraclecuresdaily", "", "slop", "Synthetic testimonials that push a supplement link in every caption.", lf.SigLinkFunnel|lf.SigCreatorStatement, "bait", hollow|low, nil)
	s.at(s.days(22))
	s.decide(s.curator, "fb", "amazingworldpics", "pfbid02abcDEF", "slop", "Generated image with an affiliate link in the first comment.", lf.SigCreatorStatement|lf.SigLinkFunnel, "bait", hollow|low, nil)
	s.decide(s.staff, "yt", "@spacekidssongs", "", "slop", "Staff review confirmed generated songs and visuals uploaded around the clock for children.", 0, "filler", low|mass|hollow, nil)
	s.at(s.days(21))
	if rptGrandpa != "" {
		s.fail(st.DismissReport(ctx, rptGrandpa, "Original workshop footage with the creator on camera.", s.clock.Unix()))
	}
	s.decide(s.staff, "yt", "@grandpasworkshop", "", "clear", "Original footage and the creator's own narration.", 0, "", 0, nil)
	large, small := true, false
	s.at(s.days(20))
	s.decide(s.staff, "tt", "@sloppyfacts", "", "likely_slop", "Generated facts videos with frequent errors; large audience, so held at Likely slop.", lf.SigPlatformLabel, "filler", hollow, &large)
	// TikTok reports no audience size, so community scoring holds Pet Pals at Likely slop until staff look.
	s.decide(s.staff, "tt", "@petpalsai", "", "slop", "Staff review confirmed generated pet clips posted around the clock to a small audience.", 0, "filler", low|mass, &small)
	s.decide(s.staff, "ig", "luxury.life.ai", "", "slop", "Generated lifestyle images that funnel to a course sales page.", lf.SigLinkFunnel, "bait", hollow|low, nil)

	// Appeals in every state, in the order they happened.
	s.at(s.days(20))
	s.appeal("fb", "heartwarming.moments.ai", "page@heartwarming.example.test", "Our stories are submitted by readers.")
	s.at(s.days(19))
	priya := s.appeal("yt", "@priyaraohistory", "priya@example.test", "I research and narrate every episode myself. I use AI only for captions and translation.")
	s.at(s.days(18.5))
	if priya != nil {
		s.fail(s.eng.VerifyAppeal(ctx, priya))
	}
	s.at(s.days(17))
	luxury := s.appeal("ig", "luxury.life.ai", "owner@luxurylife.example.test", "These are art pieces, not slop.")
	if luxury != nil {
		s.fail(st.TransitionAppeal(ctx, luxury.ID, []string{store.AppealAwaiting}, store.AppealPendingManual, store.AppealChange{}))
		s.at(s.days(16))
		s.fail(s.eng.VerifyAppeal(ctx, luxury))
	}
	// An appeal staff have left waiting for a manual code check: it is kept and escalated.
	if a := s.appeal("fb", "kindness.stories.daily", "admin@kindness.example.test", "A small team writes these stories; we use AI only for the images."); a != nil {
		s.fail(st.TransitionAppeal(ctx, a.ID, []string{store.AppealAwaiting}, store.AppealPendingManual, store.AppealChange{}))
	}
	s.at(s.days(15))
	if priya != nil {
		s.fail(s.eng.ResolveAppeal(ctx, priya, "upheld", "The creator narrates on camera and cites sources. AI is used for captions only, which is not slop.", s.staff))
	}
	s.at(s.days(12))
	if luxury != nil {
		s.fail(s.eng.ResolveAppeal(ctx, luxury, "denied", "Every post funnels to the same paid course, and the images carry generator artifacts.", s.staff))
	}
	s.at(s.days(6))
	if a := s.appeal("yt", "@oceanmysteriesunveiled", "studio@oceanmysteries.example.test", "We film our own dives. Only the intro uses generated footage."); a != nil {
		s.at(s.days(5.5))
		s.fail(s.eng.VerifyAppeal(ctx, a))
	}
	s.at(s.days(4))
	if a := s.appeal("tt", "@sloppyfacts", "team@sloppyfacts.example.test", "We fact-check every script before posting."); a != nil {
		s.at(s.days(3.8))
		s.fail(s.eng.VerifyAppeal(ctx, a))
	}
	s.at(s.days(2))
	s.appeal("ig", "garden.with.ana", "ana@garden.example.test", "I photograph my own garden every morning.")

	// Yesterday's pass and publication.
	s.at(s.days(2))
	s.tag(pick(m, 0, 3), "tt", "source", "@viralpetfails", "", tagOpt{verdict: "ai_fine", label: true})
	s.source("tt", "@viralpetfails", "Viral Pet Fails")
	s.at(s.days(1))
	s.pass()
	if s.err == nil {
		s.fail(pub.Publish(ctx))
	}

	// Two hours ago, a burst of slop tags from brand-new installs: consensus freezes and staff are asked to look.
	s.at(s.now.Add(-2 * time.Hour))
	s.tag(f[:25], "tt", "source", "@viralpetfails", "", slop(low, "filler", true))

	// Today's pass and publication, so a delta from yesterday's sequence has something in it.
	s.at(s.now)
	s.pass()
	if s.err == nil {
		s.fail(pub.Publish(ctx))
	}
	if s.err != nil {
		return errors.Join(errors.New("seed-dev stopped"), s.err)
	}
	return nil
}
