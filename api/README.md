# Colander API on Cloudflare Workers

`@colander/api` is the TypeScript Worker that replaces the Go server in `server/`, following `docs/hosting-plan.md`.
`docs/contracts.md` stays the source of truth for every wire format.
This package is the foundation: the edge Worker, the `Store` Durable Object with the full schema, and the config for production and staging.
The Go server keeps serving everything else (and `make e2e`) until the port is complete and the parity harness passes.

## What exists

- `wrangler.jsonc`: the Worker `colander` on `getcolander.com` and `colander-staging` on `staging.getcolander.com`.
  It configures Workers Static Assets from `../web/build`, Workers Cache with `cross_version_cache`, the `Store` class (SQLite, migration `v1`), the R2 buckets, the `EMAIL` and `ALERTS` send bindings, the `MISSES` rate limiter, cron triggers, and logs without invocation logs or traces.
  Required secrets are `COLANDER_SIGNING_KEY` (base64 of the 32-byte Ed25519 seed), `IP_SALT` and `OPS_TOKEN`.
  The `ALERTS` destination is a placeholder until the owner verifies the ops address in Email Routing.
- `src/index.ts`, the edge Worker, which runs only for `/v1/*`, `/ops/*`, `/healthz` and `/__dev/*` (static assets never reach it):
  - CORS preflights for the extension routes of contract section 6, answered without the Store.
  - The miss rate limiter, keyed by an HMAC of the client address with `IP_SALT`.
  - `GET /v1/list/snapshot` from R2 (`list/snapshot.bin`, sequence from `customMetadata.seq`), without the Store.
  - `GET /v1/list/delta` accepts only `?since=N` in canonical decimal, no later than now plus 60 seconds.
  - Everything else under `/v1/*` goes to `STORE.getByName("primary")` with the client address replaced by its hash; idempotent requests retry once when the Store restarts.
  - `/ops/*` checks `Authorization: Bearer <OPS_TOKEN>` in constant time.
  - `/__dev/*` reaches the Store only when `COLANDER_DEV=1`; otherwise it is an unknown path of the website.
  - Every response gets the security headers and `Cache-Control: no-store` unless a cache policy in `src/http.ts` applies, and logs carry the route pattern, status and duration only.
- `src/store/`, the `Store` Durable Object:
  - The constructor runs the migrations under `blockConcurrencyWhile`.
    `0001` to `0003` are byte-identical copies of `server/internal/store/migrations`, so the schema and data dumps match the Go server.
    `0004_store.sql` adds `limits` (token buckets) and `jobs` (alarm scheduling); the runner records versions in `_migrations` and ignores versions it does not know.
  - `db.ts` is the typed SQL layer: `run`, `all`, `get` and `tx`, which wraps `ctx.storage.transactionSync`.
  - The internal router answers `GET /v1/list/delta` (200 with the signed coalesced delta, 204 at the head, 410 for an unknown or expired base) from `list_sequences` and `list_changes`, and `health()` serves `/healthz`.
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
Cron triggers do not fire locally; `curl "localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"` triggers one once the port adds the scheduled handler (until then it answers 500).
Never put a production key in `.dev.vars`; production secrets are set with `wrangler secret put`.

## Tests

- `test/*.test.ts` run inside workerd with `@cloudflare/vitest-plugin`: the schema against the Go migrations, migration restarts, `tx` rollback, the router, CORS, `since`, the miss limiter, `/ops/*`, `/__dev/*`, header hygiene, logging, and cache headers on snapshot 200 and delta 200, 204 and 410.
- `../packages/shared/test/*.test.ts` run inside workerd too, so the list encoder, signing and canonical IDs are proven in the runtime that serves them, not only in Node.
- `test/harness/*.test.ts` run in Node: `site.test.ts` drives the whole Worker with its static assets through `createTestHarness` from Wrangler, and `config.test.ts` guards `wrangler.jsonc` for both environments.
- A developer's `.dev.vars` never changes test results: the tests pass their own secrets.

## What the port must add

- `src/scheduled.ts`: the 5-minute watchdog (re-arm the alarm, status, deduplicated alerts through `ALERTS`) and the hourly analytics pull into `list_requests`.
  The crons are already configured, so `scheduled()` must exist before the first deploy.
- The Store's `alarm()` and a runner for the `jobs` table: the 5-minute scoring pass as resumable chunks, the 5-second rescore debounce, the 10-second publish floor, the 6-hourly dump and hourly pruning.
- List publication (`listfmt.Publisher.Publish` and `store.PublishList`): `seq = max(prev + 1, unix seconds)`, the R2 write with `customMetadata.seq` and `created`, and the start-up reconciliation with R2.
  The delta read path and its tables are here already; the R2 key is `SNAPSHOT_KEY` in `src/store/list.ts`.
- The token bucket limiter on the `limits` table (port of `respond.go`), taken in the same transaction as the write it guards.
- Every other route of contract section 6, with the cache policies of hosting plan section 2 added to `src/http.ts`: adapter config (edge `max-age=300, stale-if-error=86400`) and `public, max-age=60` for `/v1/sources/*`, `/v1/log`, `/v1/stats` and `/v1/supporters`.
- `/__dev/seed` for the e2e suite, and the ops commands behind the existing `/ops/*` guard.
- Mail (Email Sending with the Resend fallback), Stripe billing, YouTube, backups and restore drills, and the parity harness against the Go server.
