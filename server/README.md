# Colander server

One Go binary that runs every Colander backend service: the signed shared list, tags and reports, scoring, the review console API, appeals, accounts, settings sync and the static website.
It implements `docs/contracts.md`, which is the source of truth for every route, shape and rule.
State lives in one SQLite file.
Stripe billing (contracts 6.8, except `POST /v1/trial` and `/v1/sync`) is not built yet.

## Running it locally

You need Go 1.25 or newer.
All commands run from this `server/` directory.

```sh
# Run the server with the published development key, in dev mode.
COLANDER_DEV=1 COLANDER_SIGNING_KEY=testdata/dev-signing.key go run ./cmd/colander serve

# Or fill a fresh database with fictional demo data first, then serve it.
COLANDER_DB=data/dev.db COLANDER_SIGNING_KEY=testdata/dev-signing.key go run ./cmd/colander seed-dev
COLANDER_DEV=1 COLANDER_DB=data/dev.db COLANDER_SIGNING_KEY=testdata/dev-signing.key go run ./cmd/colander serve
```

The server listens on `http://localhost:8787`.
It serves the website from `../web/build` when that folder exists, and answers a plain 404 for site paths when it does not.
`GET /healthz` reports whether the database is reachable.

In dev mode, sign-in links and appeal emails are printed to stdout instead of sent.
To sign in to the review console, ask for a link on the website (or `POST /v1/auth/email`) and open the link printed in the server log.
`seed-dev` creates two reviewers, `rae@colander.test` (staff) and `sam@colander.test` (curator).

The development key in `testdata/` is public and only for local runs and tests.
For anything real, create a key with `keygen` and keep it out of the repository.

## Commands

| Command | What it does |
| --- | --- |
| `serve` | Runs the HTTP server, the scoring loop and the list publisher until SIGINT or SIGTERM, then shuts down gracefully. |
| `keygen` | Writes a new Ed25519 seed (base64 of 32 bytes) to `COLANDER_SIGNING_KEY` and prints the public key and key id. It never overwrites an existing key. |
| `sign-config <file.json>` | Signs an adapter configuration with context `colander:config:v1` and stores it, so `GET /v1/config/adapters` serves it. The file needs a top-level integer `version`. |
| `grant-role <email> <member\|curator\|staff>` | Sets an account's role, creating the account if the email is new. |
| `import-seed --file <path> --list blocklist\|warnlist --source-name <name> --license <license> --accept-license` | Imports YouTube channels (`@handle` or `UC...` IDs, one per line, `!` starts a comment) as seed entries, then scores them. |
| `seed-dev` | Fills an empty database with fictional demo data for the website, review console and extension. |

`seed-dev` refuses to touch a database that already has sources.
Every verdict it creates comes from the real code paths: tags and reports through the store, scoring passes, reviewer decisions and appeals through the scoring engine.
It covers all four platforms, every verdict, large, imported, mixed and frozen sources, appeals in every status, open and closed reports, a lapsed decision and a burst of tags from new installs.
It also includes the targets from `testdata/contract/list-expected.json`, such as `@aihistorydaily` and `@catrescuetales`, so the extension's tests line up with dev data.
All names and IDs are invented.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COLANDER_ADDR` | `:8787` | Listen address |
| `COLANDER_DB` | `data/colander.db` | SQLite file (WAL mode) |
| `COLANDER_SIGNING_KEY` | `data/signing.key` | Ed25519 seed file created by `keygen` |
| `COLANDER_PUBLIC_URL` | `http://localhost:8787` | Origin used in emailed links |
| `COLANDER_SITE_DIR` | `../web/build` | Built website, with SPA fallback to `200.html` |
| `COLANDER_DEV` | unset | `1` prints emails instead of sending them and drops the `Secure` cookie flag |
| `YOUTUBE_API_KEY` | unset | YouTube enrichment and automatic appeal verification |
| `RESEND_API_KEY` | unset | Email delivery through Resend |
| `COLANDER_MAIL_FROM` | `Colander <hello@colander.local>` | Sender address; set it to a verified domain when using Resend |

## How the code is laid out

| Package | Responsibility |
| --- | --- |
| `cmd/colander` | The subcommands above, environment configuration and graceful shutdown. |
| `internal/sign` | Loads the Ed25519 key, signs lists, builds and verifies signed JSON envelopes, issues and verifies plan tokens. |
| `internal/listfmt` | The binary list format: target hashing, 16-byte entries, signed snapshots and deltas, decoding with every rejection rule. Its `Publisher` keeps the current snapshot in memory, writes a new sequence only when an entry changes (at most once per 10 seconds) and builds coalesced deltas from stored changes. |
| `internal/store` | SQLite with WAL, foreign keys and a busy timeout. Numbered migrations in `internal/store/migrations` are embedded and applied in order at startup, so new features add a file with the next number. |
| `internal/scoring` | `rules.go` is the pure part of contracts section 9: reputation, tag sums, the four layers and the verdict rules in order, with every threshold in one `Thresholds` struct. `engine.go` runs it against the store, writes a decision log entry with a plain-language reason for every verdict change, raises escalations and asks for list publication. |
| `internal/youtube` | A small YouTube Data API v3 client: handle and channel ID resolution, subscriber counts, uploads per day over 14 days and appeal code checks. Responses are cached in the database for 7 days. |
| `internal/auth` | Email sign-in links (20 minutes, single use), sessions (30 days, `colander_session` cookie), reviewer bearer tokens, install ID hashing and the CSRF header check. Every secret is stored as a SHA-256 hash. |
| `internal/mail` | Sends sign-in and appeal emails through the Resend HTTP API, or prints them in dev mode. |
| `internal/api` | Every route in contracts section 6 except billing, CORS, rate limits, request logging and the static website. |

## Scoring in practice

A full scoring pass runs at startup and every 5 minutes.
A source with a new report is rescored 5 seconds later, and reviewer decisions and appeal changes apply immediately.
Every change asks the publisher for a new list sequence, so a verified appeal reaches every install's next sync within seconds.

A few readings of the contract are worth knowing when you work on scoring.

- A source's tag sums come from tags on the source itself; item tags reach the source through platform label reports and the 80% rule only.
- An item counts toward the 80% rule as AI-made when its own provenance layer is met or a reviewer rated it AI evidence, and as not AI-made when not-slop tags outweigh the others or a reviewer cleared it.
- An item gets its own verdict only when it says more than its source's, so items of a Slop source are not listed again as Likely slop.
- Reputation counts a target as decided when it holds a reviewer or appeal decision, a slop verdict the consensus layer agreed on, or a Clear from not-slop consensus.
- Reviewers can record provenance and behavior signals; the other signals are always computed.
- When a decision or verdict reaches its 90-day `rescore_at` and scores as Slop again, it is held at Likely slop with an escalation until a reviewer looks again.

Scoring never reads plan, payment or donation state.

## Privacy

Install IDs are stored only as `hex(SHA-256("colander-install:" + id))`.
Request logs record the route pattern, status and duration, never the raw path, so item and source IDs never sit next to an install in a log line.
List downloads carry no identifier; the server counts them per hour to estimate active installs.

## Seed lists and the AiSList license

AiSList is licensed CC BY-NC 4.0 (NonCommercial), not MIT as the product spec assumed.
Colander therefore never bundles or downloads its data.
`import-seed` reads only a file the operator supplies, refuses to run without `--accept-license`, and stores the attribution and license on every imported source.
The decision log names the list each imported entry came from.
Check with counsel before importing a NonCommercial list into a service that sells a paid plan.

A blocklist import counts as AI evidence and as mostly AI-made, so an unreviewed entry is Likely slop at most and raises an escalation when the community would otherwise reach Slop.
A warnlist import counts as AI evidence only, so it is AI-made unless the community adds more.

## Tests

```sh
gofmt -l .
go vet ./...
go test ./... -race
```

The contract fixture test in `internal/listfmt` rebuilds `testdata/contract/list-snapshot.bin` and `list-delta.bin` byte for byte from `list-expected.json`.
API tests run against `httptest` and a temporary SQLite file, and the YouTube client is tested against an `httptest` fake.
No test calls a real external service.

## Running more than one node

The server is built for one node.
Rate limits live in process memory, the scoring engine serializes its writes with one lock, and SQLite is a local file.
Move rate limits to the database and switch to a client-server database before running several servers behind a load balancer.
Back up the database file with SQLite's online backup (for example `sqlite3 colander.db ".backup backup.db"`), not by copying it while the server runs.
