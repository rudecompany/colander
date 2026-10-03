// Command colander is the Colander server and its operator tools.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rudecompany/colander/server/internal/api"
	"github.com/rudecompany/colander/server/internal/auth"
	lf "github.com/rudecompany/colander/server/internal/listfmt"
	"github.com/rudecompany/colander/server/internal/mail"
	"github.com/rudecompany/colander/server/internal/scoring"
	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
	"github.com/rudecompany/colander/server/internal/youtube"
)

const usage = `Usage: colander <command> [arguments]

Commands:
  serve                                   run the HTTP server
  keygen                                  write a new signing key to COLANDER_SIGNING_KEY
  sign-config <file.json>                 sign an adapter configuration and serve it
  grant-role <email> <member|curator|staff>
  import-seed --file <path> --list blocklist|warnlist --source-name <name> --license <license> --accept-license
  seed-dev                                fill the database with fictional demo data

Configuration comes from the environment (see server/README.md).
`

// config is the environment configuration from contracts section 10.
type config struct {
	Addr, DB, KeyPath, PublicURL, SiteDir string
	Dev                                   bool
	YouTubeKey, ResendKey, MailFrom       string
	ClientIPHeader                        string
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	return config{
		Addr:       env("COLANDER_ADDR", ":8787"),
		DB:         env("COLANDER_DB", "data/colander.db"),
		KeyPath:    env("COLANDER_SIGNING_KEY", "data/signing.key"),
		PublicURL:  env("COLANDER_PUBLIC_URL", "http://localhost:8787"),
		SiteDir:    env("COLANDER_SITE_DIR", "../web/build"),
		Dev:        os.Getenv("COLANDER_DEV") == "1",
		YouTubeKey: os.Getenv("YOUTUBE_API_KEY"),
		ResendKey:  os.Getenv("RESEND_API_KEY"),
		MailFrom:   os.Getenv("COLANDER_MAIL_FROM"),
		// Only set behind a reverse proxy that overwrites this header (see server/README.md).
		ClientIPHeader: os.Getenv("COLANDER_CLIENT_IP_HEADER"),
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cfg := loadConfig()
	var log *slog.Logger
	if cfg.Dev {
		log = slog.New(slog.NewTextHandler(os.Stdout, nil))
	} else {
		log = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "serve":
		err = serve(ctx, cfg, log)
	case "keygen":
		err = keygen(cfg)
	case "sign-config":
		err = signConfig(ctx, cfg, args)
	case "grant-role":
		err = grantRole(ctx, cfg, args)
	case "import-seed":
		err = importSeed(ctx, cfg, log, args)
	case "seed-dev":
		err = seedDev(ctx, cfg, log)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "colander:", err)
		os.Exit(1)
	}
}

func loadKey(cfg config) (*sign.Key, error) {
	k, err := sign.LoadKey(cfg.KeyPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("no signing key at %s: run `colander keygen` or set COLANDER_SIGNING_KEY", cfg.KeyPath)
	}
	return k, err
}

func serve(ctx context.Context, cfg config, log *slog.Logger) error {
	key, err := loadKey(cfg)
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()

	pub := lf.NewPublisher(st, key, log)
	if err := pub.Publish(ctx); err != nil {
		return fmt.Errorf("initial list publication: %w", err)
	}
	var yt *youtube.Client
	if cfg.YouTubeKey != "" {
		yt = youtube.New(cfg.YouTubeKey, st)
	}
	engine := scoring.NewEngine(st, pub, yt, log)
	srv := api.New(&api.Server{
		Store: st, Engine: engine, Publisher: pub, Key: key, Auth: auth.New(st, cfg.Dev),
		Mail: mail.New(cfg.ResendKey, cfg.MailFrom, cfg.Dev, os.Stdout, log), YouTube: yt,
		PublicURL: cfg.PublicURL, SiteDir: cfg.SiteDir, ClientIPHeader: cfg.ClientIPHeader, Log: log,
	})
	if _, err := os.Stat(cfg.SiteDir); err != nil {
		log.Warn("website not found, site paths will answer 404", "dir", cfg.SiteDir)
	}

	bg, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for _, run := range []func(context.Context){engine.Run, pub.Run, srv.Run} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run(bg)
		}()
	}

	hs := &http.Server{Addr: cfg.Addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 2 * time.Minute}
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("colander listening", "addr", cfg.Addr, "dev", cfg.Dev, "key_id", key.KeyIDHex(), "youtube", yt != nil)

	select {
	case err = <-errc:
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
		err = hs.Shutdown(shutdownCtx)
		done()
	}
	cancel()
	wg.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return err
}

func keygen(cfg config) error {
	k, err := sign.GenerateKeyFile(cfg.KeyPath)
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s already exists; refusing to overwrite a signing key", cfg.KeyPath)
	}
	if err != nil {
		return err
	}
	fmt.Printf("Wrote signing key to %s\nPublic key: %s\nKey ID:     %s\n", cfg.KeyPath, k.PublicBase64(), k.KeyIDHex())
	return nil
}

func signConfig(ctx context.Context, cfg config, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: colander sign-config <file.json>")
	}
	payload, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	var head struct {
		Version json.Number `json:"version"`
	}
	dec := json.NewDecoder(strings.NewReader(string(payload)))
	dec.UseNumber()
	if err := dec.Decode(&head); err != nil {
		return fmt.Errorf("%s is not a JSON object: %w", args[0], err)
	}
	version, err := head.Version.Int64()
	if err != nil {
		return fmt.Errorf("%s needs a top-level integer version", args[0])
	}
	key, err := loadKey(cfg)
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()
	env, err := json.Marshal(key.Envelope(sign.ContextConfig, payload))
	if err != nil {
		return err
	}
	if err := st.SaveAdapterConfig(ctx, version, string(env), time.Now().Unix()); err != nil {
		return err
	}
	fmt.Printf("Signed adapter configuration version %d with key %s. GET /v1/config/adapters now serves it.\n", version, key.KeyIDHex())
	return nil
}

func grantRole(ctx context.Context, cfg config, args []string) error {
	if len(args) != 2 {
		return errors.New("usage: colander grant-role <email> <member|curator|staff>")
	}
	email, ok := auth.NormalizeEmail(args[0])
	if !ok {
		return fmt.Errorf("%q is not an email address", args[0])
	}
	role := args[1]
	if role != "member" && role != "curator" && role != "staff" {
		return fmt.Errorf("role must be member, curator or staff, not %q", role)
	}
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()
	a, err := st.GrantRole(ctx, email, role, time.Now().Unix())
	if err != nil {
		return err
	}
	fmt.Printf("%s (%s) is now %s.\n", a.Email, a.ID, a.Role)
	return nil
}

// importSeed reads a seed list the operator supplies. Nothing is downloaded or bundled: AiSList is
// CC BY-NC 4.0, so the operator must accept that license and its attribution is stored on each entry.
func importSeed(ctx context.Context, cfg config, log *slog.Logger, args []string) error {
	fs := flag.NewFlagSet("import-seed", flag.ContinueOnError)
	file := fs.String("file", "", "path to the seed list (one @handle or UC channel ID per line, ! starts a comment)")
	list := fs.String("list", "", "blocklist (AI evidence and mostly AI) or warnlist (AI evidence only)")
	sourceName := fs.String("source-name", "", "attribution, for example AiSList")
	license := fs.String("license", "", "license of the list, for example \"CC BY-NC 4.0\"")
	accept := fs.Bool("accept-license", false, "confirm you accept the list's license terms")
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch {
	case *file == "" || *sourceName == "" || *license == "":
		return errors.New("--file, --source-name and --license are required")
	case *list != "blocklist" && *list != "warnlist":
		return errors.New("--list must be blocklist or warnlist")
	case !*accept:
		return fmt.Errorf("refusing to import: %s is licensed %s. Read its terms and pass --accept-license to confirm", *sourceName, *license)
	}
	f, err := os.Open(*file)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer st.Close()
	imported, skipped, err := readSeed(ctx, st, f, *list, *sourceName, *license, time.Now())
	if err != nil {
		return err
	}
	engine := scoring.NewEngine(st, nil, nil, log)
	if _, err := engine.FullPass(ctx); err != nil {
		return err
	}
	fmt.Printf("Imported %d YouTube channels from %s (%s) as %s entries, skipped %d lines.\n"+
		"A running server publishes them on its next scoring pass.\n", imported, *sourceName, *license, *list, skipped)
	return nil
}

func readSeed(ctx context.Context, st *store.Store, r io.Reader, list, sourceName, license string, now time.Time) (imported, skipped int, err error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "!") {
			continue
		}
		id, ok := api.CanonicalSource("yt", line)
		if !ok {
			skipped++
			continue
		}
		if _, err := st.ImportSeed(ctx, "yt", id, list, sourceName, license, now.Unix()); err != nil {
			return imported, skipped, err
		}
		imported++
	}
	return imported, skipped, sc.Err()
}
