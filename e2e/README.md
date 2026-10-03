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
