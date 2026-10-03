# Colander server

One Go binary that runs every Colander backend service: the signed shared list, tags and reports, scoring, the review console API, appeals, accounts, Stripe billing, settings sync and the static website.
It implements `docs/contracts.md`, which is the source of truth for every route, shape and rule.
State lives in one SQLite file.

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
It covers all four platforms, every verdict, large, imported, mixed and frozen sources, sources held at Likely slop because their audience size is unknown, appeals in every status (one overdue for a manual check), open and closed reports, a lapsed decision and a burst of tags from new installs.
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
| `COLANDER_CLIENT_IP_HEADER` | unset | Header a trusted reverse proxy puts the client address in, for per-IP rate limits (see below) |
| `STRIPE_SECRET_KEY` | unset | Stripe secret or restricted key; billing routes answer `503 billing_unavailable` without it |
| `STRIPE_WEBHOOK_SECRET` | unset | Signing secret of the webhook endpoint |
| `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY` | unset | Price IDs of the $3 monthly and $30 yearly Plus prices |
| `STRIPE_MANAGED_PAYMENTS` | on | Plus checkout with Stripe Managed Payments as merchant of record; `0` sells Plus as your own merchant |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Stripe API origin; tests point it at a fake |

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
| `internal/mail` | Sends sign-in, appeal and billing emails through the Resend HTTP API, or prints them in dev mode. |
| `internal/billing` | Stripe over plain `net/http`: Plus and donation checkout, cancel and refund, webhook verification and events, the subscription state behind paid plan tokens, and supporters. `billingtest` is an in-memory Stripe fake for tests. |
| `internal/api` | Every route in contracts section 6, CORS, rate limits, request logging and the static website. |

## Scoring in practice

A full scoring pass runs at startup and every 5 minutes.
A source with a new report is rescored 5 seconds later, and reviewer decisions and appeal changes apply immediately.
Every change asks the publisher for a new list sequence, so a verified appeal reaches every install's next sync within seconds.

A few readings of the contract are worth knowing when you work on scoring.

- A source's tag sums come from tags on the source itself; item tags reach the source through platform label reports and the 80% rule only.
- An item counts toward the 80% rule as AI-made only on independent evidence: platform label reports from 2 or more installs, or a reviewer rating it Slop, Likely slop or AI-made.
- Tags agreeing an item is AI-made never count there, so tags alone can never make a source look mass-produced.
- An item counts as not AI-made when not-slop tags outweigh the others or a reviewer cleared it; an item with only AI tags counts neither way.
- Community scoring holds rule 6 Slop at Likely slop, with an escalation, when the source is large, is an unreviewed import, or has an unknown audience size.
- The audience size is known when the YouTube Data API reported a subscriber count or staff recorded `large` either way, so a TikTok, Instagram or Facebook source reaches Slop only through a reviewer, or after staff recorded its size.
- The log reason says plainly why a source is held, for example "Held at Likely slop until staff review it, because its audience size is unknown."
- A source is mixed when at least 5 of its items have evidence and under 80% of them are AI-made.
- Platform labels on a mixed source's items never count toward the source's own provenance, so it is AI-made only on evidence about the source itself, and otherwise not rated.
- Items of a mixed source keep their own list entries even when they match the source's verdict, except while an appeal shows the source as Disputed.
- Any other item gets its own verdict only when it says more than its source's, so items of a Slop source are not listed again as Likely slop.
- Item tags without a `source_id` (the card did not show it) are filed under a placeholder source with an empty ID per platform, which is never rated, never frozen and never receives roll-ups; each such item is scored on its own.
- Such an item joins the first real source a later tag names, with its tags and decisions.
- Reputation counts a target as decided when it holds a reviewer or appeal decision, a slop verdict the consensus layer agreed on, or a Clear from not-slop consensus.
- AI-made verdicts from community AI consensus never count as decided, because they would feed back into the weights that produced them.
- Reviewers can record provenance and behavior signals; the other signals are always computed.
- A Slop or Likely slop decision needs AI evidence: `400 ai_evidence_required` unless the target's provenance layer is met without its current decision, or the decision records a provenance signal.
- Curators get `403 staff_required` for large sources and for sources with an appeal in `pending_manual` or `under_review`.
- A denied appeal restores the scored verdict and voids any curator decision on the source made after the appeal was filed.
- An appeal waiting for staff to check its code by hand never expires; once it was filed 14 days ago it also raises an escalation at the top of the review queue.
- When a source's list verdict changes, its open reports close and show that verdict and `protects`; a reviewer decision closes them the same way.
- When a decision or verdict reaches its 90-day `rescore_at` and scores as Slop again, it is held at Likely slop with an escalation until a reviewer looks again.

Scoring never reads plan, payment or donation state, and `TestIndependence` in `internal/billing` fails if scoring, or the tag, report and review handlers, ever import the billing package or name its tables.

## Billing

Billing implements contracts section 6.8 on Stripe.
The server calls the Stripe REST API with `net/http`, pinned to API version `2026-04-22.dahlia`, because it uses a handful of endpoints and the SDK would add nothing but weight.
Without `STRIPE_SECRET_KEY` every `/v1/billing/*` route answers `503 billing_unavailable`, and the website says calmly that payments are switched off.

- Plus checkout creates a Checkout Session in subscription mode with `managed_payments[enabled]=true`, so Stripe is the merchant of record and handles sales tax and VAT.
- It sends the account ID as `client_reference_id` and as subscription metadata, and the account email or, for a returning account, its earlier Stripe customer.
- It never sends tax, shipping or payment method parameters, which Managed Payments rejects.
- Donations use a regular Checkout Session without Managed Payments, because a gift is not a product sale: `mode=payment` once, or `mode=subscription` with a monthly price, with metadata `kind=donation` and the optional credit name.
- Webhooks are verified (HMAC-SHA256 over `t.payload`, any `v1` value, 5 minutes of tolerance, constant-time comparison) and applied once per event ID.
- Every subscription event reads the subscription fresh from Stripe, so events that arrive out of order do no harm.
- `invoice.paid` stores the PaymentIntent that paid the invoice, so Cancel and refund can refund it within 30 days.
- Cancel sets `cancel_at_period_end` and sends a short confirmation email.
- Cancel and refund refunds first and then ends the subscription now, so a failure in between never leaves someone charged without Plus; a retry finishes the cancel without refunding twice.
- Paid plan tokens carry the account ID as `sub` and expire 3 days after the paid period ends; the extension renews them with `POST /v1/entitlement/refresh`.
- Settings sync also checks the plan behind a paid token on every request, so a refund or an ended subscription stops sync at once with `403 no_plan`; install trial tokens run until they expire.
- Billing state lives in its own tables (`subscriptions`, `donations`, `billing_events`) and never includes card data.

### Setting up Stripe

1. Create a product, Colander Plus, and give it a product tax code that the Dashboard labels Eligible for Managed Payments, such as the software as a service code for personal use.
2. Add two recurring prices to it, $3 a month and $30 a year, and put their IDs in `STRIPE_PRICE_PLUS_MONTHLY` and `STRIPE_PRICE_PLUS_YEARLY`.
3. In Settings, Managed Payments, accept the Managed Payments terms of service and check that the account and product are eligible.
   Until Stripe approves it, run with `STRIPE_MANAGED_PAYMENTS=0`, which sells Plus with you as the merchant, so sales tax is then yours to handle.
4. Add a webhook endpoint at `{COLANDER_PUBLIC_URL}/v1/billing/webhook` on API version `2026-04-22.dahlia` with these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` and `charge.refunded`.
   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
5. Put a secret key in `STRIPE_SECRET_KEY`, or a restricted key that can create Checkout Sessions and Refunds and read and update Subscriptions and invoice payments.
6. Set a support email in the public business details, because Stripe receipts show it and monthly donors use it to change or stop a donation.

To try it locally, use test mode keys and forward webhooks with `stripe listen --forward-to localhost:8787/v1/billing/webhook`.
The Go tests never call Stripe: they run against `internal/billing/billingtest`, which records every request and pays checkout sessions the way Stripe would.

## Behind a reverse proxy

Per-IP rate limits (appeals, donations and sign-in emails) key on the TCP peer address.
Behind a proxy or CDN every request comes from the proxy, so set `COLANDER_CLIENT_IP_HEADER` to the header it puts the client address in.

- `CF-Connecting-IP` for Cloudflare, which holds one address.
- `X-Forwarded-For` for most load balancers. The server takes the right-most address that is not private, loopback or link-local, because the left part is whatever the client sent.

Only set it when the server is reachable through the proxy alone, or clients can choose their own address and step around the limits.

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
API tests run against `httptest` and a temporary SQLite file, and the YouTube client and billing are tested against `httptest` fakes.
No test calls a real external service.

## Running more than one node

The server is built for one node.
Rate limits live in process memory, the scoring engine serializes its writes with one lock, and SQLite is a local file.
Move rate limits to the database and switch to a client-server database before running several servers behind a load balancer.
Back up the database file with SQLite's online backup (for example `sqlite3 colander.db ".backup backup.db"`), not by copying it while the server runs.
