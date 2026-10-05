# Colander API on Cloudflare Workers

`@colander/api` is Colander's whole backend: one TypeScript Worker, following `docs/hosting-plan.md`.
`docs/contracts.md` stays the source of truth for every wire format.
It holds the edge Worker, the `Store` Durable Object with the full schema and every API route of contract section 6, and the config for production and staging.
`make e2e` runs the full-stack suite against it through `wrangler dev`.
It was ported from the Go server file for file and test for test.
Before the Go code was deleted, a parity harness drove both through the same story from fresh state with a frozen clock, and they agreed on every step: stored tables, API answers and signed list bytes, apart from the sequence numbering and list request counting that differ by design.
The Go server stays in git history: the parent of the commit that `git log -1 --diff-filter=D -- server/go.mod` shows still has it, and references below to Go's files and names point there.

## What exists

- `wrangler.jsonc`: the Worker `colander` on `getcolander.com` and `colander-staging` on `staging.getcolander.com`.
  It configures Workers Static Assets from `../web/build`, Workers Cache with `cross_version_cache`, the `Store` class (SQLite, migration `v1`), the R2 buckets, the `EMAIL` and `ALERTS` send bindings, the `MISSES` rate limiter, cron triggers, and logs without invocation logs or traces.
  Required secrets are `COLANDER_SIGNING_KEY` (base64 of the 32-byte Ed25519 seed), `IP_SALT` and `OPS_TOKEN`.
  `CF_ANALYTICS_TOKEN` is an optional secret: without it, or without the `CF_ZONE_ID` var, the hourly analytics pull is skipped with a log line.
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` and `YOUTUBE_API_KEY` are optional secrets: without the Stripe keys every `/v1/billing/*` route answers `503 billing_unavailable`, without the Resend key mail has no fallback, and without the YouTube key passes skip YouTube lookups and appeals wait for staff to check by hand.
  The vars `COLANDER_MAIL_FROM`, `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY` and `STRIPE_MANAGED_PAYMENTS` (empty means on, `0` off) configure mail and billing; `STRIPE_API_BASE` may point Stripe calls elsewhere.
  `YOUTUBE_DAILY_UNITS` (default `8000`; `7000` in production and `1000` in staging, which share one Google Cloud project) caps the Data API units spent per Pacific day, and `YOUTUBE_DERIVED_USE` stays empty until YouTube approves derived metrics; a config test checks both environments and that their budgets add up to 8,000 at most (contracts 9.7).
  The `ALERTS` destination is a placeholder until the owner verifies the ops address in Email Routing; the `ALERT_ADDRESS` var must equal it (a config test checks).
  The local runtime refuses a send without `to`, so the address is repeated in that var.
- `src/index.ts`, the edge Worker, which runs only for `/v1/*`, `/ops/*`, `/healthz` and `/__dev/*` (static assets never reach it):
  - CORS preflights for the extension routes of contract section 6, answered without the Store.
  - The miss rate limiter, keyed by an HMAC of the client address with `IP_SALT`.
    An IPv6 address counts by its /64 (`ipKey` in `src/http.ts`), here and in every per-address quota of the Store, so rotating through one's own /64 does not escape them.
    Dev mode (`COLANDER_DEV=1`) goes without it, because a local runtime has no edge cache and every request would count as a miss.
  - In dev mode, every `GET` or `HEAD` of `/v1/list/snapshot` and `/v1/list/delta` is counted into `list_requests` (`Store.countListRequest`), as the Go server did, because local runtimes have no edge analytics.
  - `GET /v1/list/snapshot` from R2 (`list/snapshot.bin`, sequence from `customMetadata.seq`), without the Store.
    When R2 has no valid snapshot or cannot be read it goes to the Store, which serves its head.
  - `GET /v1/list/delta` accepts only `?since=N` in canonical decimal, no later than now plus 60 seconds.
  - The other cached GETs accept only their canonical query, since Workers Cache keys on the full URL and junk parameters would make every request a miss that runs the Store: none on the snapshot, `/v1/config/adapters`, `/v1/sources/*`, `/v1/stats` and `/v1/supporters` (`400 invalid_query`), and on `/v1/log` only `limit`, `platform`, `verdict` and `cursor`, each once and in that order (the website's), with canonical values (the Store's own error codes).
  - Everything else under `/v1/*` goes to `STORE.getByName("primary")` with the client address replaced by its hash; idempotent requests retry once when the Store restarts.
  - `/ops/*` checks `Authorization: Bearer <OPS_TOKEN>` in constant time.
  - `/__dev/*` reaches the Store only when `COLANDER_DEV=1`; otherwise it is an unknown path of the website.
  - Every response gets the security headers and `Cache-Control: no-store` unless a cache policy in `src/http.ts` applies, and logs carry the route pattern, status and duration only.
- `src/store/`, the `Store` Durable Object:
  - The constructor runs the migrations under `blockConcurrencyWhile`.
    `0001` to `0003` are the Go server's migrations, byte for byte, so its schema and data carry over.
    `0004_store.sql` adds `limits` (token buckets) and `jobs` (alarm scheduling); the runner records versions in `_migrations` and ignores versions it does not know.
    `0005_compliance.sql` adds `youtube_channels` (Data API figures, kept under 30 days), the `youtube_quota` ledger, `seed_imports` (each import run, for audits) and the staff-only `decision_log.reason_original`, and empties the unused `youtube_cache`.
    Its data changes are code, `complianceData` in `src/store/compliance.ts`, which `migrate` runs after the SQL and a restore runs again on the rows of a dump taken before it (each migration's `data`, through `restoredData`).
    They rewrite the seed list clause of old scoring reasons to "It met a rule Colander no longer uses", put `[withheld]` in place of a list's name in anyone else's words (keeping the original in `reason_original`), clear imports from before the license check (one `seed_imports` row per list keeps their count and a hash of their IDs, with `cleared_at`), and drop stored API titles and figures.
    `0008_seeds.sql` adds `seed_entries` (what each registry entry lists now, with the staff note of Colander's own lists), the registry fields of `seed_imports`, `sources.seed_suppressed_at`, the calibration set (`calibration_items`, `calibration_labels` with each label's language and kind), and `seed_provenance_reads`, the audit of staff reads of seed provenance.
    It is 0008 so that 0006 and 0007 stay free for work landing beside it: the runner applies whatever version it lacks, in list order, and a dump's first line names every migration it holds, so a restore runs the data changes of exactly the ones it lacks.
  - `seeds.ts` holds the registry as this Worker uses it (`SeedRegistry`, dev mode deciding whether `dev_only` entries count), the live leads of a source, import plans and their one-transaction apply, revocation (with what calibration sampled from the list), the daily expiry, suppression, the dataset name check, the audit of staff provenance reads, and the cleanup of sources that only a list made; `calibration.ts` holds the calibration set.
  - `db.ts` is the typed SQL layer: `run`, `all`, `get` and `tx`, which wraps `ctx.storage.transactionSync`, plus Go's store.go helpers (`newId`, `nullString`, `nullInt`, `placeholders`) and errors.
  - `accounts.ts`, `sources.ts`, `tags.ts`, `verdicts.ts`, `appeals.ts`, `list.ts` and `misc.ts` port Go's `internal/store/*.go` one to one, with Go's names in camelCase and the same SQL.
    `billing.ts` holds the SQL that Go kept inside `internal/billing` (subscriptions, donations, Stripe events); the Stripe calls stay with the billing port.
    Every function takes the `Db` first and runs inside the caller's `tx` when there is one; each `s.Tx` became `db.tx(() => ...)`.
  - Lookups return `undefined` where Go returned `ErrNotFound`.
    Writes that Go failed with `ErrNotFound` or `ErrConflict` throw `NotFoundError` or `ConflictError`; `putSync` returns `{ blob, conflict }` because the conflict carries the current blob.
  - The internal router answers every route of contract section 6 that the edge forwards (the snapshot only on R2 misses) and the dev-only `/__dev/*` routes, and `health()` serves `/healthz`.
  - `alarm()` runs the jobs; `watchdog()`, `recordAlerts()` and `setListRequests()` are the RPCs the crons call.
- `src/list/publisher.ts` ports `listfmt.Publisher` with `store.PublishList` (`src/store/list.ts`):
  - One `transactionSync` reads the rated targets, diffs them and records a sequence numbered `max(head + 1, unix seconds, R2 seq + 1)`, so no clock or restore makes it go backwards.
  - It then writes `list/snapshot.bin` to R2 with `customMetadata.seq` and `created`, and every run compares the head with R2: a lagging or lost object is rewritten without a new sequence, and an R2 ahead of the head (after a restore) gets a sequence above it.
  - `delta()` serves the coalesced delta: 200, 204 at the head, 410 for an unknown or expired base.
    Encoded deltas to the head are kept in memory by base, up to 256 and then started over, as Go's Publisher did.
  - Publications run one at a time, so R2 never ends on an older sequence than the head when two overlap (a restore's publish and the start-up job).
  - A Store with no list while R2 holds one (its data was lost) publishes nothing and answers sequence 0, rather than an empty list above R2 that every install would take; the watchdog alerts `store_empty`.
    A restore-dump brings the list back; deleting `list/snapshot.bin` from the lists bucket starts from an empty list on purpose.
- `src/jobs.ts`: the `jobs` table and the one alarm, set to the earliest due job.
  A job name is its kind, or `kind:arg` (`rescore:<source ref>`).
  Only the Store named `primary` schedules or runs jobs, so a drill's scratch Store never acts on rows it loaded.
  A kind runs only once its handler is defined: `schedule()` ignores other kinds, and the alarm drops their rows.
  Each run leases the row for a minute (a crash runs it again), a failure retries after 30 seconds, and the alarm stays armed after every request that scheduled a job.
  Status for the watchdog and the pass cursor live in the Store's synchronous KV (`STATUS`).
  - `publish`: requested with `requestPublish(now)`, at most once per 10 seconds; the Store schedules it at start when it has jobs, which is the R2 reconciliation on start.
    A refused publication (sequence 0) records no publish status.
  - `prune`: hourly, expired magic links and sessions, list sequences past 30 days except the head (their changes cascade), refilled rate limit buckets, the synced settings of ended install trials, which no token can read again (the trial rows stay, so each install still gets one trial), and YouTube Data API data 29 days old, with ledger days as old.
  - `pass`: `definePass(engine)` runs the full pass every 5 minutes in chunks of 1,000 sources per alarm turn, with the cursor in storage so requests interleave and a restart resumes; it records rows read per pass and requests a publication.
  - `rescore`: `touch(refs, now)` schedules `rescore:<ref>` 5 seconds after the first touch, and the job runs `engine.rescore(ref)`.
  - The pass interval and the debounce come from the scoring `Thresholds`.
  - `dump`: `defineDump(dump)` runs it at 03:17, 09:17, 15:17 and 21:17 UTC and records how long it blocked and its SQL and gzip sizes.
    A failed try is retried after 2, 4, 8 ... minutes, at most an hour apart, instead of after 30 seconds, since each try blocks the Store; a try is counted before it starts, so one the platform cut short backs off too.
- `src/scoring/` ports Go's `internal/scoring` file for file, with Go's names in camelCase:
  - `rules.ts`: every number of contracts section 9 in one `Thresholds` class (durations in milliseconds; `Default` holds the contract's values), the four layers and the verdict rules in order, and Go's signal and test masks as `Sig`, `TestBit`, `ProvenanceSignals` and `BehaviorSignals`, derived from the wire tables in `packages/shared`.
  - `reason.ts`: the plain-language decision log reasons and escalation summaries; a reason never mentions a seed list.
  - Seed list entries are review leads, never evidence (contracts 9.3): they are no input to the rules, flag bit 5 stays 0, and the engine only raises a `seed` escalation while a live registry entry names the source, no reviewer has decided it and staff have not suppressed seed lists on it.
  - `Engine.derived` (`YOUTUBE_DERIVED_USE`) gates every YouTube figure: off, `audience()` knows a source's size only from staff, and uploads per day never reaches the rules.
  - `engine.ts`: `Engine` with an injected clock (the Store's `now`).
    It implements `PassScorer` for the `pass` job (`startPass` expires appeals and loads reputation once per pass, kept across chunks and reloaded after a restart; `scoreSource` scores one source), `fullPass(now)` is Go's `FullPass` in one call for seeding and imports, `rescore(ref, cause?)` is the inline rescore the `rescore` job and the actions run, and `explain(ref)` with `evidence(ev)` serves the public and review pages.
    Each source is scored in one transaction: burst freeze, state updates with their log entries, item entries, report closing and escalations commit together.
  - `actions.ts`: `decide`, `verifyAppeal` and `resolveAppeal`, each one transaction with its inline rescore; the rescore asks for a publication when it changed something.
    `decide` throws `StaffRequiredError` for the curator limits of contract 6.7 (Go checked them in its review route; the route answers `403 staff_required` with the error's message) and `AIEvidenceRequiredError` for Slop or Likely slop without AI evidence (`400 ai_evidence_required`), and then writes nothing.
  - The routes call `jobs.touch(refs, now)` after reports, report dismissals and appeal changes, as Go called `Engine.Touch`; tags wait for the next pass.
- `src/limits.ts` ports the token buckets of `respond.go` onto the `limits` table: `allow(db, now, key, n, ...limiters)` returns 0 or the milliseconds to wait.
  Call it inside the `tx` of the write it guards, so a failed write gives the tokens back.
  Beyond Go's quotas, `trial_ip` allows 5 trials per address a day, and `appeal_verify` and `appeal_verify_ip` allow 10 automatic YouTube checks per appeal and 30 per address an hour, since each is a live Data API call.
- `src/auth.ts` ports `internal/auth`: magic links, sessions in the `colander_session` cookie (HttpOnly, SameSite=Lax, Secure outside dev), reviewer tokens, install ID hashing, the email and redirect checks, CSRF, and `session(auth, request)`, which answers `403 csrf_required` or `401 signed_out`.
  It is synchronous, so it runs inside the caller's `tx`; `finishSignIn` consumes the link and creates the session in one transaction.
  `POST /v1/auth/verify` needs the CSRF header too, unlike Go's, so a cross-site form cannot sign a visitor into another account (login CSRF).
  The Store keeps one `Auth` as `store.auth`; review routes find bearer reviewers with `store.auth.reviewerAccount(token)`.
- `src/mail.ts` ports `internal/mail` (`Mailer` and the sign-in, appeal and Plus templates): it sends through the `EMAIL` binding, then through Resend on any binding error, and with `COLANDER_DEV=1` prints the block `e2e/tests/stack.ts` parses instead of sending.
- `src/billing.ts` ports `internal/billing` over `fetch` with `Stripe-Version: 2026-04-22.dahlia`: Managed Payments checkout, donations, cancel and refund, entitlements and the webhook, whose signature is checked with WebCrypto HMAC.
  The webhook reads the objects from Stripe first, then applies every write and records the event id in one transaction.
  Paying never reaches scoring, tags, reports or review: `test/harness/independence.test.ts` walks their imports.
- `src/routes/` ports Go's `internal/api` file for file, with Go's names in camelCase:
  - `server.ts` is Go's route table for the extension, public, appeal, review, sync and adapter config routes; `account.ts` and `billing.ts` hold the routes of contracts 6.6 and 6.8; the Store registers all three.
  - `respond.ts` holds bounded body reads, Go's request JSON decoding (unknown fields, trailing data, size limits, first error wins), and Go's string, time, URL and listfmt helpers; `ids.ts` the canonical ID checks.
  - The public GETs (`/v1/sources/*`, `/v1/log`, `/v1/stats`, `/v1/supporters`) are `public, max-age=60` and never read the session; `test/cache.test.ts` checks the policy of every route.
- `src/youtube.ts` ports `internal/youtube` over `fetch`, without Go's response cache, so stored figures are dated by the call that returned them: `Engine.startPass` looks up to `ENRICH_PER_PASS` (10) sources older than 20 days up again before the reputation load, outside any transaction, and appeal verification checks channel descriptions.
  Every call is charged to the Pacific day's `youtube_quota` row before it is made (`pacificDay`), and none is made past `YOUTUBE_DAILY_UNITS`; a `quotaExceeded` answer uses up the day.
  Background lookups stop at `BACKGROUND_SHARE` (80%) of the budget, so appeal checks keep the rest.
  A failing channel is logged and waits for its next refresh, a used-up budget ends the lookups, and only with derived use are subscriber counts and uploads per day fetched and kept, in `youtube_channels`.
  The API's channel title is never kept; dumps hold no rows of `youtube_cache` or `youtube_channels` (`API_DATA_TABLES` in `src/backup.ts`), and a restore keeps the larger count of each day in `youtube_quota`.
- `src/scheduled.ts`, the cron handler:
  - Every 5 minutes the watchdog RPC creates missing recurring jobs, re-arms a lost alarm, asks for a publication when R2 does not hold the head, and returns the status; alerts (`alerts()`, thresholds in `THRESHOLDS`) are mailed through `ALERTS` once each while they last, and a failed mail is retried at the next run.
  - When the Store does not answer the watchdog, it mails `store_unreachable` with the error, at most once an hour (remembered in the lists bucket under `watchdog/`), and the trigger still fails.
  - At minute 7 of every hour it sets the last 6 whole hours of `/v1/list/*` requests on this host from `httpRequestsAdaptiveGroups` into `list_requests`, and the Store remembers the last hour it set: the active install estimate sums the 24 whole hours up to it, where dev mode, which counts live, sums the 24 hours up to now as Go did.
- `src/ops.ts`, the ops channel of `docs/deploy.md` behind the `/ops/*` guard: `POST /ops/<command>` with a JSON object body.
  - `status` reads the heads in the Store and in R2, the pass and dump ages, the dump duration, the rows the last pass read, and `publish_lag_s`, how long the oldest list change not yet in R2 has waited (a sequence R2 lacks, or a verdict change after the head).
  - `grant-role` and `sign-config` behave as the Go binary's commands did, trimming as Go's `strings.TrimSpace` did and checking emails with the same code as the routes; `sign-config` signs the file byte for byte with the Worker's key.
  - The seed list commands are in `src/seeds.ts` (contracts 14.4 and 14.5): `import-seed` takes a registry ID the owner cleared, reads `seeds/<id>.json` from the backup bucket, checks the file against the registry's SHA-256 and the clearance records, parses it by the entry's format, and answers the change as counts, writing only with `"apply": true`; `revoke-seed`, `calibration-sample` and `calibration-export` complete them.
    The ops run log is public, so answers never name a channel.
  - `pitr-restore` (`at` typed again as `confirm`, in the last 30 days) calls `getBookmarkForTime` and `onNextSessionRestoreBookmark`, writes both bookmarks to the backup bucket under `pitr/<ISO time>.json`, and restarts the Store (`ctx.abort()`) in the same call, so an armed restore never waits for a later restart; the edge reads the bookmarks back for its answer.
    `restore-dump` (`confirm` equal to `key`) loads a dump into the Store, and the edge then restarts it.
    After either, the edge has the new instance publish above R2's sequence and purges Workers Cache through `ctx.cache`.
  - `drill` loads the newest dump into the scratch Store `drill`, runs `quick_check` and `foreign_key_check`, compares its row counts with primary's (`countsAgree`), requires the dump to be under 7 hours old, deletes the scratch data, and answers `"ok": true` or `500 drill_failed`.
  - `purge-cache` (`confirm: "purge-cache"`) purges Workers Cache; local runtimes have none and say so.
- `src/backup.ts`, the 6-hourly dump job (`jobs.defineDump`): plain SQL that stock `sqlite3` loads (the CREATE statements as created, one INSERT per row with its column names, indexes last, and no rows of the YouTube Data API tables), gzipped into equal 5 MiB parts inside `blockConcurrencyWhile` and uploaded as an R2 multipart object under `dumps/<ISO time>.sql.gz` after it.
  The blocking part never throws (a throw there would reset the object) and does no network I/O, so a slow or failing R2 never holds or resets the Store.
  A restore streams the dump through gzip and a line splitter into staging tables in batches of about 1 MB of SQL, then swaps every table's rows in one transaction; it keeps the Store's own schema and `_migrations`, so a dump from older code loads into newer code, and it refuses a dump without its final `COMMIT` and tables or columns it does not know.
- `src/dev.ts`, dev-only routes and the frozen test clock:
  - `POST /__dev/seed` ports `colander seed-dev` through the same store, engine and publisher calls, without a YouTube client as in Go and without YouTube figures (staff record the demo channels' sizes); `POST /__dev/settle` does what the Go server did when it started (publish, full pass, publish); `GET /__dev/dump` answers the backup's SQL uncompressed.
  - `COLANDER_TEST_NOW` (RFC 3339, honored only with `COLANDER_DEV=1`) freezes the Store's clock and the edge's `since` check, and then no job runs on its own: tests settle explicitly.
- `packages/shared` holds the list format, signing and canonical IDs used here and by the extension.

## Scripts

```sh
pnpm -C api dev          # wrangler dev on http://localhost:8787
pnpm -C api check        # generated types are current, then tsc for src, the workerd tests and the Node tests
pnpm -C api test         # builds web/, then Vitest inside workerd and in Node
pnpm -C api deploy:dry   # wrangler deploy --dry-run for production and for --env staging (needs web/build)
pnpm -C api types        # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

## Run it locally

From the repository root, `make dev` builds the website, writes `api/.dev.vars` when it is missing, and starts `wrangler dev` on port 8787; `make seed` then loads the demo data into it.
`wrangler dev` reads local secrets from `api/.dev.vars`, which git ignores.
To create it by hand, use the published development key in `testdata/dev-signing.key`, the same key the extension trusts by default:

```sh
cd api
printf 'COLANDER_DEV=1\nPUBLIC_URL=http://localhost:8787\nIP_SALT=dev-ip-salt\nOPS_TOKEN=dev-ops-token\nCOLANDER_SIGNING_KEY=%s\n' "$(cat ../testdata/dev-signing.key)" > .dev.vars
pnpm -C ../web build
pnpm dev
```

Then `curl localhost:8787/healthz` answers `{"ok":true}`, and the website, `/s/...` and `/appeal/...` pages and the 404 page are served as in production.
Inspect or edit the Store's SQLite in Wrangler's Local Explorer at `http://localhost:8787/cdn-cgi/local/explorer` (the `colander-Store` namespace, object name `primary`).
Cron triggers do not fire locally; `curl "localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` runs the watchdog, which also makes the first publication, and `cron=7+*+*+*+*` the analytics pull.
Sign-in links and other mail are printed in the `wrangler dev` output instead of being sent.
Never put a production key in `.dev.vars`; production secrets are set with `wrangler secret put`.

## Tests

- `test/*.test.ts` run inside workerd with `@cloudflare/vitest-plugin`: the schema against the one stock SQLite builds from the migration files, migration restarts, `tx` rollback, the router, CORS, `since`, the miss limiter, `/ops/*`, `/__dev/*`, header hygiene, logging, and cache headers on snapshot 200 and delta 200, 204 and 410.
  - `backup.test.ts` covers the dump round trip through gzip and R2 (equal multipart parts included, YouTube API rows left out), the SQL it writes, restores that refuse what they cannot load, rerun the data changes of newer migrations and keep the quota ledger, a restore of over 40 MB in batches, and a failing upload that leaves the Store running; `ops.test.ts` every ops command through the edge (`import-seed` refusing every entry the owner has not cleared, checking the object's hash and records, dry-running and applying, and `sign-config` against the contract fixture); `seeds.test.ts` the list formats, `revoke-seed`, the daily seeds job, and calibration sampling and export; `dev.test.ts` the seed (Go's `TestSeedDev`), settle and `COLANDER_TEST_NOW`.
  - `data.test.ts` covers the store ports (Go's `store_test.go` and the behavior of each file), `limits.test.ts` the token buckets, `publisher.test.ts` publication, R2 reconciliation and sequence monotonicity across a simulated restore, `jobs.test.ts` the alarm through `runDurableObjectAlarm`, `rules.test.ts` and `engine.test.ts` the scoring engine (Go's `rules_test.go` and `engine_test.go`, a seed alone never giving a list entry, the curator limits, the debounced rescore and a reviewer decision between two chunks of a pass), `store.test.ts` the migrations (the 0005 cleanup of old data included), and `scheduled.test.ts` the watchdog, its alerts and the analytics pull.
  - `routes.test.ts` ports Go's `api_test.go` and `ids_test.go` for the extension, public, appeal and review routes (public JSON never naming a dataset, staff-only seed provenance, suppression and blind calibration labels), `cache.test.ts` checks Cache-Control and CORS on every route of the Store's router (a route missing from its table fails it), and `youtube.test.ts` ports Go's `youtube_test.go` with enrichment and automatic appeal checks, plus the Pacific-day quota ledger, the derived-use gate and deletion before 30 days.
  - `account.test.ts` ports Go's sign-in, CSRF and reviewer token tests with the email checks against vectors from Go's `net/mail`, `mail.test.ts` the mailer and its fallback order, and `billing.test.ts` Go's `webhook_test.go` and `billing_test.go` against the in-memory Stripe in `stripe-fake.ts` (Go's `billingtest`).
- `../packages/shared/test/*.test.ts` run inside workerd too, so the list encoder, signing and canonical IDs are proven in the runtime that serves them, not only in Node.
- `test/harness/*.test.ts` run in Node: `site.test.ts` drives the whole Worker with its static assets through `createTestHarness` from Wrangler, `config.test.ts` guards `wrangler.jsonc` for both environments, `independence.test.ts` is Go's billing independence test, and `dev.test.ts` is the dump-compat check: it seeds with a frozen clock, loads the dump into stock SQLite with every table and index of the migration files, and runs `integrity_check` and `foreign_key_check`.
- A developer's `.dev.vars` never changes test results: the tests pass their own secrets.
