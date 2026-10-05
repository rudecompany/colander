# Colander on Cloudflare: hosting recommendation

Prepared 2026-10-03 for the product owner to approve.
Status: approved and built; the Go server was deleted once the parity harness passed, as section 4 planned, and stays in git history.
Inputs: the project context, six research tracks, four proposals and two judge verdicts.
Key facts were spot-checked today with Tavily and Exa against the Cloudflare docs and against the v1 worktree.

## 1. Recommendation

**Approve this design: one TypeScript Worker on getcolander.com, with one SQLite-backed Durable Object as the database.**
R2 holds the signed list and the backups.
Workers Cache sits in front of the busy list endpoints, and Workers Static Assets serves the website.
GitHub Actions is the only pipeline for build, test and release.

Why this design:
- It fits how Cloudflare is meant to be used.
  No process has to stay alive and no disk has to be restored.
  Every deploy is one atomic Worker version (code, assets, crons and Durable Object code), and one command rolls it back.
- A write is confirmed only after 3 of 5 replicas in separate data centers have it.
  The database can also be restored to any point in the last 30 days ([SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/), [PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
- One Durable Object instead of D1 keeps real SQLite transactions (`transactionSync`, with code between statements) and local queries that take microseconds.
  So the Go store, scoring engine and publisher port almost line for line.
  That removes the biggest risk both judges found in every D1 design: rewriting all 18 Go transaction sites as batches with guard statements ([D1 has no interactive transactions](https://blog.cloudflare.com/whats-new-with-d1)).
- Cost is about $7 a month at 1,000 weekly installs.
  At 100,000 it is about $31-40 once the incremental scoring planner ships (section 7).

What it costs you:
- It retires the Go backend, which goes against your stated preference for Go.
  Go cannot run inside Workers in a production-ready form today: modernc.org/sqlite cannot target wasm, and workers-go is experimental with no transactions.
  Keeping Go on Cloudflare therefore means a Container.
  That brings Litestream to R2, a restore at every boot, epoch fencing and a keepalive.
  It also means 10-30 s with no API on every deploy and host restart, and up to about 1 s of lost writes on a hard kill ([Containers FAQ](https://developers.cloudflare.com/containers/faq/)).
  Your rule says development cost does not decide, while quality, simplicity, robustness and maintainability do.
  Under that rule the Cloudflare-native design wins.
- About 8,600 lines of Go and 3,000 lines of tests get ported to TypeScript.
  server/ is deleted only after a Go-versus-TypeScript parity harness passes.

How the judges split:
- The robustness judge ranked the TypeScript Workers design first (7.5 vs 7.0).
- The cost-and-fidelity judge ranked the Go container first (7.5 vs 7.0), almost entirely because of the Go preference.

This recommendation takes the robustness winner, replaces D1 with one Durable Object, and fixes every weakness either judge named.

### 1.1 Ideas taken from the other proposals

- From the Go container proposal:
  - list sequence numbers floored to wall-clock seconds
  - an R2 last-good snapshot
  - a cron watchdog with email alerts
  - bucket-locked backups that are independent of the primary store, plus a restore drill
  - an authenticated ops channel driven from GitHub
  - a persistent staging environment
  - edge cache settings `cross_version_cache` and `stale-if-error`
- From the D1-bridge proposal:
  - the bump-and-purge rule after a restore
  - a test that asserts Cache-Control on every route
  - `public, max-age=60` on GETs that are the same for every viewer
  - Cloudflare Access on staging
- From the Rust proposal:
  - exact, persisted rate limits
  - `no-store` as the default
  - explicit cache headers on delta 204 and 410 responses
- From the TypeScript proposal:
  - one shared implementation of list format, signing and canonical IDs in packages/shared
  - the parity harness
  - Vitest running inside workerd
  - publisher self-heal from R2

### 1.2 Must-fix items and where each is handled

| Must-fix item | From | Where it is handled |
|---|---|---|
| Sequences must never go backwards on any recovery path (the extension rejects older snapshots, extension/src/background/listsync.ts:73) | robustness | `seq = max(prev+1, unix seconds)`; at start the Store compares its head with the R2 snapshot's seq and publishes above it; the ops restore purges the edge cache (sections 2 and 3) |
| Protect the single-threaded store from abuse | robustness | 60 s edge cache on /v1/sources/*, /v1/log, /v1/stats, /v1/supporters; `since` must be digits and no later than now+60 s; a Rate Limiting binding on cache misses per hashed IP; exact quotas in the Store |
| cross_version_cache and stale-if-error | robustness | Both are on; list responses carry `stale-if-error=86400` (section 2) |
| Automatic Resend fallback for mail | robustness | The mailer tries Email Sending, then Resend on any error, with no config switch |
| Parity and interleaving tests must gate the deletion of server/; magic-link consume and session creation in one transaction | robustness | Both are required CI jobs; `UseMagicLink` and `CreateSession` run in one `transactionSync` |
| Bound contention and measure backup blocking | robustness | Alert at 2M rows read per pass and ship the incremental planner when it fires; alert when a dump blocks for more than 10 s |
| Prove "a verified appeal reaches installs within a minute" end to end | cost | Edge TTL 15 s with no stale-while-revalidate gives a worst case of about 41 s; a staging test asserts under 60 s |
| Check that zone analytics count Workers Cache hits before stats depend on them | cost | Staging check before launch (section 9) |
| Persist the daily quotas | cost | Token buckets live in Store SQLite and are checked in the same transaction as the write |
| The extension must retry across short outages | cost | The tag queue already honors Retry-After (extension/src/background/net.ts); route reports and sign-in retries the same way |
| No alerting channel (a flaw in the TypeScript proposal) | cost | A watchdog cron every 5 minutes sends email alerts; an hourly GitHub probe watches from outside |
| Epoch per boot, explicit Litestream R2 options, GOMEMLIMIT, a sleeping staging container | cost | Container-only items; they are fixed in the Go fallback, section 1.4 |

### 1.3 Should the backend have been written in Rust compiled to WebAssembly?

No, and switching to Rust now is not worth it.
The hard part of Workers is the architecture, and it is the same in any language: no long-lived process, no local SQLite file, and isolates that can be evicted at any time.
Colander is I/O-bound, and its busiest path (list sync) runs no code at all on a cache hit, so Rust's CPU advantage buys nothing.
workers-rs is still 0.x, with a breaking minor release about every 5 months.
Its README still labels the D1 feature alpha, and it has no `transactionSync` wrapper.
With `panic=abort`, one panic fails every in-flight request on the isolate, and integration tests need a JavaScript harness anyway ([workers-rs README](https://github.com/cloudflare/workers-rs/blob/main/README.md), [Rust Workers reliability](https://blog.cloudflare.com/making-rust-workers-reliable/)).
TypeScript is the first-class Workers language ([languages](https://developers.cloudflare.com/workers/languages/)).
It also lets the backend share list, signing and ID code with the extension and the website, which are already TypeScript.
If the backend moves into Workers it should be TypeScript; if it stays in Go it belongs in a Container.

### 1.4 If you decide to keep Go anyway

Use the Go container design (one container with Litestream to R2 behind an edge-caching Worker), with these fixes applied:
1. Start a new epoch on every process boot.
   Record it as the restore source only after Litestream has uploaded that epoch's first snapshot.
   Otherwise a kill in that window traps the API in a fail-closed restart loop.
2. The R2 bridge accepts a snapshot PUT only when its sequence is higher than the stored one.
   That stops a stale overlapping instance from overwriting the last-good list.
3. Persist the daily quotas in SQLite.
4. Edge TTL 15 s with no stale-while-revalidate, and prove the appeal bound in staging.
5. Rate-limit cache misses on all /v1/* GETs per hashed IP, not only POSTs.
6. Set Litestream's R2 options explicitly (`sign-payload: true`, `concurrency: 2`).
   Alert on R2 Class A operation counts and on restore duration.
7. Set `GOMEMLIMIT` to about 800 MiB, add an OOM alert, and load-test a 26k seed import plus a full scoring pass in staging.
8. Let the staging container sleep outside deploy soaks.
9. Make reports and sign-in retry across 503 windows (tags already do).
10. Verify that zone analytics count Workers Cache hits.

You then accept 10-30 s API gaps on every deploy and host restart, and about 1 s of possible write loss on a hard kill.
Cost would be about $15-25 a month at 1,000 installs and $45-60 at 100,000.

## 2. Architecture

| Part | Cloudflare product | Role |
|---|---|---|
| Domain, DNS, TLS | Registrar + DNS zone getcolander.com; drainslop.com as a second zone with a Redirect Rule | One zone for DNS, TLS, Worker, cache and mail records; Bot Fight Mode off, because it can challenge extension API traffic and cannot be skipped ([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)) |
| Edge Worker `colander` (new `api/` package) | Workers Paid, Custom Domain getcolander.com | Thin front: checks `since`, rate-limits cache misses, hashes the client IP, answers CORS preflights, serves snapshot misses from R2, guards /ops/*, runs crons, forwards the rest of /v1/* to the Store |
| Website | Workers Static Assets in the same Worker | `html_handling: auto-trailing-slash` serves /name from name.html, matching today's Go lookup ([html handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)); asset requests become billable because cache is on ([billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) |
| SPA fallback | `_redirects` proxy rules plus `not_found_handling: 404-page` | `/s/{platform}/:id /200 200`, `/appeal/{platform}/:id /200 200` and `/appeal/status/:id /200 200`, one rule per platform; 404.html is a copy of 200.html so unknown paths return a real 404; built-in SPA mode is not used because it always serves /index.html ([SPA mode](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)) |
| Edge cache | Workers Cache (`cache.enabled`, `cross_version_cache: true`) | Tiered, with request collapsing, in front of snapshot, delta, adapter config and public GETs; hits run no code ([Workers Cache](https://developers.cloudflare.com/workers/cache/), [configuration](https://developers.cloudflare.com/workers/cache/configuration/)) |
| System of record: `Store`, one instance "primary" | Durable Object with SQLite storage, location hint enam | All 25 tables, the ported API handlers, transactions, quotas, scoring, list publisher, and one alarm driving a small jobs table ([limits: 10 GB per object, CPU 30 s default and configurable](https://developers.cloudflare.com/durable-objects/platform/limits/)) |
| Signed list file | R2 bucket `colander-lists` | `list/snapshot.bin` with `customMetadata.seq` and `created`; serves every snapshot miss and survives a Store outage |
| Backups | R2 bucket `colander-backups`, 7-day bucket lock, 90-day lifecycle | SQL dump every 6 hours, independent of the Store's own recovery history |
| Schedules | One Durable Object alarm, plus Cron Triggers `*/5 * * * *` (watchdog) and `7 * * * *` (analytics) | Alarms run at least once and retry up to 6 times with backoff ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)); the watchdog re-arms a lost alarm |
| Abuse controls | Workers Rate Limiting binding on cache misses, keyed by hashed IP; exact quotas inside the Store | The binding counts per location and is eventually consistent, so it is only a burst shield ([rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)) |
| Transactional mail | Email Service, Email Sending (`send_email` binding, beta), automatic Resend fallback | Magic links, appeal and billing mail ([Email Service](https://developers.cloudflare.com/email-service/)) |
| Alerts | `send_email` binding `ALERTS` with `destination_address` set to the verified ops address | Sending to verified addresses is free on all plans ([send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)) |
| Active-install estimate | GraphQL Analytics API (`httpRequestsAdaptiveGroups`, path `/v1/list/%`) | Cache hits never reach code; the hourly cron writes aggregate counts into `list_requests` |
| Secrets | Worker secrets per environment | Signing seed, Stripe, YouTube, Resend, analytics token, IP salt, ops token ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)) |
| Observability | Workers Logs with `invocation_logs: false` | Invocation logs record request details, so they stay off; code logs route pattern, status and ms only ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)) |
| Inspection | Durable Objects Data Studio (beta) | Dashboard SQL access to the Store, with audit logging ([Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)) |
| Staging | Wrangler env `staging` on staging.getcolander.com behind Cloudflare Access | Its own Worker, Store namespace, R2 buckets, test signing key and Stripe test mode |
| CI/CD | GitHub Actions + `cloudflare/wrangler-action@v4`; Workers Builds not used | Section 5 |

Cache headers set by the Store:
- List 200 and 204: `Cloudflare-CDN-Cache-Control: public, max-age=15, stale-if-error=86400`, plus the contract's client header `Cache-Control: public, max-age=60`.
- Delta 410: `Cloudflare-CDN-Cache-Control: public, max-age=15`.
  Without explicit headers, heuristics would cache a 204 for 2 hours ([configuration](https://developers.cloudflare.com/workers/cache/configuration/)).
- Adapter config: edge `max-age=300, stale-if-error=86400`.
- /v1/sources/*, /v1/log, /v1/stats, /v1/supporters: `public, max-age=60`.
  These handlers must never read the session, because cookie-only requests are not bypassed ([limitations](https://developers.cloudflare.com/workers/cache/limitations/)).
- Everything else: `no-store`.
- Never use `s-maxage`, `must-revalidate` or `proxy-revalidate`, because they turn off stale serving ([configuration](https://developers.cloudflare.com/workers/cache/configuration/)).

### Main request flows

1. **Extension delta sync (busiest path, up to about 72M a month at 100k installs).**
   The service worker sends `GET /v1/list/delta?since=N` with no Authorization header and no cookie.
   A cache hit at the lower or upper tier returns with no code running.
   On a miss, the Worker checks that `since` is 1-15 digits and no later than now+60 s, charges the miss to the per-IP-hash limiter, and calls the Store.
   The Store answers from memory: 200 with the signed delta, 204 when current, or 410 when the base is unknown or older than 30 days.
   If the Store fails while an expired entry is being refreshed, the edge serves the last good copy.
   On a true miss it returns 503 `no-store` with Retry-After, and the extension keeps its current list.
2. **Snapshot.**
   On a cache miss the Worker reads `list/snapshot.bin` from R2 and sets `X-Colander-Sequence` from the object metadata, with no Store call.
   The extension verifies the Ed25519 signature whichever path served the file.
3. **CORS preflights.**
   OPTIONS requests are never cached, so the Worker answers them itself with `Access-Control-Allow-Origin: *` and `Max-Age: 7200`, which is Chromium's cap ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age)).
   Preflights never reach the Store.
4. **Tags.**
   `POST /v1/tags` with `Authorization: Install <id>` bypasses the cache.
   The Worker forwards it with the hashed client IP.
   One Store transaction takes the 60/min and 500/day quota tokens and upserts installs, sources, aliases, items and tags with today's SQL.
   If a quota refuses, the response is 429 with Retry-After and nothing is written.
   Tags wait for the next 5-minute pass, as they do today.
5. **Reports and dismissals.**
   Same path as tags, with a 20/day quota.
   They queue a debounced rescore job due 5 s later.
6. **Appeals.**
   Creation is limited per hashed IP (5/day).
   Verification calls the YouTube Data API outside any transaction, using youtube_cache.
   One transaction then records the result and rescores inline, and a publish job follows.
   Worst case at the edge: up to 10 s publish floor, plus 15 s lower tier, plus 15 s upper tier if Age is not carried between tiers, so about 41 s.
7. **Review console and extension side panel.**
   They authenticate with the session cookie plus CSRF, or with a reviewer bearer token.
   AddDecision, the inline rescore and the decision_log entry commit in one transaction, and the publisher writes a new sequence within 10 s.
8. **Email sign-in.**
   `POST /v1/auth/email` takes the per-email-hash and per-IP-hash quotas and inserts the magic link in one transaction.
   It then sends through the Email Sending binding, falling back to Resend on any error.
   `POST /v1/auth/verify` consumes the link and creates the session in one transaction.
   Set-Cookie bypasses the cache.
9. **Stripe.**
   Checkout creates a Session over fetch.
   The webhook takes the raw body, verifies HMAC with `crypto.subtle`, re-reads the objects from Stripe, and applies them in one transaction keyed by event id before returning 2xx.
   Any 5xx makes Stripe retry for up to 3 days.
10. **Settings sync and plan tokens.**
    Ed25519 plan tokens are verified in the Store.
    PUT /v1/sync is a compare-and-set on `version` inside a transaction, and a mismatch returns 409.
11. **Website.**
    Prerendered pages are free asset requests.
    `/s/{platform}/{id}`, `/appeal/{platform}/{id}` and `/appeal/status/{id}` are rewritten to the 200.html shell, and every other unknown path gets 404.html with status 404.
    The shell's own paths `/200` and `/404` run the Worker first (`run_worker_first`), which answers them with the 404 page too, so they are not soft 404s.
    The SPA calls same-origin /v1 routes, which are cached for 60 s where that is safe.
12. **Publication.**
    The publish job runs one `transactionSync`.
    It reads the rated targets, diffs them, and inserts a sequence with `seq = max(prev+1, unix seconds)`.
    In the same transaction it upserts and deletes entries, records changes, and prunes sequences older than 30 days.
    It then encodes the list, signs it with WebCrypto Ed25519, and writes it to R2 with `seq` metadata.
    If R2 lags the local head at start, the Store rewrites it; if R2 is ahead (after a restore), it publishes above R2's seq.
13. **Ops.**
    A GitHub `workflow_dispatch` posts to `/ops/<command>` with `OPS_TOKEN`.
    The Worker compares the token in constant time and calls a Store RPC.
    The workflow log is the audit trail.
14. **Deploy.**
    `wrangler deploy` activates a new version, and Durable Objects restart and lose their in-memory state ([docs](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)).
    The Store constructor runs pending migrations under `blockConcurrencyWhile` and reloads the snapshot.
    A request in flight may fail once and is retried.
    Lists keep coming from cache, because `cross_version_cache` keeps entries across versions.

## 3. Data durability and backups

Mechanism:
- **Write path.**
  Every state change runs inside the Store's SQLite.
  The Durable Object output gate holds the response until the write is durable on a 3-of-5 quorum in separate data centers ([blog](https://blog.cloudflare.com/sqlite-in-durable-objects/)).
  An acknowledged write cannot be lost to a restart, deploy or host failure.
- **Point-in-time recovery.**
  It is always on for 30 days.
  `/ops/pitr-restore` calls `getBookmarkForTime` and `onNextSessionRestoreBookmark`, then `ctx.abort()` ([PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
  The restore also returns an undo bookmark.
- **Independent dumps.**
  Every 6 hours (03:17, 09:17, 15:17, 21:17 UTC) a Store job streams `CREATE` and `INSERT` SQL through gzip into an R2 multipart upload in `colander-backups`.
  The job runs inside `blockConcurrencyWhile`, so the dump is a consistent snapshot.
  The platform caps that call at 30 s and resets the object beyond it ([state API](https://developers.cloudflare.com/durable-objects/api/state/)).
  An alert fires at 10 s.
  Before it reaches 20 s, the job switches to a per-table export with a foreign-key check on restore; this ceiling is marked in the code with a ponytail comment.
  A 7-day bucket lock protects recent dumps from deletion, and lifecycle keeps them 90 days.
- **List safety.**
  Sequences are floored to Unix seconds, and the start-up check against R2 runs on every Store start.
  So no recovery path can reissue or lower a sequence an install already holds.
  After any restore, the ops route also calls `ctx.cache.purge({ purgeEverything: true })` once, which fits within the Free-tier purge limit of 5 per minute ([purge](https://developers.cloudflare.com/workers/cache/purge/)).
- **Guard against wiping the namespace.**
  CI fails any Wrangler config that contains `deleted_classes`, `renamed_classes` or `transferred_classes` for `Store`.
- **Migrations.**
  They are forward-only, run in the constructor, and must be quick (under the 30 s cap).
  Large data changes run as chunked jobs.
  The runner ignores migrations newer than it knows, so a rollback to older code still starts.
  Every schema change is expand-then-contract.
- **Signing key.**
  The seed is generated offline, kept in two offline copies, and set with `wrangler secret put`.
  Worker secrets cannot be read back.
  Key IDs travel in every signed payload, and the extension ships the current and next public keys, so the key can be rotated.
- **Stripe** remains the source of truth for payments.

Restore drills:
- **Weekly, production** (`drills.yml`): `POST /ops/drill`.
  It loads the newest dump into a scratch Store instance named "drill" that runs no jobs.
  It runs `PRAGMA quick_check` and `PRAGMA foreign_key_check`, compares per-table counts with "primary" within tolerance, and asserts the dump is less than 7 h old.
  It then deletes the scratch data.
  Production data never leaves Cloudflare.
- **Monthly, staging:** a PITR drill.
  Write a marker, restore to before it, and check that the marker is gone.
  Check that the next sequence is above R2's, and that a Playwright client holding a post-restore sequence recovers through 410 and a fresh snapshot.
- **Every CI run:** a dump of the e2e dataset must load into stock `sqlite3` and pass `integrity_check`.
  This proves the escape hatch to plain SQLite.

Worst-case data loss:

| Event | Data lost | Recovery |
|---|---|---|
| Store restart, deploy, host or data-center failure | None that was acknowledged | Automatic |
| Bug or operator error corrupts data | None, if caught within 30 days | PITR to the minute before; writes after that point are lost unless replayed |
| Store namespace or object destroyed | Up to 6 h | Restore the newest dump into a fresh Store via ops |
| R2 list object lost | None | Rewritten at the next start or publish |
| Signing key secret lost | None | Offline copy, then `wrangler secret put` |
| Whole Cloudflare account lost | Everything, because the backups are in the same account | Open question: add a weekly encrypted copy at a second provider if this risk matters |

## 4. Changes to the codebase

All work happens in a fresh linked worktree on a new branch, following the repo workflow.

**New `api/` package (`@colander/api`, the TypeScript Worker that replaces server/):**
- `api/wrangler.jsonc` (sketch):
  ```jsonc
  {
    "name": "colander", "main": "src/index.ts", "compatibility_date": "2026-10-01",
    "routes": [{ "pattern": "getcolander.com", "custom_domain": true }],
    "assets": { "directory": "../web/build", "binding": "ASSETS",
      "html_handling": "auto-trailing-slash", "not_found_handling": "404-page",
      "run_worker_first": ["/v1/*", "/ops/*", "/healthz"] },
    "cache": { "enabled": true, "cross_version_cache": true },
    "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "Store" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store"] }],
    "r2_buckets": [{ "binding": "LISTS", "bucket_name": "colander-lists" },
                   { "binding": "BACKUPS", "bucket_name": "colander-backups" }],
    "send_email": [{ "name": "EMAIL" }, { "name": "ALERTS", "destination_address": "<verified ops address>" }],
    "ratelimits": [{ "name": "MISSES", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }],
    "triggers": { "crons": ["*/5 * * * *", "7 * * * *"] },
    "limits": { "cpu_ms": 300000 },
    "rules": [{ "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }],
    "observability": { "enabled": true, "logs": { "invocation_logs": false } },
    "env": { "staging": { /* same shape, staging names, staging.getcolander.com, test key */ } }
  }
  ```
- `src/index.ts`: the edge router.
  It validates `since`, applies the miss limiter, hashes the IP with an `IP_SALT` secret, answers preflights, serves the R2 snapshot, checks `/ops/*` auth, and forwards everything else to `STORE.getByName("primary")` with the enam hint.
- `src/scheduled.ts`: two crons.
  - Every 5 minutes, a watchdog RPC re-arms the alarm and reads status: pass age, publish age, R2 head age, dump age and duration, rows read per pass.
    It sends deduplicated alerts through `ALERTS`.
  - Hourly, it pulls the GraphQL analytics count into `list_requests`.
- `src/store/store.ts`: the `Store` Durable Object.
  - The constructor runs migrations under `blockConcurrencyWhile`, loads the snapshot, and reconciles with R2.
  - `fetch` runs the ported API router, and `alarm` runs due jobs.
  - It exposes RPCs for watchdog, status and ops.
  - Only "primary" runs jobs.
- `src/store/migrations/0001_init.sql` … `0003_scoring_state.sql` are copied from server/internal/store/migrations without the PRAGMAs.
  Add a `_migrations` table, a `limits` table for token buckets and a `jobs` table.
- `src/store/*.ts`: one-to-one ports of server/internal/store/*.go.
  Each `s.Tx(...)` and `BeginTx` becomes `ctx.storage.transactionSync(() => ...)` with the same SQL and read-then-write logic.
  Network calls stay outside transactions, as in Go.
- `src/scoring/*.ts`: line-for-line ports of rules.go, reason.go, actions.go and engine.go, with an injected clock.
  FullPass becomes a resumable chunked job of about 1,000 sources per alarm turn, with a cursor row, so API requests interleave.
  Inline Rescore is unchanged.
  A ponytail comment names the incremental planner (dirty, due or reputation-affected sources plus an hourly full reconcile), to ship when the rows-read alert fires.
- `src/list/publisher.ts`: port of listfmt.Publisher and store.PublishList.
  It uses the time-floored sequence, R2 reconciliation at start, and a 256-entry delta cache.
- `src/jobs.ts`: a jobs table plus the single alarm.
  It runs the 5-minute pass, the 5 s debounce, the 10 s publish floor, the 6-hourly dump and hourly pruning.
- `src/http/*.ts`: router, CORS prefixes, security headers, JSON errors, default `no-store`, and logs by route pattern only.
- `src/routes/*.ts`: ports of server/internal/api/{list,extension,public,appeals,account,review,billing,sync}.go.
- `src/limits.ts` (port of the respond.go token buckets), `auth.ts`, `mail.ts`, `billing.ts`, `youtube.ts`, `backup.ts`.
  `mail.ts` sends through the binding, then Resend, then dev stdout in the exact block format e2e/tests/stack.ts parses.
  `billing.ts` pins the Stripe API to 2026-04-22.dahlia.
  `backup.ts` covers dump, restore-dump and drill.
- `src/ops.ts`: commands status, grant-role, import-seed (one transaction for the whole file), sign-config (signed with the Worker-held key, so the seed never sits on a laptop), pitr-restore (requires a typed confirmation), restore-dump, drill and purge-cache.
- `scripts/keygen.ts`: offline, uses node:crypto, never overwrites, and prints the public key and key ID.
- `test/**`: Vitest with `@cloudflare/vitest-pool-workers`.
  It ports every Go test (store, rules, engine, format, sign, mail, youtube, api, billing, webhook, independence).
  Alarms are driven with `runDurableObjectAlarm`.
  New tests:
  - Cache-Control asserted for every route.
  - A scoring chunk interleaved with a reviewer decision.
  - Sequence monotonicity across a simulated restore.
  - Dump round trip.
  - A config guard on Wrangler settings.

**packages/shared (`@colander/shared`):**
- Move `list.ts`, `signing.ts`, `ids.ts`, `bytes.ts` and `sha256.ts` from extension/src/lib.
- Add the server halves: the encoder, envelope signing for `colander:config:v1` and plan tokens for `colander:plan:v1`.
- The TypeScript encoder must reproduce `testdata/contract/*.bin` byte for byte.

**server/ (Go):**
- No feature changes during the port.
  Add a test-only clock hook so the parity run gets byte-identical signed output; Ed25519 is deterministic.
- Once parity is green: delete server/, the root Dockerfile, the Go CI job and gomod Dependabot.
  The code stays in git history.

**web/:**
- `static/_redirects`: `/s/yt/:id /200 200` and its siblings, one rule per platform for `/s/` and `/appeal/`, and `/appeal/status/:id /200 200`.
  A placeholder matches one path segment, so an unknown platform or an extra segment is a real 404.
  The target is /200, because /200.html redirects with a 307.
- `static/_headers`:
  - HSTS, nosniff, Referrer-Policy, X-Frame-Options DENY.
  - A CSP header with only `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
  - Immutable caching for `/_app/immutable/*`.
  - Script hashes stay in `kit.csp`; no `script-src` goes in the header ([headers](https://developers.cloudflare.com/workers/static-assets/headers/)).
- A postbuild step copies `build/200.html` to `build/404.html`.
  The adapter-static fallback stays `200.html` ([SvelteKit](https://svelte.dev/docs/kit/adapter-static)).
- The Vite dev proxy stays on :8787, which is now `wrangler dev`.

**extension/:**
- Import list, signing and IDs from `@colander/shared`.
- Release builds set `WXT_COLANDER_API` and `WXT_COLANDER_SITE` to `https://getcolander.com`, and `WXT_COLANDER_PUBLIC_KEYS` to the current and next production keys.
- Send reports and sign-in retries through the same Retry-After-aware path the tag queue uses.
- No manifest permission changes and no protocol changes.

**e2e/:**
- `global-setup.ts` starts `wrangler dev --test-scheduled --persist-to e2e/.run/state` with `COLANDER_DEV=1` and a dev key in `.dev.vars`.
  It seeds through a dev-only `/__dev/seed` route and drives crons through `/cdn-cgi/local/scheduled` ([cron testing](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
- New specs:
  - The source and appeal page rewrites return 200.
  - Unknown paths return 404.
  - `_headers` are present.
  - Cache-Control is correct on 200, 204 and 410.
  - The appeal-to-edge timing.
- `COLANDER_E2E_BASE_URL` lets the same specs run against staging and as a read-only production smoke test.
- `e2e/parity/`: a scenario runner that drives the Go server and the Worker through the seed-dev story plus edge cases.
  It diffs verdicts, signals, decision_log reasons, escalations and signed list bytes.

**Repo root, docs and infra:**
- Root `package.json`: pin `wrangler` 4.147.x as a devDependency.
- `Makefile`: `dev` becomes `wrangler dev`, `test` and `e2e` call the new packages, and the docker target is removed.
- `docs/contracts.md`:
  - Sequences are monotonic but not contiguous.
  - Edge TTL 15 s beside client max-age 60.
  - Section 9.6 counts come from edge analytics.
  - The env table becomes Worker vars and secrets.
  - Section 12 key custody.
  - The TypeScript encoder is the byte-for-byte reference.
- `scripts/cloudflare-bootstrap.sh`, idempotent and run once by the owner: create the R2 buckets with an enam location hint, lifecycle rules and the backup bucket lock, then print the list of secrets to set.
- `.github/`: the workflows in section 5, `dependabot.yml` (npm and github-actions), `release-please-config.json` and `.release-please-manifest.json`.

## 5. CI/CD pipeline

Use GitHub Actions only.
Workers Builds cannot gate on the xvfb Playwright suite, keeps its settings in the dashboard, and supports only user-owned tokens ([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
Pin Wrangler in the lockfile and call `cloudflare/wrangler-action@v4` without `wranglerVersion` ([wrangler-action](https://github.com/cloudflare/wrangler-action)).
Bump the stale actions: checkout v7, setup-node v7, pnpm/action-setup v6, upload-artifact v7, attest-build-provenance v4.

| Workflow | Trigger | Jobs and gates |
|---|---|---|
| `ci.yml` | pull_request, push to main, workflow_dispatch; concurrency per ref, cancel in progress for PRs; `contents: read`; no Cloudflare secrets | **api**: tsc, eslint (including a rule against logging `request.url` or headers), Vitest in workerd, `wrangler deploy --dry-run` for both envs, Wrangler config guard. **contract**: fixtures regenerate with no diff, TypeScript encoder byte-equal. **web-and-extension**: as today. **full-stack**: `xvfb-run make e2e` against `wrangler dev`. **parity** and **server**: until server/ is deleted. **dump-compat**: dump loads into stock sqlite3. All are required status checks on main |
| `deploy-staging.yml` | `workflow_run` after a successful ci on main; environment `staging`; concurrency `staging`, no cancel | Build web, `wrangler deploy --env staging`, then smoke tests through an Access service token: pages and 404, /healthz, snapshot signature with the staging key, delta 200/204/410, `cf-cache-status: HIT` on repeat, a tag round trip, a magic link to a test inbox, a staff decision visible at the edge in under 60 s, and a Stripe test-mode checkout session. Records a successful GitHub Deployment for the commit |
| `release.yml` | push to main | **release-please** v5 with two components (below). **deploy-production** runs if the platform component released: environment `production`, tag rule `v*`, concurrency `production`, no cancel. It requires a successful staging deployment of the same commit, records the current version id, runs `wrangler deploy --tag vX.Y.Z --message ...` and a read-only production smoke test. On failure it runs `wrangler rollback <previous id> --message auto-rollback` and fails; on success it publishes the draft release. **release-extension** and **submit-chrome-web-store** are described below |
| `rollback.yml` | workflow_dispatch with input `version`; environment `production` | Looks up the version id for the tag and runs `wrangler rollback <id> --message`; Wrangler refuses across Durable Object class lifecycle changes ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)) |
| `ops.yml` | workflow_dispatch with `command` and an optional repo file; environment `production` | POST `/ops/<command>`; pitr-restore requires typing the target time twice; the run log is the audit trail |
| `probes.yml` | hourly at `41 * * * *`, plus workflow_dispatch; `issues: write` | Snapshot signature with the production key, delta 204 at head, /healthz, and /ops/status thresholds (pass under 15 min, dump under 7 h, publication age within the 6-hour bound). Opens or updates an issue on failure |
| `drills.yml` | weekly at `23 5 * * 1`, plus workflow_dispatch | Production dump drill; monthly PITR drill on staging; issue on failure |
| `adapters-daily.yml` | existing `17 6 * * *` | Keep it, bump the actions, add an issue on failure |

GitHub may delay or drop scheduled runs, and disables them after 60 days without repository activity in public repos ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
So the in-Cloudflare watchdog is the primary alarm and these schedules are the outside check.

Release versioning:
- release-please v5 with a manifest of two components ([manifest releaser](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)):
  - **platform** at the repo root, with `exclude-paths: ["extension"]` and tags `vX.Y.Z`.
  - **extension** at `extension/`, release-type node, tags `extension-vX.Y.Z`.
    It bumps `extension/package.json`, which WXT turns into the manifest version.
- Both use `draft: true` and `force-tag-creation: true`, so assets are attached before publishing under immutable releases ([immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).
- release-please writes the CHANGELOG.md files, and they are never edited by hand.

Approvals:
- Merging a release PR is the human approval for production.
- Branch protection on main requires every ci job.
- Required reviewers on the `production` environment work only if the repo is public, or on Enterprise ([environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
  Add them if the repo is public.

Store publishing:
- `release-extension`:
  - Build the Chrome, Edge and Firefox packages with `extension/scripts/build-store.sh` from `extension/release.env`, which must hold the same keys as `COLANDER_PUBLIC_KEYS`.
  - Check the manifests (`extension/scripts/check-packages.sh`) and run `web-ext lint`, then rebuild the Firefox package from its sources zip and require it byte for byte, as AMO's reviewers do.
  - `actions/attest` over the three packages and the sources zip.
  - `gh release upload`, then publish the draft.
- `submit-edge-add-ons` and `submit-amo` follow `submit-chrome-web-store` once their variables are set (`docs/deploy.md` steps 18 and 19): Edge's Publish API with an API key that expires every 72 days, and `web-ext sign --channel listed` with the sources zip.
- `submit-chrome-web-store`, in environment `chrome-web-store`:
  - Authenticate with `google-github-actions/auth@v3` through keyless Workload Identity Federation (`token_format: access_token`, scope `https://www.googleapis.com/auth/chromewebstore`), so no JSON key is stored ([auth](https://github.com/google-github-actions/auth), [service accounts](https://developer.chrome.com/docs/webstore/service-accounts)).
  - Call API v2 `:upload`, then `:publish` with `publishType: STAGED_PUBLISH`, then poll `:fetchStatus` ([publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)).
- API v1.1 stops working on 2026-10-15, so use v2 only ([CWS API v2](https://developer.chrome.com/blog/cws-api-v2)).
- The item and listing are created by hand once, because v2 cannot create items.
- Every update goes through review, because `skipReview` does not apply ([skip review](https://developer.chrome.com/docs/webstore/skip-review)).
  The API therefore stays compatible with N-1 and older extensions, and the contract job enforces it.
- Percentage rollouts become available only past 10,000 seven-day active users ([update](https://developer.chrome.com/docs/webstore/update)).

Secrets and credentials:

| Item | Stored in | Set by |
|---|---|---|
| Cloudflare account-owned token, staging | GitHub environment `staging` | Owner |
| Cloudflare account-owned token, production | GitHub environment `production` | Owner |
| `CLOUDFLARE_ACCOUNT_ID` | Repository variable | Owner |
| `OPS_TOKEN` (32+ random bytes, rotated quarterly) | GitHub `production` environment and Worker secret | Owner |
| Access service token for staging smoke tests | GitHub environment `staging` | Owner |
| WIF provider, service-account email, CWS publisher and item IDs | Variables in environment `chrome-web-store` | Owner |
| `COLANDER_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `CF_ANALYTICS_TOKEN`, `IP_SALT`, `OPS_TOKEN` | Worker secrets per environment via `wrangler secret put`; never in GitHub | Owner |

Token scope, to be verified with `--dry-run` and the first deploy ([account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)):
- Account: Workers Scripts Edit, Account Settings Read, and Workers R2 Storage Edit only for bootstrap.
- Zone getcolander.com: Workers Routes Edit and DNS Edit.

Do not use wrangler-action's `secrets:` input, because `wrangler secret put` deploys immediately ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)).
Per-PR Worker Previews are skipped, because Preview cron triggers target production ([previews](https://developers.cloudflare.com/workers/previews/resources/)).
Local `wrangler dev` e2e in CI plus persistent staging cover pre-merge and pre-release testing.

## 6. Domain

Availability was checked by registry RDAP on 2026-10-03.
Prices come from a third-party mirror of Cloudflare's at-cost prices ([cfdomainpricing.com](https://cfdomainpricing.com/prices.json)) and must be confirmed in the dashboard before buying.

| Name | Status | Sold by Cloudflare | USD per year (register/renew) | Note |
|---|---|---|---|---|
| getcolander.com | Available ([RDAP](https://rdap.verisign.com/com/v1/domain/getcolander.com)) | Yes | 10.46 / 10.46, about 11.17 from 2026-11-01 | **Recommended primary** |
| drainslop.com | Available ([RDAP](https://rdap.verisign.com/com/v1/domain/drainslop.com)) | Yes | Same as above | **Recommended defensive 301 and tagline** |
| usecolander.com, trycolander.com | Available | Yes | Same as above | Optional redirects |
| drainslop.app | Available | Yes | 8.20 / 14.20 | Whole TLD is HSTS-preloaded, which is fine because everything is HTTPS |
| colander.tools | Available | Yes | 28.20 / 28.20 | Check for premium pricing |
| colander.so, colander.to | Available | No ([TLD policies](https://www.cloudflare.com/tld-policies/)) | n/a | Would need a second registrar |
| colander.app, colander.dev | Taken, same owner, live restaurant-menu product called "Colander" | - | - | Unlikely to be for sale |
| colander.io | Taken, GoDaddy since 2018, all client locks set | - | - | |
| colander.ai | Taken 2025, parked | - | - | |
| colanderapp.com | Taken, resource-scheduling "Colander" | - | - | |

Buy getcolander.com and drainslop.com in the Cloudflare dashboard with auto-renew left on.
The Registrar API beta defaults auto-renew to off and cannot renew domains ([registrar](https://developers.cloudflare.com/registrar/registrar-api/)).
Registrar forces Cloudflare nameservers, so DNS, TLS, cache, Workers and mail records all live in one zone ([FAQ](https://developers.cloudflare.com/registrar/faq/)).
The .com wholesale fee rises on 2026-11-01 ([Verisign](https://investor.verisign.com/news-releases/news-release-details/verisign-reports-first-quarter-2026-results)).

Trademark caveats:
- No live US COLANDER word mark in software classes 9 or 42 was found ([Trademarkia mirror](https://www.trademarkia.com/search/trademarks?q=colander&view=list&showFilters=true)).
  That is not a clearance opinion.
- Other "Colander" software already exists:
  - PiRogue's Colander, with a "Colander Companion" Firefox extension ([GitHub](https://github.com/PiRogueToolSuite/colander-companion)).
  - The restaurant-filter product on colander.dev.
  - Colander LLC's restaurant app.
  - The Python library.
- Use a descriptive store title such as "Colander - Hide AI Slop".
- Get a proper clearance search (US, EU, UK; classes 9 and 42) before launch marketing.

## 7. Cost estimate

Assumptions:
- Each weekly-active install syncs once an hour, 24 hours a day.
  This is the upper bound; with browsers running about 10 h a day, list requests are about 40% of the figures below.
- About 30 API calls per install per month, and about 2M site asset requests at 100k installs.
- About 12 live `since` values per hour and up to about 10 upper-tier locations with a 15 s TTL.
  That gives at most about 21M delta cache fills a month reaching the Store at 100k.
- Rows read are dominated by the 5-minute full pass, which reads every tag.
- Prices are from [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

| Item | 1,000 weekly installs | 100,000 weekly installs |
|---|---|---|
| Workers Paid plan | $5.00 | $5.00 |
| Worker requests (list, API, assets) | About 0.8M, inside the 10M included: $0 | About 77M; 67M over at $0.30/M: $20.10 |
| Worker CPU | Inside 30M CPU-ms: $0 | About 20-40M CPU-ms: $0-0.20 |
| Durable Object requests | Under 1M: $0 | About 10-25M at $0.15/M over 1M: $1.35-3.60 |
| Durable Object duration (one always-active object, about 324,000 GB-s) | Inside 400,000 GB-s: $0 | Same: $0 |
| SQLite rows read | About 2-3B: $0 | About 25-60B before the incremental planner: $0-35; after it: $0 |
| SQLite rows written and storage | Inside 50M and 5 GB: $0 | About 10-25M and under 5 GB: $0 |
| R2 (snapshot, backups) | $0 | $0-0.50 |
| Email Sending | Under 3,000: $0 | 10-20k at $0.35 per 1,000 over 3,000: $2.50-6.00 |
| Logs and Observability | $0 | $0, including after the 2026-12-01 pricing change ([pricing](https://developers.cloudflare.com/observability/pricing/)) |
| Staging (coarser schedules, mostly idle) | $0 | $0-2 |
| Domains (two .com) | $1.86 | $1.86 |
| **Total** | **About $7 a month** | **About $31-74 a month; $31-40 once the planner ships** |

Not included: Stripe fees, and the YouTube Data API, which is free within its quota.
For comparison, the Go container fallback costs about $15-25 at 1,000 installs and about $45-60 at 100,000.
The per-request charge on cached list hits ($0.30/M) grows linearly with installs in every Cloudflare design, to about $200 a month at 1M installs.

## 8. What the owner must do, and what can be built now

Owner actions, in order:
1. Approve this recommendation, including retiring Go once parity passes, or pick the Go fallback in section 1.4.
2. Cloudflare:
   - Create the account with 2FA and turn on Workers Paid ($5 a month).
   - Register getcolander.com and drainslop.com with auto-renew, after confirming the dashboard price.
   - Turn Bot Fight Mode off.
   - Onboard getcolander.com for Email Sending (it adds MX, SPF, DKIM and DMARC records).
   - Verify an ops alert address in Email Routing.
   - Set up a free Zero Trust organization with an Access application and service token for staging.
   - Create two account-owned API tokens (production, staging) and a Zone Analytics read token.
   - Run `scripts/cloudflare-bootstrap.sh` once.
   - Set the Worker secrets for both environments.
3. Signing key:
   - Run `keygen` offline and keep two offline copies.
   - `wrangler secret put COLANDER_SIGNING_KEY`.
   - Provide the public key, and a next key for rotation, to the extension build.
   - Use a separate test key for staging.
4. Stripe:
   - Live mode with Managed Payments, and products and prices.
   - Webhook at `https://getcolander.com/v1/billing/webhook` with its signing secret.
   - Test mode for staging.
5. Google:
   - A YouTube Data API key.
   - A Chrome Web Store developer account with 2-step verification.
   - Create the item, listing and privacy tab by hand.
   - A GCP Workload Identity pool and provider for the GitHub repo, and a service account added in the Store dashboard.
6. Resend: keep the account and the verified domain as the automatic fallback.
7. GitHub:
   - Create `rudecompany/colander` and decide public or private.
   - Branch protection.
   - Environments `staging`, `production` and `chrome-web-store`, with their secrets and variables.
   - Turn on immutable releases.
8. Order the trademark clearance search.
9. Ongoing: merge release PRs, and publish staged Chrome Web Store items once their backend is live.

Can be built and tested locally now, without any account:
- All of `api/`, the packages/shared moves, the web `_redirects`, `_headers` and 404 changes, and the extension env and retry changes.
- The full Vitest suite in workerd, including Durable Object alarms and storage.
- `wrangler dev` full-stack Playwright with the extension under xvfb, including static routing, cache headers, crons and dev mail.
- The parity harness against the Go server, the dump-compat test, the contract fixtures, the workflows (checked with actionlint), the release-please config and the docs.

Needs the staging account to verify:
- Workers Cache hits, request collapsing, `cross_version_cache`, and whether Age carries between tiers.
- Whether zone analytics count cache hits.
- Email Sending recipient rules and quotas.
- PITR, which is not supported in local dev.
- Store latency from far regions.
- The rate-limit binding's behavior.
- The minimum token permissions.

## 9. Risks and open questions

| Risk | Mitigation |
|---|---|
| Retiring Go goes against your stated preference, and the port could change behavior | Port test for test, line-for-line logic, byte-identical signed output in the parity harness, required CI gates, Go kept in history; fallback in section 1.4 |
| One Store object is a single hot spot (single-threaded, soft limit 1,000 req/s) ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)) | Cache absorbs list traffic; snapshot misses go to R2; preflights never reach the Store; miss limiter and exact quotas; chunked scoring; staging load test (26k import, full pass, synthetic 100k-install traffic) before launch |
| Deploys restart the Store, so an in-flight request can fail | Lists keep serving from cache; the extension retries with Retry-After; migrations must be quick |
| Workers Cache is new (launched 2026-07-06) and has sharp edges | Explicit headers on every route, a test asserting them, no `s-maxage`, TTL-based freshness, purge only after restores |
| Uncacheable GETs pay a cache-tier round trip before the Worker runs ([configuration](https://developers.cloudflare.com/workers/cache/configuration/)) | Small at this volume; split out an uncached entrypoint only if measured latency matters |
| Rows read grow with tags | Alert at 2M rows per pass; ship the incremental planner when it fires |
| Dump blocks the Store and is capped at 30 s | Alert at 10 s; switch to per-table export before 20 s |
| A namespace-deleting migration | CI guard on the Wrangler config; 6-hourly off-object dumps |
| Email Sending is beta, and an unrestricted binding is documented as sending to "any verified destination address" ([send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)) | Verify in staging; if restricted, use the REST API ([REST](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)); automatic Resend fallback either way |
| Privacy: invocation logs record request details, and zone analytics keep paths and IPs | Invocation logs off; lint rule against logging requests; IPs hashed with a salt before storage; Cloudflare named as a processor in the privacy policy |
| Lock-in to Cloudflare | Logic is plain TypeScript, the data is plain SQLite (dumps load into sqlite3), and the list contract is unchanged |
| JavaScript numbers are exact only to 2^53 | Today's IDs and timestamps fit; hashes stay as BLOBs; any future 64-bit counter is stored as text |
| Chrome Web Store review takes days to weeks | Staged publish; API compatible with N-1 versions; adapter fixes ship through signed config |
| Naming conflict | Clearance search before launch marketing |

Open questions, each with the default used if nobody answers:
- Public or private repo?
  Default: private, with merging the release PR as the approval.
  If public, add required reviewers on `production`.
- Does a `_redirects` rewrite to `/200` return 200.html with status 200 and no 307?
  Default: assert it in e2e; if not, add `/s/*` and `/appeal/*` to `run_worker_first` and return `env.ASSETS.fetch('/200')`.
- Does `httpRequestsAdaptiveGroups` include requests served by Workers Cache?
  Default: verify in staging.
  If not, `/v1/stats` shows the last known estimate until Workers Cache analytics ships.
- Does Age carry between cache tiers?
  Default: assume it does not; the 15 s TTL keeps the worst case at about 41 s either way.
- What are the minimum account-owned token permissions?
  Default: the scope in section 5, verified with `--dry-run` and the first deploy.
- Should a packages/shared change also release the extension?
  Default: it releases with the platform; a change that affects the extension also touches `extension/`, or uses a `Release-As` footer.
- Opt into Chrome Web Store Verified CRX uploads?
  Default: no.
- EU data residency?
  Default: no; the Store uses the enam location hint.
- Off-Cloudflare backup copy against whole-account loss?
  Default: no; revisit once revenue exists.
- Is there existing production data to migrate?
  Default: no, the system is pre-launch and the first pass publishes.
  If there is data, run a one-time ops import of the Go SQLite file, keeping the current list head so installs do not re-download.