# Colander full-stack tests

This suite runs the Worker in `api/` under `wrangler dev`, the built website and the built extension together in Chromium, with no mocks between them.
The unit and end-to-end suites in `api/`, `web/` and `extension/` each mock the other parts; this one proves the parts agree.

## Run it

```sh
pnpm install          # at the repository root, once
make e2e              # or: pnpm -C e2e test
```

You need Node 24 and Playwright's Chromium (`pnpm -C web exec playwright install chromium`).
On Linux without a display, run it as `xvfb-run -a make e2e`, as CI does.
A run takes about two minutes, most of it building.

## What happens

Global setup (`tests/global-setup.ts`) does the following, every run.

1. Finds a free port from 8791 up (`COLANDER_E2E_PORT` picks the first one to try), with the inspector on the port 100 above (or `COLANDER_E2E_INSPECTOR_PORT`), so it never meets a dev server on 8787.
2. Builds the website and copies it into `e2e/.run/site`, so a web test run that rebuilds `web/build` cannot change it underneath; `wrangler dev` serves that copy with `--assets`.
3. Builds the extension in e2e mode into `e2e/.run/extension` (`COLANDER_EXT_OUT_DIR`), with `WXT_COLANDER_API` and `WXT_COLANDER_SITE` pointing at that port, so it never overwrites the extension package's own e2e build, which points at a mocked API.
4. Starts `wrangler dev --test-scheduled` with local state in `e2e/.run/state`, `COLANDER_DEV=1` and the development key from `e2e/.run/dev.vars` (`--env-file`, so a developer's `api/.dev.vars` never applies), and without any Stripe, YouTube or Resend keys.
5. Seeds it through `POST /__dev/seed`, settles it through `POST /__dev/settle` (publish, full pass, publish, as the Go server did on start), and runs the watchdog cron through `/cdn-cgi/local/scheduled`, which schedules the recurring jobs.
6. Makes `ada@colander.test` admin through the ops channel, gets a staff Access token from the dev stub for checks made from Node, and stops `wrangler dev` (its whole process group) when the run ends.

The stack serves http://localhost and the admin host http://admin.localhost on one port, from `api/wrangler.dev.json` (no routes, so Wrangler keeps the host); passkeys come from Chromium virtual authenticators.
The `wrangler dev` output, including the sign-in codes and appeal emails dev mode prints, is in `e2e/.run/server.log` after a run.
Dev mode differs from production in two ways the journeys rely on, both in `api/src/index.ts`: the miss rate limiter is off, because a local runtime has no edge cache and every request would count as a miss, and the edge counts list requests itself, because local runtimes have no analytics.
Each spec file starts its own Chromium profile with the extension loaded, so every journey begins with a fresh install.
YouTube pages come from the extension's saved fixtures on their real hostname, with channel links rewritten so each card points at a seeded channel.
Specs run one at a time in file order, because they share one Worker.
Screenshots of key moments go to `e2e/screenshots/`, which is not committed.

## Against staging

`COLANDER_E2E_BASE_URL=https://staging.getcolander.com pnpm -C e2e test` builds and starts nothing and runs `07-edge` against that origin; the journeys skip, because they need the seeded data, dev mail and the server log.
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` pass Cloudflare Access.
The appeal timing needs staff on the admin host, so it runs on the local stack only; against a deployed origin the command is a read-only smoke test.

## What it proves

| Spec | Journey |
| --- | --- |
| `01-blocking-tagging-privacy` | The install downloads the server's signed snapshot, and Options shows its sequence and size. On a search page, the Slop and Likely slop channels are hidden without a trace, AI-made and Disputed are labeled, YouTube's own AI label gives AI-made, and Clear is untouched. The popup still counts and lists both hidden items, and Why from its row opens on the card. No AI from the popup re-applies within 1 second without a reload. |
| | Tag, then Slop, hides the card at once; Done sends the menu's one tag, and the server counts it on that video in the review API; the request holds only contract fields and no page address. |
| | Privacy audit over both journeys: every request the service worker and extension pages made is a contract section 8 endpoint on the server, list downloads carry no `Authorization` or cookie, nothing carries a page URL, content scripts make no requests, and the Worker's log holds neither the install ID, its hash, nor the tagged IDs. |
| `02-report-review-appeal` | A Report source from the channel page, with examples and a reason, shows Under review in My reports. Staff sign in on the admin host, decide Slop in the admin console, and the log shows it. Sync now brings the new list, the open page hides the card without a reload, and My reports shows Slop and how many installs it protects. |
| | The creator appeals on the source page, gets a code by email, and asks to verify. Staff confirm the code by hand in the admin console, the source page and log show Disputed, and the extension takes the change as a delta, showing the Disputed chip instead of hiding the card. The upheld appeal sets Clear and the card is left alone. |
| `03-curator` | Staff invite the curator to a passkey; the console tells the curator up front that large sources and appeals need staff, the server answers `403 staff_required` when that is forced, and the side panel, connected with a reviewer code from the account page, lets the curator decide a source they may decide. |
| `04-sidepanel` | An admin invites a staff member to a passkey; they show a reviewer code on the account page and type it into the side panel. The account page says which version and browser took it, the claim carries only the code, the version and the browser, the panel loads the real queue with the 7-day reviewer token and acts with curator authority, leaving a large source to the admin console, its decision appears in the decision log, and disconnecting on the account page ends the token. |
| `05-trial-plus` | The 14-day trial starts from Options with no card, the server's token unlocks topics and per-platform strictness, the YouTube level applies on the page, and settings sync round-trips through `/v1/sync`: a push, a stale write refused with `409`, another browser's change pulled back without an echo, and the retired Strict level from an older browser arriving as Standard and written back as Standard. |
| `06-plans` | With billing switched off, Get Plus signs in with an emailed code on the same page and then shows the calm checkout-not-open message, with no script error or CSP violation. |
| `07-edge` | Source and appeal pages (`/s/{platform}/{id}`, `/appeal/{platform}/{id}`, `/appeal/status/{id}`) answer the app shell with 200, and every other path, an unknown platform, an extra segment and the shell's own `/200` and `/404` included, a real 404 with the shell, and unknown API paths the JSON 404. Static pages carry the `_headers` security headers, and hashed assets are cached for a year. The snapshot 200, the delta 204 at the head and 410 past it carry their cache policies (with `Cloudflare-CDN-Cache-Control` locally, where no edge consumes it). A verified appeal reaches a client as a signed delta in under 60 seconds, and that delta 200 carries the list policy. |
| `08-pairing` | Pat, the seeded member with Plus, shows a code on the account page and types it into Options under Plan: Plus turns on with a paid token for Pat's account, settings sync starts, per-platform strictness applies on the page, and the same code is refused a second time. |
| `09-stores` | The website is built with the Chrome, Edge and Firefox listings. Edge, Firefox and Chrome each get their own store on the install button, and the line under it and the footer name the other two stores in order once the page switches to that browser's store. |
| `10-auth` | A member signs in with an emailed code, adds a passkey and signs in with it; a new curator has member rights from a code until an invite adds a passkey; staff work on the admin host through the dev Access stand-in, whose token opens nothing on the main host. |

## Writing more

Use `launch()` and `onboard()` from `tests/harness.ts` for a fresh install, and `signIn()` for the website.
`ext.seen` records every request the browser makes, with who made it.
`stack.ts` has Node-side helpers: `api` and `http` (with the Access headers), `asStaff` for review checks, `mailsSince` for dev-mode emails, `serverLog` for what the Worker logged, and `publishedAfter` to wait for the next list publication, which the Worker makes at most once per 10 seconds.
A spec that needs the local stack starts with `test.skip(!!BASE_URL, LOCAL_ONLY)`.
