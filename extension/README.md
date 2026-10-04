# Colander for Chrome

Colander hides AI slop on YouTube, TikTok, Instagram and Facebook the way an ad blocker hides ads, from shared signed lists, and lets anyone tag and report slop.
This package is the Manifest V3 extension: WXT, Svelte 5 and TypeScript.
The product spec is `docs/product-requirements.md` and the interfaces are `docs/contracts.md`.

## Development extension ID

```
nninnogmbhfebflkcgghlmjmplmpodlc
```

The manifest carries a fixed public `key`, so an unpacked build has this ID on every machine.
Set the website's `PUBLIC_EXTENSION_ID` to it for local work.
Only the public half of the RSA key is in the repository; the Chrome Web Store signs release builds with its own key, and the store ID replaces this one in production.

## Build, load and test

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs the workspace (run at the repository root). |
| `pnpm -C extension build` | Builds `extension/dist/chrome-mv3`. |
| `pnpm -C extension dev` | Builds and reloads on change. |
| `pnpm -C extension check` | `svelte-check` over every TypeScript and Svelte file, warnings fail. |
| `pnpm -C extension test` | Vitest unit tests. |
| `pnpm -C extension test:e2e` | Builds the end-to-end variant and runs the Playwright suite. |
| `pnpm -C extension test:live` | Builds the end-to-end variant and checks the adapters against the real sites. |
| `pnpm -C extension screenshots` | Builds the end-to-end variant and rewrites `screenshots/`, light and dark. A normal `test:e2e` run never touches them. |
| `pnpm -C extension icons` | Renders `public/icons/*.png` from the brand geometry. |
| `node extension/scripts/capture-fixtures.ts` | Captures sanitized YouTube and TikTok fixtures from the live sites. |

To load it, open `chrome://extensions`, switch on Developer mode, choose Load unpacked and pick `extension/dist/chrome-mv3`.
The welcome tab opens; choose platforms there, or later in Options under Platforms.
Chrome 137 or later is required, for Ed25519 in WebCrypto.

Build configuration (contract section 11) comes from the environment at build time:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WXT_COLANDER_API` | `http://localhost:8787` | Server origin for every API call. |
| `WXT_COLANDER_SITE` | the API origin | Website origin for links and `externally_connectable`. |
| `WXT_COLANDER_PUBLIC_KEYS` | the key in `testdata/dev-signing.pub` | Trusted Ed25519 public keys, comma-separated base64. |

`pnpm build:e2e` (`wxt build --mode e2e`) differs from the release build in one way only: it lists the platform hosts in `host_permissions`, so Chrome grants them at install.
Automation cannot click Chrome's site access prompt, and asking for a permission that is already granted answers at once, so the welcome and Platforms flows run unchanged in tests.
The release build asks for site access per platform through `optional_host_permissions`.

`popup.html?tab=<id>` opens the popup for a given tab in a normal tab, which is how the tests drive it.

## Architecture

```
 platform page (www.youtube.com ...)                     extension origin
 ┌───────────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │ bridge.js   main world: reads card data,  │          │ background.js  service worker         │
 │             writes data-colander-bridge   │          │  list sync, verify, IndexedDB         │
 │ content.js  isolated world:               │◀──storage│  adapter config, tag queue, reports   │
 │   MutationObserver ▸ extract ▸ decide     │   .local │  plan token, Plus sync, badge, icons  │
 │   ▸ hide / collapse / label / Tag / Why   │──msgs───▶│  content script registration          │
 │ content.css host rules (hide, collapse)   │          │  externally_connectable               │
 └───────────────────────────────────────────┘          │ popup · options · welcome · side panel│
                                                         └──────────────────────────────────────┘
```

**Service worker** (`src/background`).
On install it makes the install ID (16 random bytes, base64url, contract 2.4), opens the welcome tab, and syncs.
It syncs on install, on browser start and on an hourly alarm: the list (delta when it can, snapshot otherwise), the signed adapter config, report statuses (only while one of your reports is under review, so an install that never reported sends no ID on a schedule), the plan token's daily check (a paid token is swapped for a fresh one once a day, so a cancel or refund turns Plus off within a day; `404 no_plan` turns it off), Plus settings, and any due tags.
Every list file is verified (magic, version, length, sort order, Ed25519 signature) before it is used; a failure keeps the last good copy, a delta is applied only on top of its own base, and a snapshot older than the local list is refused.
It registers content scripts with `chrome.scripting.registerContentScripts` (`runAt: document_start`) only for platforms that are switched on and granted, and keeps that in step with permission changes.
It owns the toolbar: a per-tab count badge, the paused icon for paused tabs and sites, and the attention dot when a report gets a verdict or the list has not refreshed for 6 hours after a failure (a dismissed report only gets a calm note in the popup).

**Content scripts** (`src/content`, `src/entrypoints/content`, `src/entrypoints/bridge.content.ts`).
`content.js` runs in the isolated world at `document_start`.
It loads settings, own tags, the list index and the adapter config from `chrome.storage.local`, then a MutationObserver classifies each card as it is inserted, inside the microtask before the browser paints, with synchronous lookups.
It re-applies within the same task when settings, tags or the list change (`storage.onChanged`), and starts over on in-page navigation (Navigation API, `popstate`, YouTube's `yt-navigate-finish`).
`bridge.js` runs in the page's main world for one job: YouTube's newer cards carry their channel only in component data, which the isolated world cannot read.
It reads the property paths named in the adapter config and writes `{"i": item, "s": [sources]}` to a `data-colander-bridge` attribute on the card.
The isolated script trusts that attribute only while its item matches the card's own, because the page reuses elements.
All UI is vanilla DOM in open shadow roots with one constructed stylesheet, the system font stack and no `innerHTML`, so page CSS, page CSP and Trusted Types do not get in the way.

**Pages** (`src/entrypoints/*`, Svelte 5, Mittsu components, `colander.css`).
The popup (pause, strictness, counts, this page's actions with Show, Always allow and Not slop, Report this source, the support card, and for Plus a weekly summary once a week), Options (Lists, Platforms, Strictness, Plus, Appearance, Plan, My reports, Data, Privacy), the welcome page, and the curator side panel.

### Matching

`src/lib/match.ts` decides each card; the first rule that matches wins:

1. Pause on this site or this tab: nothing is done.
2. Always allow (My list allows): shown, overriding every list.
3. Your own tag: Slop acts as Slop for you, Not slop as Clear, AI-made but fine as AI-made.
4. My list blocks: hidden at every strictness, because you asked for exactly that.
5. The item's list entry.
6. The source's list entry, under any alias (a YouTube channel ID or its handle).
7. The platform's own AI label: AI-made (P0-4).
8. Plus topic rules marked Hide matches.

The verdict maps to an action through `ACTION_TABLE` and the strictness: the global level, or with Plus the platform's own level, raised by any matching topic that is stricter.
Disputed is always labeled with its mark, and Clear is always allowed.

### Treatments

| Action | Grid or list | Swipe feed |
| --- | --- | --- |
| Label | A verdict chip on the thumbnail (ink background, media color glyph and word). | The chip beside the creator name. |
| Collapse | The card keeps only a 40 px bar: glyph, verdict, one reason, Show and Why. Enter shows it. | The video is covered and paused until Show or Skip. |
| Hide | The card leaves the layout, so the grid closes up, and the page count goes up. | The video is skipped when it becomes active, with "Skipped 1 slop video. Undo" for 4 seconds, announced politely, never stacked. |

Every card with an item or a source gets a 28 px Tag button: shown on hover or keyboard focus in grids and lists, always in swipe feeds.
Where a card shows no source (the Instagram Explore grid), the item tag goes out without `source_id` (contract 6.2).
Tag, then Slop, applies the tag at once (two clicks, P0-5); type and tests are optional after that.
One menu sends one tag: Slop is queued at once but held while the menu is open, type and tests change it on the device, and the final state replaces the queued tag when the menu closes (a held tag goes out after 5 minutes at the latest).
Why lists every signal that fired on one wrapping line, then the list and its date, and links to the public source page and, for list verdicts only, the appeal page (a platform label or your own tag has nothing to appeal).

## Storage layout

Content scripts cannot open the extension origin's IndexedDB, so everything they need is mirrored into `chrome.storage.local`.

| Where | Key or store | Contents |
| --- | --- | --- |
| `storage.local` | `settings` | Strictness, per-platform levels and topics (Plus), platforms switched on, paused sites, My list allows and blocks, plain chips, onboarded. Read by content scripts. |
| `storage.local` | `ownTags` | Target key to your latest tag verdict. Read by content scripts. |
| `storage.local` | `listIndex` | The compact match index: list sequence, count and the sorted 16-byte entries as base64 (800 KB for 50,000 entries). Read by content scripts, which decode it once and binary-search it with a synchronous SHA-256. |
| `storage.local` | `adapterConfig` | A verified remote adapter config newer than the bundled one. Read by content scripts. |
| `storage.local` | `entitlement` | `{plus, trial, exp}` from the verified plan token. Read by content scripts. |
| `storage.local` | `installId`, `planToken`, `reviewerToken` | Credentials for the API. |
| `storage.local` | `planCheckedAt` | When the paid plan token was last checked with `POST /v1/entitlement/refresh` (once a day). |
| `storage.local` | `status` | List sequence, count and date, last sync and error, config version, report verdict and report closed flags. |
| `storage.local` | `stats`, `reports`, `syncState`, `supportCard`, `weeklyCard` | Daily counts (60 days), My reports cache, Plus sync version and dirty flag, support card and weekly summary timing. |
| `storage.session` | `pausedTabs`, `tabInfo` | Paused tabs and each tab's platform and count; gone when the browser closes. |
| IndexedDB `colander` | `kv` / `list` | The canonical list: sequence, created time and the sorted entries, the last good copy. |
| IndexedDB `colander` | `tags` | The tag queue: each tag with its attempts and next retry time. |
| IndexedDB `colander` | `activity` | The last 1,000 acted-on items (local only, never sent). |

## Adapter configuration (normative)

The adapters are driven by one JSON document.
The bundled copy is `src/adapters/default-config.json`; the types and validation are `src/adapters/schema.ts`.
It is plain data: CSS selectors, attribute names, regular expressions and property paths, never code (contract 4.1).

### Delivery

- The server serves it from `GET /v1/config/adapters` as a signed envelope with context `colander:config:v1` (contract section 4); `colander sign-config <file.json>` signs and stores it.
- The extension applies a remote payload only when the signature verifies against a trusted key, the payload passes validation, and its `version` is higher than both the bundled and the cached one.
- An unsigned, malformed or older payload is ignored and the current copy stays.
- Content scripts pick it up at once from `storage.onChanged`; open pages start over with the new rules, without a reload.

### Document

| Field | Type | Rule |
| --- | --- | --- |
| `version` | integer ≥ 1 | Monotonic. Bump it for every published change. |
| `schema` | integer | `1`. A payload for another schema is ignored. |
| `platforms` | object | Keys `yt`, `tt`, `ig`, `fb`; each a platform object. A remote payload may omit platforms; those keep the bundled rules. |

### Platform

| Field | Type | Rule |
| --- | --- | --- |
| `early_access` | boolean? | Early access to new platforms, a Plus feature. When `true` the platform is offered (welcome page, Options under Platforms) and its content scripts are registered only while a Plus entitlement is active; when Plus ends they are removed. Default `false`. No bundled platform sets it. |
| `hosts` | string[] | Hostnames the adapter runs on, for example `www.youtube.com`. |
| `navEvents` | string[]? | Document events that mean an in-page navigation, besides the Navigation API and `popstate`. |
| `reportHelp` | URL | The platform's own reporting help, linked as "This is a scam or deepfake". |
| `surfaces` | surface[] | Where cards are found. |
| `pages` | page rule[]? | How to read the current page's own source, for Report source. |
| `bridges` | bridge[]? | Main-world data readers. |

### Surface

A surface is active while its `path` matches `location.pathname`; only active surfaces are scanned and counted.
When two active surfaces could match the same element, write the selectors so they do not (the bundled YouTube Shorts shelf uses `:not()` to leave Shorts inside home grid items to the grid).

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | Stable name, for example `yt.home`. Used in diagnostics and the live checks. |
| `path` | regex | Tested against `location.pathname`. |
| `mode` | `grid`, `list` or `swipe` | Decides the treatments in the table above. |
| `card` | selector | Matches one card (document-wide). |
| `pageSource` | boolean? | Cards without a source of their own belong to the page's source (channel and profile grids). |
| `item` | extractor[] | Tried in order; the first canonical item ID wins. |
| `source` | extractor[] | Every extractor that yields a canonical source ID adds an alias. |
| `name` | extractor[]? | Source display name; first non-empty wins. |
| `title` | extractor[]? | Title or caption, for topic rules and the activity log. |
| `aiLabel` | text probe? | The platform's own AI disclosure on the card. |
| `chip` | anchor? | Where the chip goes. Default: overlay on the card. |
| `tag` | anchor? | Where the Tag button goes. Without it, the card gets no Tag button. |
| `cover` | selector? | Swipe feeds: the element the cover is laid over. Default: the card. |
| `next` | selector? | Swipe feeds: the platform's own next control, clicked to skip. Default: scroll the next card into view. |

### Extractor

| Field | Type | Rule |
| --- | --- | --- |
| `sel` | selector? | Relative to the card (to the document in page rules). Absent or `:scope` means the card itself. |
| `from` | `location` or `title`? | Page rules only: read the page URL or `document.title` instead of an element. |
| `attr` | string? | Attribute to read, or `text` for the text content. Default `href`. |
| `re` | regex? | Applied to the value; capture group 1 (or the whole match) becomes the value. |
| `as` | `url`, `id` or `text`? | `url` parses the value as a link with the contract 2.2 rules for the platform; `id` canonicalizes a raw ID; `text` keeps it, whitespace collapsed. Default `url` when reading `href`, `id` otherwise. |

Canonicalization is code, not configuration, and follows contract 2.2 exactly (`packages/shared/src/ids.ts`, shared with the server and table-tested in `packages/shared/test/ids.test.ts`): YouTube channel IDs keep their case and handles are lowercased with `@`; TikTok usernames are lowercased with `@`; Instagram usernames are lowercased without `@`; Facebook numeric IDs or lowercased vanity names; item IDs keep their case everywhere, and Shorts IDs are video IDs.

### Text probe

| Field | Type | Rule |
| --- | --- | --- |
| `sel` | selector | Elements inside the card to look at. |
| `text` | regex? | Case-insensitive; one element's text must match. Without it, presence is enough. |

### Anchor

| Field | Type | Rule |
| --- | --- | --- |
| `sel` | selector? | Relative to the card. Default: the card. |
| `place` | string | `overlay` pins to the top-left corner of the anchor and `overlay-end` to the top-right (the anchor gets `position: relative` if it had none); `append`, `prepend`, `before` and `after` insert in the flow. |

### Page rule

| Field | Type | Rule |
| --- | --- | --- |
| `path` | regex | Tested against `location.pathname`. |
| `source` | extractor[] | Source IDs of the page, usually `{ "from": "location" }`. |
| `name` | extractor[]? | Display name. |
| `anchor` | anchor? | Document-level place for the Report source button. |

### Bridge

| Field | Type | Rule |
| --- | --- | --- |
| `card` | selector | Cards to annotate. |
| `el` | selector? | Element inside the card that holds the data. Default: the card. |
| `props` | string[] | Property paths to the data object, tried in order. A segment ending in `()` calls a getter function, for example `componentProps.data()`. |
| `item` | key[]? | Searched depth-first; the first value found for the first key wins. |
| `source` | key[]? | Every key found adds an alias. |

A key is `{ "key": "browseId", "re": "^UC[\\w-]{22}$" }`: a property name and an optional regex its string value must match (group 1 is used when present).
Values containing `/` are parsed as links, so `canonicalBaseUrl` values like `/@name/shorts` work.

### Fixing a broken selector

1. Run `pnpm -C extension test:live` (or read the daily workflow's failure) to see which surface lost its cards.
2. Open the page, find the new structure, and edit a copy of `default-config.json` with a higher `version`.
3. Check it against a fresh fixture: `node scripts/capture-fixtures.ts <name>` and `pnpm test`.
4. `colander sign-config <file.json>` on the server.
   Every install picks it up within an hour.
5. Fold the change into the bundled copy in the next release.

## Network and privacy

The extension makes exactly the requests in contract section 8: list snapshot and deltas (no identifier at all), the adapter config, tags and reports (`Authorization: Install`), report status, the trial, the entitlement refresh, Plus settings sync (`Authorization: Plan`), and the review API from the side panel (`Authorization: Bearer`).
No request carries a page URL, a platform account name or history; the end-to-end tests assert the tag and report bodies hold only the contract's fields.
Permissions are `storage`, `alarms`, `sidePanel` and `scripting`, plus optional host access per platform.
There is no remote code, no `eval` and no inline script.

## Tests

- `tests/unit`: the list decoder and verifier against `testdata/contract` (snapshot, delta, tampering, length, sort order, unknown keys, delta on the wrong base), the config envelope and plan token, the synchronous SHA-256 against Node's, canonical IDs per platform from real-looking URLs, matching precedence and the strictness table, the tag queue's offline retry planning, and adapter extraction against a saved fixture of every surface.
- `tests/e2e`: the built extension in Chromium with fixtures served on the real hostnames and the API mocked by route handlers serving the contract fixtures.
  It covers hiding, collapsing and labeling per strictness, re-applying within 1 second without a reload (P0-3), pause by site and tab, the badge, delta sync, a tampered list, a signed config fixing a renamed selector, no layout jump during infinite scroll, Tag in two clicks and the exact tag body (one POST per tag menu, item tags without a source on the Instagram Explore grid), the offline queue, keyboard-only use of the tag menu and collapsed bar, Why (every signal that fired, Appeal only for list verdicts), Show, Always allow and Not slop, swipe skip with Undo and covers, the welcome flow's permission request, Report source, website messaging, the trial and Plus sync, Plus early access, the weekly summary and the daily plan check, no install ID on a fresh install's sync, a dismissed report closed calmly, the side panel, and the performance budgets.
- Performance on a 200-card page: slop cards are hidden 3 ms after insertion at the 95th percentile (budget 150 ms), and the content script adds about 21 ms in total (budget 50 ms).
  On live YouTube pages it adds 7 to 23 ms per page.
- `tests/live`: the real YouTube and TikTok pages, no login.
  Signed-in surfaces run only with a Playwright storage state in `COLANDER_LIVE_STATE_YT`, `_TT`, `_IG` or `_FB`.
  `.github/workflows/adapters-daily.yml` runs it every day.
  A surface that finds no cards fails the run, and so does a surface whose platform has a storage state when the site refuses the automated browser.
  Without credentials, such surfaces are skipped as unverified: `tests/live/summary-reporter.ts` lists every surface in the job summary and adds a warning annotation for each unverified one.
- `tests/e2e/shots.spec.ts` (and the side panel test) write the screenshots in `screenshots/`, light and dark, only under `pnpm screenshots` (`SCREENSHOTS=1`).
- `tests/e2e/a11y.spec.ts` runs axe-core (WCAG 2.2 A and AA) over the popup, every Options section, the welcome page, the side panel and every in-page element (chip, collapsed bar, Tag button, tag menu, Why, report form, skip notice, cover), light and dark, and checks the radio group keys, the popup's 32 px rows and the switches' 3:1 contrast.

## Fixtures

`tests/fixtures/yt-*.html` and `tt-foryou.html`, `tt-profile.html` were captured from the live sites by `scripts/capture-fixtures.ts`: the real element structure from `<body>` down to a few cards, without scripts, styles, media or unused attributes, with the bridge's reading baked in and a few cards seeded with IDs from the contract list.
YouTube home and subscriptions need an account, so their fixtures reuse real rich-grid cards from a channel's videos tab, which has the same structure.
`tt-search.html`, `ig-*.html` and `fb-*.html` are written by hand from those platforms' stable attributes, because their feeds need an account.
`tests/fixtures/styles/*.css` is a stand-in layout so screenshots look like the sites; the adapters never depend on it.

## Limitations and what was not verified live

- **Instagram and Facebook** selectors are built from stable structure (`main article`, header links, `/p/` and `/reel/` links, `role="feed"`, `aria-posinset`, heading links, `story_fbid` and `/posts/` links, `data-video-id`, `data-ad-preview`, the "AI info" label) and tested on hand-written fixtures only.
  They need a signed-in live check before release: run `pnpm test:live` with `COLANDER_LIVE_STATE_IG` and `COLANDER_LIVE_STATE_FB`.
- **TikTok search** and **YouTube home and subscriptions** need an account and were not checked live; they run in the live suite when storage states are provided.
- **TikTok For You and profiles** were checked live once (both rendered For You articles yielded item IDs and sources); later runs from this machine got TikTok's "Something went wrong" page, which the live suite reports as an unverified skip (with a warning in the daily job summary) when no TikTok storage state is configured, and as a failure when one is.
- **YouTube search, watch suggestions, channel pages and Shorts** pass live: every card yields an item ID and a source (Shorts: the active one).
- **Platform AI labels** on YouTube cards and in Shorts, TikTok, Instagram and Facebook are matched by their visible text ("Altered or synthetic content", "AI-generated", "AI info"); no live page with a label was at hand to confirm where each sits, and the English text is assumed.
- Shorts in YouTube's search shelves carry no channel in the DOM or in their data, so they match by video ID only.
- Keys typed in the Report source form are kept from the page's own key handlers that listen in the bubble phase; a site that listens in the capture phase could still see them.
- Facebook's `/watch/?v=` and `/pages/{name}/{id}` links are read as the same video and page IDs the contract lists (`/videos/{id}` and numeric page IDs).
- Plus settings sync sends the version it last saw in `PUT /v1/sync` and takes the new version from the response (or adds one when the response has none).
