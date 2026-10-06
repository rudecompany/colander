# Colander website

The public website, account pages and review console for Colander.
It is a SvelteKit 3 app (Svelte 5 runes, TypeScript strict) built with `@sveltejs/adapter-static` into `web/build`.
The Worker in `api/` serves that folder and the API from the same origin, so every page calls relative `/v1/...` URLs.

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
| `/plans/welcome` | Checkout success: waits for the plan, then shows a pairing code for Plus | Prerendered shell |
| `/support` | Donations, once or monthly; `?cancelled=1` after a closed payment | Prerendered shell |
| `/support/thanks` | Donation success | Prerendered |
| `/supporters` | Credited supporters | Prerendered shell |
| `/transparency` | Live list numbers, funding, independence rules, expiry | Prerendered shell |
| `/account` | Sign-in with a code or a passkey, plan, cancel, pairing codes for Plus and the review side panel, the side panel's connection, passkeys, sign out everywhere, download and delete | Prerendered shell |
| `/account/invite#invite=` | Adds a reviewer's passkey with an invite, after an email sign-in | Prerendered shell |
| `/account/cancel#<secret>` | Cancels a held request from its email link, when asked | Prerendered shell |
| `/auth/callback?token=&next=` | Finishes a sign-in link mailed before codes, for one release | Prerendered shell |
| `/console` | Review console for curators, after a passkey sign-in of the last 12 hours; staff get a link to the admin console. Reviewers here see that seed lists name a lead, never which | Prerendered shell |
| `/console/calibration` | Blind labeling of the calibration set, behind the same passkey sign-in, with curator authority | Prerendered shell |
| `/admin`, `/admin/calibration`, `/admin/people`, `/admin/audit` | The admin console on the admin host: review with full authority (staff see which seed lists name a lead and can suppress them), the calibration set with third labels where two disagree, people and roles, invites, the audit log | Prerendered shell |
| `/privacy`, `/terms` | Policies; the privacy page's Creators section lists where data about a source comes from | Prerendered |
| `/credits` | The datasets whose license asks for credit, the one page that names a dataset | Prerendered from the seed registry by `+page.server.ts`, so the registry never reaches a page's JavaScript |

`{platform}` is `yt`, `tt`, `ig` or `fb` (matched in `src/params.ts`); anything else is a 404.
Support and donation links never appear on `/s/*` or `/appeal/*` pages, including the footer.

### What the server needs to do

- Serve `build/` with this lookup order: the file itself, then `{path}.html`, then `{path}/index.html`.
  Workers Static Assets (below) and `tests/static-server.ts` both do exactly this, and the tests run against the second.
- `200.html` is the SPA fallback for the client-rendered routes only: `/s/{platform}/{id}`, `/appeal/{platform}/{id}` and `/appeal/status/{id}`.
- Any other path is a real 404: `404.html` with status 404.
  It is the same shell, copied by `pnpm build`, so the client renders the not-found page.
- Each page carries its Content Security Policy as a `<meta http-equiv>` tag with script hashes.
  The server may also send `frame-ancestors 'none'` as a header, which a meta tag cannot carry.

On Cloudflare (`api/wrangler.jsonc`), Workers Static Assets serves `build/` with `html_handling: auto-trailing-slash`, so `/definition` serves `definition.html`.
`static/_redirects` rewrites the client-rendered routes (`/s/{platform}/{id}`, `/appeal/{platform}/{id}` and `/appeal/status/{id}`) to the `200.html` shell with status 200.
Every other unknown path, including a source or appeal URL with an unknown platform or extra segments, gets `404.html` with status 404 (`not_found_handling: 404-page`); the `postbuild` script copies `200.html` to `404.html`, so the client still renders the 404 page.
`static/_headers` adds HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, a CSP header with only `frame-ancestors`, `object-src` and `base-uri`, and immutable caching for `/_app/immutable/*`.

## Environment

Variables are declared in `src/env.ts` and inlined at build time.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_STORE_CHROME` | `https://chromewebstore.google.com/search/Colander` | The Chrome Web Store listing. Chrome, Brave and Opera install from it, and so does Edge while `PUBLIC_STORE_EDGE` is empty. |
| `PUBLIC_STORE_EDGE` | empty | The Edge Add-ons listing. Empty hides it, so the site can ship before the listing is live. |
| `PUBLIC_STORE_FIREFOX` | empty | The Firefox Add-ons listing. Empty hides it, and the site then names no Firefox support. |
| `PUBLIC_TURNSTILE_SITE_KEY` | empty | Turnstile site key for the sign-in code form; it also allows challenges.cloudflare.com in the page CSP. Empty: no challenge. |
| `COLANDER_API` | `http://localhost:8787` | Dev only: where `vite dev` proxies `/v1`. |
| `COLANDER_BUILD_API` | empty | Build only: an API origin, such as `http://127.0.0.1:8787`, to read `/v1/stats` and the latest decisions from at build. Pages prerender with those numbers and their time, then refresh them in place. Without it, live numbers appear once the page loads, and the build prints a warning: set it for every production build. |

## Develop

```sh
pnpm install                 # at the repository root
pnpm -C web dev              # http://localhost:5173, /v1 proxied to wrangler dev on :8787 (make dev)
```

The Worker runs in dev mode (`COLANDER_DEV=1`), so sign-in codes are printed in the `wrangler dev` output.
Passkeys need the page and the Worker's `PUBLIC_URL` on the same origin, so try them on http://localhost:8787 (`make dev`).

## Build and check

```sh
pnpm -C web check            # svelte-kit sync, svelte-check, and the token and date-format lint
pnpm -C web build            # checks the generated in-page tokens, writes web/build, copies 200.html to 404.html
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
| Landing length (`landing.spec.ts`) | At most 8,550 px at 1440 and 13,800 px at 390 (the brief's 8,200 and 12,500, plus the one-column bento and strictness rows on phones, the popup rows in each strictness card, the one-column questions and the hero frame that ends inside a row) |

The demo feed thumbnails are AI-generated illustrations (`packages/shared/src/assets/demo`), and every picture of the demo feed says so: "Thumbnails are AI-generated illustrations."
They stay files and are never inlined into the JavaScript.
`@colander/shared` is marked side-effect free, so a page loads only the components it uses, and modules that two or more pages share travel in one `common` chunk (`vite.config.ts`).

## Tests

```sh
pnpm -C web test             # builds, serves build/ with the lookup above, runs Playwright in Chromium
pnpm -C web screenshots      # full-page screenshots of every page into web/screenshots
```

The test server listens on 4173; set `PORT` to move it when that port is taken.
It also serves `build-turnstile/` one port above, a second build with Turnstile's always-pass test site key, for `turnstile.spec.ts` (Playwright project `turnstile`).

Every test mocks `/v1` with `page.route` using fixtures typed by `packages/shared/src/api.ts` (`tests/mocks.ts`).
A shared fixture fails any test that logs a page error or a CSP violation.

| Spec | Covers |
| --- | --- |
| `landing.spec.ts` | Hero, the demo following the strictness table and Pause, hidden items leaving no trace while the badge counts them and the docked popup lists them with Show, a recreated feed per platform tab with TikTok skipping hidden videos, the open popover drawn in its final state on load, Show putting an item back in its slot, off every count, with a "Shown again." notice and Undo, popup rows, strictness cards, step rules, tile pictures and decision rows fitting at every width in both themes, the comparison table and its checked date, naming no competitor and linking no source, keyboard focus through Why and Pause with no trap around the popover open on load, the phone popup's control staying put, the thumbnail disclosure, the length budget, the phone hero with one feed and no platform tabs, the install button following the browser (Edge's own store once listed, Firefox falling back while unlisted, Opera's step first), the menu sheet, the live log preview and no "no entries" before the log is read, one overlay at a time in the demo, and the demo popup's Options, Decision log and Support links |
| `definition.spec.ts` | The strictness table fits the reading measure and stacks by level on phones, and the figures are numbered in reading order |
| `budget.spec.ts` | The performance budget above |
| `source.spec.ts` | Source pages for all five verdicts, Not rated, unknown platforms, no support links, audience size not known, large or recorded by staff as not large, and no upload figures |
| `appeal.spec.ts` | Start an appeal, copy the code, Verify, every status, missing secret |
| `log.spec.ts` | Platform and verdict filters, address sync, load more with the cursor, reviewers named on appeal entries, item-level changes naming their item in the row |
| `account.spec.ts` | Code sign-in with its focus steps and a wrong code, no request before the person starts on the form, a used-up code, an old link, a pairing code for Plus and for the side panel until it is claimed or ends, one-click cancel at period end, then end now and refund, `409 not_refundable` |
| `turnstile.spec.ts` | With Turnstile on and a stand-in for its script: nothing loads before the person starts, and every code request (the first, a new code, another address and a step-up) carries a token no other request used |
| `passkeys.spec.ts` | With a Chromium virtual authenticator: add a passkey and sign in with it, the step-up dialog by passkey and by code, a reviewer asked for their passkey before adding one and a device that already holds one, the 72-hour wait without a passkey, download and delete, sign out everywhere, invites, the cancel link, the console's passkey gate, and the links that take staff to the admin host |
| `admin.spec.ts` | The admin console on the admin host: full-authority review with the public source page on the main host and no public API calls, a client-side route that goes on to the admin host, not staff, roles below one's own, invites shown once, the receipt-checked email change, the audit log as a table and, on phones, as entries |
| `plans.spec.ts` | Yearly preselected, `503 billing_unavailable`, sign-in before checkout with the Free and Plus cards keeping one height, redirect, closed checkout, `409 already_subscribed`, the welcome page with its pairing code and its full-width sign-in button |
| `support.spec.ts` | Donation body and redirect, custom amounts and limits, `503 billing_unavailable`, closed payment |
| `console.spec.ts` | Keyboard queue, evidence, decision body and CSRF header, curator limits (large sources, appeals in review) and `403 staff_required`, AI evidence before Slop and `400 ai_evidence_required`, seed provenance and suppression for staff on the admin host and only a count for curators |
| `calibration.spec.ts` | A blind label posted with its language and kind and the next item shown, the empty set, the console's link to it, a 24-character channel ID on one line at 390 px, and staff labeling from the admin console's Calibration tab |
| `credits.spec.ts` | `/credits` shows exactly the credits a fictional test registry (`tests/seed-registry.ts`, which the test build reads through `COLANDER_SEED_REGISTRY`) gives, in light and dark; the privacy page's Creators section; and no other file of the built site names a dataset by any of its names |
| `a11y.spec.ts` | axe WCAG 2.2 A and AA rules on every page, light and dark |
| `brand.spec.ts` | The vocabulary table's "Not" words and exclamation marks never appear, nothing is below 12 px (figure labels as rendered too), controls are at least 32 px, nothing spills out of a card |
| `reflow.spec.ts` | No page scrolls sideways or spills out of a card at 390 and 320 px, the stat cells on the landing page and /transparency keep their labels inside at 1024 and 1100 px, and figure labels stay at 12 px and up |

The committed screenshots in `screenshots/` are 1440 and 390 px wide, light and dark, reduced to 256 colors to keep the repository small.
`pnpm -C web screenshots` writes full-color ones.

## Structure

- Every color, type step, space, radius, component and string comes from `@colander/shared` (tokens.css, colander.css, the Mittsu set, the Colander components, copy.ts, verdicts.ts and format.ts).
  No page defines its own button, card, chip, badge, stat, date format, price or verdict copy.
- `src/app.css` only resets the page and styles the long-form pieces: prose, the table of contents, hairline tables, key-value lists and form fields.
- `src/hooks.server.ts` registers a linkedom document so the shared in-page builders prerender as Declarative Shadow DOM (`src/lib/server/inpage.ts`), and preloads the latin Atkinson font file.
- `src/lib/live.svelte.ts` holds the live numbers: the build values from `COLANDER_BUILD_API`, refreshed once per page load.
  A failed refresh keeps the build values.
  The latest decisions stay unknown until the build or a refresh has read them, so no page says the log is empty before it knows.
- `src/lib/content.ts` holds website-only copy: the Kapwing figures, the comparison and its checked date, and the questions.
- `src/lib/components/` holds the site chrome (header with the phone menu sheet, footer with the install call to action), the landing section head, the four figures, the arrow link, the appeal frame, the sign-in card and the console's evidence view and decision form.
- `src/lib/api.ts` is the fetch wrapper.
  Every non-GET request sends `X-Colander-CSRF: 1`.
- `src/lib/install.svelte.ts` picks the store for the visitor's browser from the store variables; pages prerender the Chrome Web Store and switch once they run.
- `src/lib/components/ConnectBrowser.svelte` shows a pairing code (contract 7) for Plus or the review side panel, with its countdown, and checks every 2 seconds until the extension takes it.
  The website never talks to the extension directly.
- Icons come from `@lucide/svelte` deep imports at 16 px and stroke 2, always beside a word.
