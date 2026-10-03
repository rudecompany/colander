# Colander website

The public website, account pages and review console for Colander.
It is a SvelteKit 3 app (Svelte 5 runes, TypeScript strict) built with `@sveltejs/adapter-static` into `web/build`.
The Go server serves that folder and the API from the same origin, so every page calls relative `/v1/...` URLs.

## Routes

| Route | What it is | Rendering |
| --- | --- | --- |
| `/` | Landing page with a live demo of the strictness table | Prerendered, live log and stats fetched in the browser |
| `/definition` | The published definition, rubric, verdicts, strictness and safeguards | Prerendered |
| `/s/{platform}/{id}` | Public source page, with a Not rated state | SPA fallback |
| `/appeal/{platform}/{id}` | Start an appeal | SPA fallback |
| `/appeal/status/{id}?secret=` | Appeal code, instructions, Verify and status | SPA fallback |
| `/log` | The decision log, with platform and verdict filters and a cursor | Prerendered shell |
| `/plans` | Free, Plus, Family and Supporter, with checkout; `?cancelled=1` after a closed checkout | Prerendered shell |
| `/plans/welcome` | Checkout success: waits for the plan, then connects this browser | Prerendered shell |
| `/support` | Donations, once or monthly; `?cancelled=1` after a closed payment | Prerendered shell |
| `/support/thanks` | Donation success | Prerendered |
| `/supporters` | Credited supporters | Prerendered shell |
| `/transparency` | Live list numbers, funding, independence rules, expiry | Prerendered shell |
| `/account` | Sign-in, plan, cancel, connect this browser, reviewer token | Prerendered shell |
| `/auth/callback?token=&next=` | Finishes an emailed sign-in link | Prerendered shell |
| `/console` | Review console for curators and staff | Prerendered shell |
| `/privacy`, `/terms` | Policies | Prerendered |

`{platform}` is `yt`, `tt`, `ig` or `fb` (matched in `src/params.ts`); anything else is a 404.
Support and donation links never appear on `/s/*` or `/appeal/*` pages, including the footer.

### What the server needs to do

- Serve `build/` with this lookup order: the file itself, then `{path}.html`, then `{path}/index.html`, then `200.html`.
  `tests/static-server.ts` implements exactly this and is what the tests run against.
- `200.html` is the SPA fallback for source and appeal pages and for unknown paths (the client renders the 404 page).
- Each page carries its Content Security Policy as a `<meta http-equiv>` tag with script hashes.
  The server may also send `frame-ancestors 'none'` as a header, which a meta tag cannot carry.

## Environment

Variables are declared in `src/env.ts` and inlined at build time.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_EXTENSION_ID` | empty | Chrome extension ID that receives `colander:plan-token` and `colander:reviewer-token` messages. When empty, the account page reports the extension as not installed. |
| `PUBLIC_STORE_URL` | `https://chromewebstore.google.com/search/Colander` | Where every Add to Chrome button points. |
| `COLANDER_API` | `http://localhost:8787` | Dev only: where `vite dev` proxies `/v1`. |

## Develop

```sh
pnpm install                 # at the repository root
pnpm -C web dev              # http://localhost:5173, /v1 proxied to the Go server on :8787
```

Run the server with `COLANDER_DEV=1` so sign-in links are printed to its stdout.
Set `COLANDER_PUBLIC_URL=http://localhost:5173` on the server so those links open the dev site.

## Build and check

```sh
pnpm -C web check            # svelte-kit sync and svelte-check
pnpm -C web build            # writes web/build
```

## Tests

```sh
pnpm -C web test             # builds, serves build/ like the Go server, runs Playwright in Chromium
pnpm -C web screenshots      # full-page screenshots of every page into web/screenshots
```

Every test mocks `/v1` with `page.route` using fixtures typed by `packages/shared/src/api.ts` (`tests/mocks.ts`).
A shared fixture fails any test that logs a page error or a CSP violation.

| Spec | Covers |
| --- | --- |
| `landing.spec.ts` | Hero, the demo following the strictness table, the live log preview |
| `source.spec.ts` | Source pages for all five verdicts, Not rated, unknown platforms, no support links |
| `appeal.spec.ts` | Start an appeal, copy the code, Verify, every status, missing secret |
| `log.spec.ts` | Platform and verdict filters, address sync, load more with the cursor |
| `account.spec.ts` | Email sign-in and callback, safe `next`, connect this browser, one-click cancel at period end, then end now and refund, `409 not_refundable` |
| `plans.spec.ts` | Yearly preselected, `503 billing_unavailable`, sign-in before checkout, redirect, closed checkout, `409 already_subscribed`, the welcome page |
| `support.spec.ts` | Donation body and redirect, custom amounts and limits, `503 billing_unavailable`, closed payment |
| `console.spec.ts` | Keyboard queue, evidence, decision body and CSRF header, curator limits and `403 staff_required` |
| `a11y.spec.ts` | axe WCAG 2.2 A and AA rules on every page, light and dark |

The committed screenshots in `screenshots/` are reduced to 256 colors to keep the repository small.
`pnpm -C web screenshots` writes full-color ones.

## Structure

- `src/app.css` is the web layer over the shared theme (`@colander/shared/styles/tokens.css` and `colander.css`): layout, the type ramp plus a hero size, controls sized for the web, and stacked tables on phones.
- `src/lib/api.ts` is the fetch wrapper. Every non-GET request sends `X-Colander-CSRF: 1`.
- `src/lib/extension.ts` detects the extension with `colander:ping` and sends tokens with `chrome.runtime.sendMessage`.
- `src/lib/components/` holds the site pieces; `console/` holds the evidence view and the decision form.
- Icons come from `@lucide/svelte` deep imports at 14 to 16 px, stroke 1.75, always beside a word.
