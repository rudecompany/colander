# Colander website

The public website, account pages and review console for Colander.
It is a SvelteKit 3 app (Svelte 5 runes, TypeScript strict) built with `@sveltejs/adapter-static` into `web/build`.
The Go server serves that folder and the API from the same origin, so every page calls relative `/v1/...` URLs.

## Routes

| Route | What it is | Rendering |
| --- | --- | --- |
| `/` | Landing page: the hero demo, live strip, Kapwing figures, verdicts, strictness, fair by design, open by default, privacy, comparison, plans and questions | Prerendered, live numbers refreshed in the browser |
| `/definition` | How Colander decides: the definition, tests, layers, verdicts, safeguards, strictness, signing, consensus, appeals and research | Prerendered |
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
- `404.html` is the same shell, written by `pnpm build`, for a host that answers unknown paths with status 404.
- Each page carries its Content Security Policy as a `<meta http-equiv>` tag with script hashes.
  The server may also send `frame-ancestors 'none'` as a header, which a meta tag cannot carry.

## Environment

Variables are declared in `src/env.ts` and inlined at build time.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_EXTENSION_ID` | empty | Chrome extension ID that receives `colander:plan-token` and `colander:reviewer-token` messages. When empty, the account page reports the extension as not installed. |
| `PUBLIC_STORE_URL` | `https://chromewebstore.google.com/search/Colander` | Where every Add to Chrome button points. |
| `COLANDER_API` | `http://localhost:8787` | Dev only: where `vite dev` proxies `/v1`. |
| `COLANDER_BUILD_API` | empty | Build only: an API origin, such as `http://127.0.0.1:8787`, to read `/v1/stats` and the latest decisions from at build. Pages prerender with those numbers and their time, then refresh them in place. Without it, live numbers appear once the page loads, and the build prints a warning: set it for every production build. |

## Develop

```sh
pnpm install                 # at the repository root
pnpm -C web dev              # http://localhost:5173, /v1 proxied to the Go server on :8787
```

Run the server with `COLANDER_DEV=1` so sign-in links are printed to its stdout.
Set `COLANDER_PUBLIC_URL=http://localhost:5173` on the server so those links open the dev site.

## Build and check

```sh
pnpm -C web check            # svelte-kit sync, svelte-check, and the token and date-format lint
pnpm -C web build            # checks the generated in-page tokens, then writes web/build
```

`scripts/lint-tokens.ts` fails on a hex color, `Intl.DateTimeFormat` or a locale date string anywhere in `src/`: colors are tokens and dates are formats from `@colander/shared`.

## Performance budget

`tests/budget.spec.ts` measures the production build the tests serve, and fails when a page goes over.

| Limit | Value |
| --- | --- |
| Requests on `/` | At most 40 |
| Images on `/` | The favicon and the 8 demo feed thumbnails only, about 100 KB in all |
| JavaScript, every route | At most 110 KB gzip |
| CSS on `/` | At most 24 KB gzip |
| Transfer on `/` | At most 300 KB with brotli |
| Landing length (`landing.spec.ts`) | At most 8,200 px at 1440 and 12,500 px at 390 |

The demo feed thumbnails are AI-generated illustrations (`packages/shared/src/assets/demo`), and every picture of the demo feed says so: "Thumbnails are AI-generated illustrations."
They stay files and are never inlined into the JavaScript.
`@colander/shared` is marked side-effect free, so a page loads only the components it uses, and modules that two or more pages share travel in one `common` chunk (`vite.config.ts`).

## Tests

```sh
pnpm -C web test             # builds, serves build/ like the Go server, runs Playwright in Chromium
pnpm -C web screenshots      # full-page screenshots of every page into web/screenshots
```

The test server listens on 4173; set `PORT` to move it when that port is taken.

Every test mocks `/v1` with `page.route` using fixtures typed by `packages/shared/src/api.ts` (`tests/mocks.ts`).
A shared fixture fails any test that logs a page error or a CSP violation.

| Spec | Covers |
| --- | --- |
| `landing.spec.ts` | Hero, the demo following the strictness table and Pause, hidden items leaving no trace while the badge counts them and the docked popup lists them with Show, a recreated feed per platform tab with TikTok skipping hidden videos, the open popover drawn in its final state on load, popup rows, strictness cards, step rules, tile pictures and decision rows fitting at every width in both themes, the comparison without a sources link, keyboard focus through Why and Pause, the thumbnail disclosure, the length budget, the phone hero, the menu sheet, the live log preview |
| `definition.spec.ts` | The strictness table fits the reading measure and stacks by level on phones |
| `budget.spec.ts` | The performance budget above |
| `source.spec.ts` | Source pages for all five verdicts, Not rated, unknown platforms, no support links |
| `appeal.spec.ts` | Start an appeal, copy the code, Verify, every status, missing secret |
| `log.spec.ts` | Platform and verdict filters, address sync, load more with the cursor |
| `account.spec.ts` | Email sign-in and callback, safe `next`, connect this browser, one-click cancel at period end, then end now and refund, `409 not_refundable` |
| `plans.spec.ts` | Yearly preselected, `503 billing_unavailable`, sign-in before checkout, redirect, closed checkout, `409 already_subscribed`, the welcome page |
| `support.spec.ts` | Donation body and redirect, custom amounts and limits, `503 billing_unavailable`, closed payment |
| `console.spec.ts` | Keyboard queue, evidence, decision body and CSRF header, curator limits (large sources, appeals in review) and `403 staff_required`, AI evidence before Slop and `400 ai_evidence_required` |
| `a11y.spec.ts` | axe WCAG 2.2 A and AA rules on every page, light and dark |
| `brand.spec.ts` | The vocabulary table's "Not" words and exclamation marks never appear, nothing is below 12 px (figure labels as rendered too), controls are at least 32 px, nothing spills out of a card |
| `reflow.spec.ts` | No page scrolls sideways or spills out of a card at 390 and 320 px, and figure labels stay at 12 px and up |

The committed screenshots in `screenshots/` are 1440 and 390 px wide, light and dark, reduced to 256 colors to keep the repository small.
`pnpm -C web screenshots` writes full-color ones.

## Structure

- Every color, type step, space, radius, component and string comes from `@colander/shared` (tokens.css, colander.css, the Mittsu set, the Colander components, copy.ts, verdicts.ts and format.ts).
  No page defines its own button, card, chip, badge, stat, date format, price or verdict copy.
- `src/app.css` only resets the page and styles the long-form pieces: prose, the table of contents, hairline tables, key-value lists and form fields.
- `src/hooks.server.ts` registers a linkedom document so the shared in-page builders prerender as Declarative Shadow DOM (`src/lib/server/inpage.ts`), and preloads the latin Atkinson font file.
- `src/lib/live.svelte.ts` holds the live numbers: the build values from `COLANDER_BUILD_API`, refreshed once per page load.
  A failed refresh keeps the build values.
- `src/lib/content.ts` holds website-only copy: the Kapwing figures, the comparison and its sources, and the questions.
- `src/lib/components/` holds the site chrome (header with the phone menu sheet, footer with the install call to action), the landing section head, the four figures, the arrow link, the appeal frame, the sign-in card and the console's evidence view and decision form.
- `src/lib/api.ts` is the fetch wrapper.
  Every non-GET request sends `X-Colander-CSRF: 1`.
- `src/lib/extension.ts` detects the extension with `colander:ping` and sends tokens with `chrome.runtime.sendMessage`.
- Icons come from `@lucide/svelte` deep imports at 16 px and stroke 2, always beside a word.
