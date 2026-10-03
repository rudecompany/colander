# Colander full-stack tests

This suite runs the real Go server, the built website and the built extension together in Chromium, with no mocks between them.
The unit and end-to-end suites in `server/`, `web/` and `extension/` each mock the other parts; this one proves the parts agree.

## Run it

```sh
pnpm install          # at the repository root, once
make e2e              # or: pnpm -C e2e test
```

You need Go, Node 24 and Playwright's Chromium (`pnpm -C web exec playwright install chromium`).
On Linux without a display, run it as `xvfb-run -a make e2e`, as CI does.
A run takes about a minute, most of it building.

## What happens

Global setup (`tests/global-setup.ts`) does the following, every run.

1. Finds a free port from 8791 up, so it never meets a dev server on 8787.
2. Builds the server binary, the website with `PUBLIC_EXTENSION_ID` set to the dev extension ID, and the extension in e2e mode with `WXT_COLANDER_API` and `WXT_COLANDER_SITE` pointing at that port.
3. Builds the extension into `e2e/.run/extension` (`COLANDER_EXT_OUT_DIR`), so it never overwrites the extension package's own e2e build, which points at a mocked API.
4. Copies the website into `e2e/.run/site`, so a web test run that rebuilds `web/build` cannot change it underneath.
5. Seeds a fresh database with `seed-dev` and starts `serve` with `COLANDER_DEV=1` and the development key, without any Stripe, YouTube or Resend keys.
6. Signs in a staff session through the API for checks made from Node, and stops the server when the run ends.

The server log, including the sign-in links and appeal emails dev mode prints, is in `e2e/.run/server.log` after a run.
Each spec file starts its own Chromium profile with the extension loaded, so every journey begins with a fresh install.
YouTube pages come from the extension's saved fixtures on their real hostname, with channel links rewritten so each card points at a seeded channel.
Specs run one at a time in file order, because they share one server.
Screenshots of key moments go to `e2e/screenshots/`, which is not committed.

## What it proves

| Spec | Journey |
| --- | --- |
| `01-blocking-tagging-privacy` | The install downloads the server's signed snapshot, and Options shows its sequence and size. On a search page, the Slop channel is hidden, Likely slop is collapsed, AI-made and Disputed are labeled, YouTube's own AI label gives AI-made, and Clear is untouched. Strict from the popup re-applies within 1 second without a reload. |
| | Tag, then Slop, hides the card at once; Done sends the menu's one tag, and the server counts it on that video in the review API; the request holds only contract fields and no page address. |
| | Privacy audit over both journeys: every request the service worker and extension pages made is a contract section 8 endpoint on the server, list downloads carry no `Authorization` or cookie, nothing carries a page URL, content scripts make no requests, and the server log holds neither the install ID, its hash, nor the tagged IDs. |
| `02-report-review-appeal` | A Report source from the channel page, with examples and a reason, shows Under review in My reports. Staff sign in through the emailed link, decide Slop in the console, and the log shows it. Sync now brings the new list, the open page hides the card without a reload, and My reports shows Slop and how many installs it protects. |
| | The creator appeals on the source page, gets a code, and asks to verify. Staff confirm the code by hand in the console, the source page and log show Disputed, and the extension takes the change as a delta, showing the Disputed chip instead of hiding the card. The upheld appeal sets Clear and the card is left alone. |
| `03-curator` | The console tells a curator up front that large sources and appeals need staff, the server answers `403 staff_required` when that is forced, and the side panel lets the curator decide a source they may decide. |
| `04-sidepanel` | Staff connect the side panel from the account page through `externally_connectable`, the panel loads the real queue with the reviewer token, and its decision appears in the decision log. |
| `05-trial-plus` | The 14-day trial starts from Options with no card, the server's token unlocks topics and per-platform strictness, the YouTube level applies on the page, and settings sync round-trips through `/v1/sync`: a push, a stale write refused with `409`, and another browser's change pulled back without an echo. |
| `06-plans` | With billing switched off, Get Plus signs in through the emailed link and then shows the calm checkout-not-open message, with no script error or CSP violation. |

## Writing more

Use `launch()` and `onboard()` from `tests/harness.ts` for a fresh install, and `signIn()` for the website.
`ext.seen` records every request the browser makes, with who made it.
`stack.ts` has Node-side helpers: `api`, `asStaff` for review checks, `mailsSince` for dev-mode emails, and `publishedAfter` to wait for the next list publication, which the server makes at most once per 10 seconds.

## Parity with the Go server

`pnpm -C e2e parity` (`parity/run.ts`) proves the Worker in `api/` behaves as the Go server does, before `server/` is deleted (hosting plan section 4).
It builds the Go binary, starts it on 127.0.0.1:8845 and `wrangler dev` on 8846 (inspector 8946) from fresh state, both with `COLANDER_DEV=1` and the clock frozen by `COLANDER_TEST_NOW`, and drives them through the same story:

1. The demo data: `colander seed-dev` on one side, `POST /__dev/seed` on the other.
2. The operator commands: the Go binary's `grant-role`, `sign-config` and `import-seed` against `/ops/<command>`, including the ones that must fail.
3. A day later, the HTTP API (`parity/api.ts`): a burst of tags, every kind of tag the contract accepts and rejects, tag and report quotas, reports, a trial and settings sync, appeals with their per-address quota, staff and curator sign-in through the dev mail, the curator limits, decisions on sources and items, the appeal verified and denied, a report dismissed, and the public reads.
   Every answer is compared, once the values each side draws at random (IDs, appeal codes, secrets, trial subjects) are replaced and JSON keys are sorted.
4. The clock moves on 15, 40, 66, 80, 95 and 200 days, so appeals expire, the burst freeze thaws, list versions leave the 30-day window, and reviewer and community verdicts lapse and are scored again.

Each step ends the way the Go server starts (publish, full pass, publish): the harness restarts Go and calls `POST /__dev/settle` on the Worker, which runs no job on its own while the clock is frozen.
Then it compares:

- Every table both keep, row for row (`parity/compare.ts`), with install hashes, token hashes and random IDs replaced by what they point at: verdicts, signals, decision log reasons, escalations, report and appeal statuses and the rest.
  The Worker's state comes from `GET /__dev/dump`, loaded into stock SQLite, which must also pass `integrity_check`.
- The signed snapshot, and the delta from the step before and from the seed's first sequence, byte for byte once Go's sequence numbers are mapped onto the Worker's and the file is signed again (Ed25519 is deterministic).
  The Worker floors sequences to unix seconds where Go counted from 1, so the numbers differ by design; `list_sequences`, `list_changes` and `list_requests` (Go counts list requests in process, the Worker reads edge analytics) are not compared row by row.
- The list endpoints' edge cases: 204 at the head, 410 after it and for a sequence past the 30-day window, 400 for a malformed `since`.

A run takes about a minute.
It needs Go, Node 24 and `web/build` (built when missing), and it refuses to start while `api/.dev.vars` exists, because that file would override the harness's secrets.
`e2e/.run/parity/report.json` lists every difference, next to `go.log` and `worker.log`; the exit code is 1 when anything differs.
The API step needs the route ports in `api/`: without them it stops with a message saying so.
