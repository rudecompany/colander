# Colander API on Cloudflare Workers

`@colander/api` is the TypeScript Worker that replaces the Go server in `server/`, following `docs/hosting-plan.md`.
`docs/contracts.md` stays the source of truth for every wire format.
This package is the foundation: the edge Worker, the `Store` Durable Object with the full schema, and the config for production and staging.
The Go server keeps serving everything else (and `make e2e`) until the port is complete and the parity harness passes.

## What exists

- `wrangler.jsonc`: the Worker `colander` on `getcolander.com` and `colander-staging` on `staging.getcolander.com`.
  It configures Workers Static Assets from `../web/build`, Workers Cache with `cross_version_cache`, the `Store` class (SQLite, migration `v1`), the R2 buckets, the `EMAIL` and `ALERTS` send bindings, the `MISSES` rate limiter, cron triggers, and logs without invocation logs or traces.
  Required secrets are `COLANDER_SIGNING_KEY` (base64 of the 32-byte Ed25519 seed), `IP_SALT` and `OPS_TOKEN`.
  `CF_ANALYTICS_TOKEN` is an optional secret: without it, or without the `CF_ZONE_ID` var, the hourly analytics pull is skipped with a log line.
  The `ALERTS` destination is a placeholder until the owner verifies the ops address in Email Routing; the `ALERT_ADDRESS` var must equal it (a config test checks).
  The local runtime refuses a send without `to`, so the address is repeated in that var.
- `src/index.ts`, the edge Worker, which runs only for `/v1/*`, `/ops/*`, `/healthz` and `/__dev/*` (static assets never reach it):
  - CORS preflights for the extension routes of contract section 6, answered without the Store.
  - The miss rate limiter, keyed by an HMAC of the client address with `IP_SALT`.
  - `GET /v1/list/snapshot` from R2 (`list/snapshot.bin`, sequence from `customMetadata.seq`), without the Store.
    When R2 has no valid snapshot it goes to the Store, which serves its head.
  - `GET /v1/list/delta` accepts only `?since=N` in canonical decimal, no later than now plus 60 seconds.
  - Everything else under `/v1/*` goes to `STORE.getByName("primary")` with the client address replaced by its hash; idempotent requests retry once when the Store restarts.
  - `/ops/*` checks `Authorization: Bearer <OPS_TOKEN>` in constant time.
  - `/__dev/*` reaches the Store only when `COLANDER_DEV=1`; otherwise it is an unknown path of the website.
  - Every response gets the security headers and `Cache-Control: no-store` unless a cache policy in `src/http.ts` applies, and logs carry the route pattern, status and duration only.
- `src/store/`, the `Store` Durable Object:
  - The constructor runs the migrations under `blockConcurrencyWhile`.
    `0001` to `0003` are byte-identical copies of `server/internal/store/migrations`, so the schema and data dumps match the Go server.
    `0004_store.sql` adds `limits` (token buckets) and `jobs` (alarm scheduling); the runner records versions in `_migrations` and ignores versions it does not know.
  - `db.ts` is the typed SQL layer: `run`, `all`, `get` and `tx`, which wraps `ctx.storage.transactionSync`, plus Go's store.go helpers (`newId`, `nullString`, `nullInt`, `placeholders`) and errors.
  - `accounts.ts`, `sources.ts`, `tags.ts`, `verdicts.ts`, `appeals.ts`, `list.ts` and `misc.ts` port `server/internal/store/*.go` one to one, with Go's names in camelCase and the same SQL.
    `billing.ts` holds the SQL that Go kept inside `internal/billing` (subscriptions, donations, Stripe events); the Stripe calls stay with the billing port.
    Every function takes the `Db` first and runs inside the caller's `tx` when there is one; each `s.Tx` became `db.tx(() => ...)`.
  - Lookups return `undefined` where Go returned `ErrNotFound`.
    Writes that Go failed with `ErrNotFound` or `ErrConflict` throw `NotFoundError` or `ConflictError`; `putSync` returns `{ blob, conflict }` because the conflict carries the current blob.
  - The internal router answers `GET /v1/list/delta` and `GET /v1/list/snapshot` (R2 misses), and `health()` serves `/healthz`.
  - `alarm()` runs the jobs; `watchdog()`, `recordAlerts()` and `setListRequests()` are the RPCs the crons call.
- `src/list/publisher.ts` ports `listfmt.Publisher` with `store.PublishList` (`src/store/list.ts`):
  - One `transactionSync` reads the rated targets, diffs them and records a sequence numbered `max(head + 1, unix seconds, R2 seq + 1)`, so no clock or restore makes it go backwards.
  - It then writes `list/snapshot.bin` to R2 with `customMetadata.seq` and `created`, and every run compares the head with R2: a lagging or lost object is rewritten without a new sequence, and an R2 ahead of the head (after a restore) gets a sequence above it.
  - `delta()` serves the coalesced delta: 200, 204 at the head, 410 for an unknown or expired base.
- `src/jobs.ts`: the `jobs` table and the one alarm, set to the earliest due job.
  A job name is its kind, or `kind:arg` (`rescore:<source ref>`).
  Only the Store named `primary` schedules or runs jobs, so a drill's scratch Store never acts on rows it loaded.
  A kind runs only once its handler is defined: `schedule()` ignores other kinds, and the alarm drops their rows.
  Each run leases the row for a minute (a crash runs it again), a failure retries after 30 seconds, and the alarm stays armed after every request that scheduled a job.
  Status for the watchdog and the pass cursor live in the Store's synchronous KV (`STATUS`).
  - `publish`: requested with `requestPublish(now)`, at most once per 10 seconds; the Store schedules it at start when it has jobs, which is the R2 reconciliation on start.
  - `prune`: hourly, expired magic links and sessions, list sequences past 30 days except the head (their changes cascade), and refilled rate limit buckets.
  - `pass`: `definePass(engine)` runs the full pass every 5 minutes in chunks of 1,000 sources per alarm turn, with the cursor in storage so requests interleave and a restart resumes; it records rows read per pass and requests a publication.
  - `rescore`: `touch(refs, now)` schedules `rescore:<ref>` 5 seconds after the first touch, and the job runs `engine.rescore(ref)`.
  - The pass interval and the debounce come from the scoring `Thresholds`.
  - `dump`: `defineDump(dump)` runs it at 03:17, 09:17, 15:17 and 21:17 UTC and records how long it blocked.
- `src/scoring/` ports `server/internal/scoring` file for file, with Go's names in camelCase:
  - `rules.ts`: every number of contracts section 9 in one `Thresholds` class (durations in milliseconds; `Default` holds the contract's values), the four layers and the verdict rules in order, and Go's signal and test masks as `Sig`, `TestBit`, `ProvenanceSignals` and `BehaviorSignals`, derived from the wire tables in `packages/shared`.
  - `reason.ts`: the plain-language decision log reasons and escalation summaries, word for word.
  - `engine.ts`: `Engine` with an injected clock (the Store's `now`).
    It implements `PassScorer` for the `pass` job (`startPass` expires appeals and loads reputation once per pass, kept across chunks and reloaded after a restart; `scoreSource` scores one source), `fullPass(now)` is Go's `FullPass` in one call for seeding and imports, `rescore(ref, cause?)` is the inline rescore the `rescore` job and the actions run, and `explain(ref)` with `evidence(ev)` serves the public and review pages.
    Each source is scored in one transaction: burst freeze, state updates with their log entries, item entries, report closing and escalations commit together.
  - `actions.ts`: `decide`, `verifyAppeal` and `resolveAppeal`, each one transaction with its inline rescore; the rescore asks for a publication when it changed something.
    `decide` throws `StaffRequiredError` for the curator limits of contract 6.7 (Go checked them in its review route; the route answers `403 staff_required` with the error's message) and `AIEvidenceRequiredError` for Slop or Likely slop without AI evidence (`400 ai_evidence_required`), and then writes nothing.
  - The routes call `jobs.touch(refs, now)` after reports, report dismissals and appeal changes, as Go called `Engine.Touch`; tags wait for the next pass.
- `src/limits.ts` ports the token buckets of `respond.go` onto the `limits` table: `allow(db, now, key, n, ...limiters)` returns 0 or the milliseconds to wait.
  Call it inside the `tx` of the write it guards, so a failed write gives the tokens back.
- `src/scheduled.ts`, the cron handler:
  - Every 5 minutes the watchdog RPC creates missing recurring jobs, re-arms a lost alarm, asks for a publication when R2 does not hold the head, and returns the status; alerts (`alerts()`, thresholds in `THRESHOLDS`) are mailed through `ALERTS` once each while they last, and a failed mail is retried at the next run.
  - At minute 7 of every hour it sets the last 6 whole hours of `/v1/list/*` requests on this host from `httpRequestsAdaptiveGroups` into `list_requests`.
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

`wrangler dev` reads local secrets from `api/.dev.vars`, which git ignores.
Create it with the published development key from `server/testdata/dev-signing.key`, the same key the extension trusts by default:

```sh
cd api
printf 'COLANDER_DEV=1\nIP_SALT=dev-ip-salt\nOPS_TOKEN=dev-ops-token\nCOLANDER_SIGNING_KEY=%s\n' "$(cat ../server/testdata/dev-signing.key)" > .dev.vars
pnpm -C ../web build
pnpm dev
```

Then `curl localhost:8787/healthz` answers `{"ok":true}`, and the website, `/s/...` and `/appeal/...` pages and the 404 page are served as in production.
Inspect or edit the Store's SQLite in Wrangler's Local Explorer at `http://localhost:8787/cdn-cgi/local/explorer` (the `colander-Store` namespace, object name `primary`).
Cron triggers do not fire locally; `curl "localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` runs the watchdog, which also makes the first publication, and `cron=7+*+*+*+*` the analytics pull.
Never put a production key in `.dev.vars`; production secrets are set with `wrangler secret put`.

## Tests

- `test/*.test.ts` run inside workerd with `@cloudflare/vitest-plugin`: the schema against the Go migrations, migration restarts, `tx` rollback, the router, CORS, `since`, the miss limiter, `/ops/*`, `/__dev/*`, header hygiene, logging, and cache headers on snapshot 200 and delta 200, 204 and 410.
  - `data.test.ts` covers the store ports (Go's `store_test.go` and the behavior of each file), `limits.test.ts` the token buckets, `publisher.test.ts` publication, R2 reconciliation and sequence monotonicity across a simulated restore, `jobs.test.ts` the alarm through `runDurableObjectAlarm`, `rules.test.ts` and `engine.test.ts` the scoring engine (Go's `rules_test.go` and `engine_test.go`, the curator limits, the debounced rescore and a reviewer decision between two chunks of a pass), and `scheduled.test.ts` the watchdog, its alerts and the analytics pull.
- `../packages/shared/test/*.test.ts` run inside workerd too, so the list encoder, signing and canonical IDs are proven in the runtime that serves them, not only in Node.
- `test/harness/*.test.ts` run in Node: `site.test.ts` drives the whole Worker with its static assets through `createTestHarness` from Wrangler, and `config.test.ts` guards `wrangler.jsonc` for both environments.
- A developer's `.dev.vars` never changes test results: the tests pass their own secrets.

## What the port must add

- `backup.ts`, registered with `this.jobs.defineDump(dump)`; the watchdog alerts on dump age and duration once it exists.
- Every other route of contract section 6, with the cache policies of hosting plan section 2 added to `src/http.ts`: adapter config (edge `max-age=300, stale-if-error=86400`) and `public, max-age=60` for `/v1/sources/*`, `/v1/log`, `/v1/stats` and `/v1/supporters`.
  Routes that write take their quota with `allow()` in the same `tx`.
- `/__dev/seed` for the e2e suite, and the ops commands behind the existing `/ops/*` guard.
- YouTube enrichment at the start of each pass, in `Engine.startPass` before the reputation load and outside any transaction, as Go's `FullPass` did.
- Mail (Email Sending with the Resend fallback), Stripe billing, YouTube, backups and restore drills, and the parity harness against the Go server.
