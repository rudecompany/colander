# Colander: engineering contracts

This document is the single source of truth for every interface that crosses a component boundary.
The extension, the Worker in `api/` and the website are built against it.
If code and this document disagree, the code is wrong.
Behavior described in `docs/product-requirements.md` (the spec) is not repeated here unless a precise rule is needed.

## 1. Repository layout and ownership

| Path | What | Stack |
| --- | --- | --- |
| `packages/shared` | `@colander/shared`: verdict enums and words, signals, glyphs, the Colander theme (`colander.css`), Mittsu components, API types, the list format, Ed25519 signing and canonical IDs (client and server halves, WebCrypto only), and the seed source registry (section 14) | TypeScript, Svelte 5 |
| `extension` | The MV3 browser extension, one codebase for Chrome, Edge, Brave, Opera and Firefox | WXT, Svelte 5, TypeScript |
| `api` | `@colander/api`: every backend service in one Cloudflare Worker (list, tag, scoring, review, appeals, public API, accounts, billing), with one SQLite Durable Object, `Store`, as the database and R2 for the signed list and the backups | TypeScript, Cloudflare Workers |
| `web` | Public website, account pages and the review console, built static and served by the Worker as its static assets | SvelteKit (adapter-static), Svelte 5, Mittsu |

The repository is one pnpm workspace (`pnpm-workspace.yaml` at the root).
UI components come from Mittsu (`packages/shared/src/components/ui`, add more with `npx @a3tai/mittsu add <name> --registry ~/prj/a3tai/mittsu/packages/svelte5/registry.json` run inside `packages/shared`).
Icons come from `@lucide/svelte` (deep imports, size 14 to 16, strokeWidth 1.75), except the brand mark and the five verdict glyphs which live in `packages/shared/src/glyphs.ts`.

## 2. Identifiers

### 2.1 Platforms and target types

| Platform | Code | Wire value |
| --- | --- | --- |
| YouTube | 0 | `yt` |
| TikTok | 1 | `tt` |
| Instagram | 2 | `ig` |
| Facebook | 3 | `fb` |

Target types are `source` (channel, profile or page) and `item` (video, Short, Reel or image post).

### 2.2 Canonical IDs

Every target has a canonical ID string per platform.
Adapters must normalize exactly as below, or matching fails silently.

| Platform | Source ID | Item ID |
| --- | --- | --- |
| `yt` | Channel ID `UC` + 22 chars, case kept, for example `UCX6OQ3DkcsbYNE6H8uQQuVA`. Or handle with `@`, lowercased, for example `@mrbeast`. | Video ID, 11 chars, case kept (also for Shorts) |
| `tt` | Username with `@`, lowercased, for example `@tiktok` | Numeric video ID as a decimal string |
| `ig` | Username without `@`, lowercased, for example `natgeo` | Shortcode from `/p/{code}/` or `/reel/{code}/`, case kept |
| `fb` | Numeric ID from `profile.php?id=` or `/people/{name}/{id}`, or the vanity username lowercased | The post, reel or video ID from the URL (`/posts/{id}`, `story_fbid=`, `/reel/{id}`, `/videos/{id}`, `fbid=`), case kept |

Before the per-platform rules, both sides normalize every raw source token the same way, in this order: trim whitespace, percent-decode (page links and seed lists carry encoded handles such as `@Espa%C3%B1ol`), then Unicode NFC.
Lowercasing is a per-code-point simple mapping (Go's `strings.ToLower`): each character is mapped alone, so there is no final-sigma rule, and `İ` (U+0130) becomes `i`.
YouTube handles may use letters of any script with their combining marks, digits, `_`, `-`, `.` and `·`.
`testdata/contract/canonical-ids.json` holds vectors that the server and the extension must both pass.

A source can have several aliases (a YouTube channel ID and its handle).
The server stores aliases and emits one list entry per alias, all with the same verdict.

### 2.3 Target key and hash

The target key is `{platform}:{s|i}:{canonicalId}`, for example `yt:s:@mrbeast` or `yt:i:dQw4w9WgXcQ`.
The list hash is the first 8 bytes of SHA-256 over the UTF-8 target key.

### 2.4 Install ID

Each install generates 16 random bytes on first run, encoded as unpadded base64url (22 chars).
It is sent as `Authorization: Install <id>` on tag, report and trial requests and on `DELETE /v1/install`, and nowhere else.
The server never stores it raw: it stores `hex(SHA-256("colander-install:" + id))`.

## 3. The shared list (binary)

All integers are little-endian.

```
Header, 32 bytes
  0   magic      4 bytes  "CLDL"
  4   version    u8       1
  5   kind       u8       0 = snapshot, 1 = delta
  6   reserved   u16      0
  8   sequence   u64      list version this file brings the client to
  16  base       u64      delta: the sequence it applies on top of; snapshot: 0
  24  created    u32      unix seconds
  28  count      u32      number of entries
Entries, count x 16 bytes, sorted ascending by hash (bytewise), no duplicate hashes
  0   hash       8 bytes  see 2.3
  8   verdict    u8       0 = removed (delta only), 1 slop, 2 likely_slop, 3 ai_made, 4 disputed, 5 clear
  9   flags      u8       bits 0-2 platform code, bit 3 target type (0 source, 1 item),
                          bit 4 large source, bit 5 reserved 0 (see below), bit 6 staff reviewed, bit 7 reserved 0
  10  signals    u16      bitmask, bit order in 3.1
  12  detail     u8       bits 0-1 slop type (0 none, 1 filler, 2 bait, 3 deceptive),
                          bit 2 low_effort, bit 3 mass_produced, bit 4 hollow, bits 5-7 reserved 0
  13  reserved   u8       0
  14  updated    u16      days since 2020-01-01 UTC when the verdict last changed
Trailer, 72 bytes
  0   key_id     8 bytes  first 8 bytes of SHA-256 over the raw 32-byte Ed25519 public key
  8   signature  64 bytes Ed25519 over header and entries (every byte before the trailer)
```

Flag bit 5 once meant "imported and not yet reviewed".
Seed lists no longer put anything on the list (9.3), so servers always write it as 0; readers keep decoding it, because a list published before the change may still set it.

A snapshot of 50,000 entries is 800,104 bytes, under the 2 MB limit with no compression.
Clients must reject a file whose magic, version, length (`32 + 16*count + 72`), sort order or signature is wrong, and keep their last good copy.

### 3.1 Signal bits

| Bit | Signal | Layer |
| --- | --- | --- |
| 0 | `platform_label` | Provenance |
| 1 | `content_credentials` | Provenance |
| 2 | `creator_statement` | Provenance |
| 3 | `watermark` | Provenance |
| 4 | `high_volume` | Behavior |
| 5 | `mostly_ai` | Behavior (80% rule) |
| 6 | `templated` | Behavior |
| 7 | `near_duplicates` | Behavior |
| 8 | `link_funnel` | Behavior |
| 9 | `cross_posting` | Behavior |
| 10 | `rubric_low_effort` | Rubric |
| 11 | `rubric_hollow` | Rubric |
| 12 | `community_consensus` | Consensus |
| 13 | `staff_review` | Review |
| 14 | `open_appeal` | Appeal |
| 15 | `not_slop_consensus` | Consensus |

Human-readable text for each signal is in `packages/shared/src/verdicts.ts` (`SIGNAL_TEXT`).

### 3.2 Endpoints

| Request | Response |
| --- | --- |
| `GET /v1/list/snapshot` | `200`, `application/octet-stream`, the latest snapshot. Header `X-Colander-Sequence`. `Cache-Control: public, max-age=60`. |
| `GET /v1/list/delta?since=N` | `200` with a delta from N to latest, `204` when N is the latest sequence, both with the snapshot's `Cache-Control`; `410` when N is unknown or older than 30 days (client then fetches the snapshot), with `Cache-Control: no-store`. |

A delta carries the final state of every hash that changed after `base`, coalesced, with verdict 0 for entries that left the list.
The client applies it only when `base` equals its own sequence.
The server publishes a new sequence whenever any entry changes, at most once per 10 seconds, so a verified appeal reaches the list within a minute.

Sequences are monotonic but not contiguous.
Each publication takes the largest of the previous sequence plus one, the current unix time in seconds, and the sequence in R2 plus one, so no restore or clock can reissue or lower a sequence an install already holds.
Clients compare sequences and never assume that N + 1 follows N.

Clients may keep a snapshot, a delta or a `204` for 60 seconds (`Cache-Control: public, max-age=60`), while the edge keeps every list answer for 15 seconds (`Cloudflare-CDN-Cache-Control: public, max-age=15, stale-if-error=86400` on 200 and 204, `public, max-age=15` on 410), which Workers Cache obeys and strips.
With the 10-second publication floor and two cache tiers, a verified appeal reaches the edge within about 41 seconds.

## 4. Signed JSON envelope

Used for the adapter configuration and anything else that must be signed JSON.

```json
{ "kid": "<hex of key_id>", "payload": "<base64 of the JSON bytes>", "sig": "<base64 Ed25519 signature>" }
```

The signature covers the ASCII context string, one zero byte, then the payload bytes.
Contexts: `colander:config:v1` for adapter configuration, `colander:plan:v1` for plan tokens.
One Ed25519 key signs lists, configuration and plan tokens; context strings keep the uses apart.
The extension ships the trusted public keys at build time (`WXT_COLANDER_PUBLIC_KEYS`, comma-separated base64 of raw 32-byte keys) and accepts any of them.

### 4.1 Adapter configuration

`GET /v1/config/adapters` returns the envelope above, or `404` when the server has none (the extension then keeps its bundled copy).
The payload schema is owned by the extension and documented in `extension/README.md`.
It must contain a top-level integer `version`; the extension applies a remote config only when it is signed and its version is higher than the bundled or cached one.
The server treats the payload as opaque bytes: the ops command `sign-config` (`POST /ops/sign-config`, see `docs/deploy.md`) reads `extension/src/adapters/default-config.json` from the repository at the run's commit on main, signs it with the Worker's key and stores it.
The payload is declarative data only: selectors, attribute names and regular expressions. Never code.

## 5. Plan tokens

Format: `base64url(payload JSON) + "." + base64url(signature)`, unpadded, signed with context `colander:plan:v1` (section 4).

```json
{ "v": 1, "sub": "acc_123", "plan": "plus", "trial": false, "iat": 1790000000, "exp": 1792600000 }
```

`plan` is `plus` (Family arrives in 1.1). `exp` is the end of the paid period plus 3 days of grace, or 14 days after start for a trial.
The extension verifies tokens offline and unlocks Plus features while `now < exp`.
Paying never changes tag weight, review order or any verdict: the server never reads plan state in scoring or review code.

## 6. HTTP API

Base URL: the server origin, which also serves the website. Dev default `http://localhost:8787`.
All bodies are JSON with `snake_case` keys; times are RFC 3339 strings in UTC.
Errors use `{"error": {"code": "machine_code", "message": "Plain sentence for people."}}` with a fitting status.
Rate-limited requests get `429` with `Retry-After` in seconds.
Limits per IP count an IPv6 client by its /64.
GETs that the edge caches by their full URL take only their canonical query and answer `400` to any other: `/v1/list/delta` exactly `?since=N` (section 3.2), `/v1/log` the parameters of 6.4 each at most once, non-empty and in the order `limit` (1 to 200), `platform`, `verdict`, `cursor` (as `next_cursor` gives it), and `/v1/list/snapshot`, `/v1/config/adapters`, `/v1/sources/*`, `/v1/stats` and `/v1/supporters` none (`invalid_query`).

CORS: `/v1/list/*`, `/v1/config/*`, `/v1/tags`, `/v1/reports`, `/v1/trial`, `/v1/install`, `/v1/entitlement/refresh`, `/v1/pair/claim`, `/v1/sync`, `/v1/review/*` (bearer only) and `/v1/sources/*` answer any origin (`Access-Control-Allow-Origin: *`, no credentials) on getcolander.com, so the extension needs no host permission for the API.
The admin host (6.9) answers no CORS at all.
Cookie- and Access-authenticated routes are same-origin only: every non-GET request needs the header `X-Colander-CSRF: 1` and `Sec-Fetch-Site: same-origin` (`403 csrf_required`).
getcolander.com, staging.getcolander.com and the admin hosts are one site to a browser, so SameSite cookies alone would not keep a sibling host out; the CORS allowlist never permits the CSRF header.

Identity reaches the Store only in headers the edge sets: it drops every `x-colander-` header a client sends (except `x-colander-csrf`) before it sets its own (`x-colander-host`, the Access identity and the IP hash).
A request the edge did not mark counts as the main host, with curator authority at most.

### 6.1 Auth schemes

| Scheme | Header | Used by |
| --- | --- | --- |
| Install | `Authorization: Install <install id>` | Extension: tags, reports, trial, erasing its server data |
| Session | Cookie `__Host-colander_session` (HttpOnly, Secure, SameSite=Strict, Path=/; in dev `colander_session` without Secure). It records how it signed in (`email` or `passkey`) and when. | Website on the main host: account, billing, pairing codes, review console |
| Reviewer | `Authorization: Bearer colander_rt_...`, valid 7 days, curator authority only, issued only through a pairing code (section 7) | Extension side panel: review API on the main host |
| Plan | `Authorization: Plan <plan token>` | Extension: settings sync |
| Access | `Cf-Access-Jwt-Assertion`, the Cloudflare Access application token, verified at the edge | Staff and admins on the admin host only (6.9) |
| Ops | `Authorization: Bearer <GitHub Actions OIDC token>` | The ops channel (`docs/deploy.md`) |

The admin host ignores the product cookie and every Bearer, Install and Plan token: the edge drops them there.

### 6.2 Tags

`POST /v1/tags` (Install). Body `{"tags": [Tag, ...]}`, 1 to 50 tags.

```json
{
  "client_id": "3f1c2c3e-...",
  "platform": "yt",
  "target_type": "item",
  "target_id": "dQw4w9WgXcQ",
  "source_id": "@somechannel",
  "verdict": "slop",
  "slop_type": "filler",
  "tests": ["low_effort", "mass_produced"],
  "platform_label": false,
  "created_at": "2026-10-03T12:00:00Z",
  "ext_version": "1.0.0"
}
```

| Field | Rule |
| --- | --- |
| `client_id` | UUID from the client, used for idempotency |
| `target_type`, `target_id` | Required. Canonical ID per 2.2 |
| `source_id` | For items: the item's own source, so item evidence can roll up to it. Required whenever the card shows its source; omitted only where the platform does not expose it on the card (for example the Instagram Explore grid). Never sent on source tags. |
| `verdict` | `slop`, `ai_fine` (AI-made but fine) or `not_slop` |
| `slop_type`, `tests` | Only with `verdict: "slop"`. Optional. |
| `platform_label` | Whether the platform's own AI label was on the item when tagged |

No other fields are accepted (unknown fields are a `400`).
A tag is rejected with `invalid_field` when `client_id` is not a UUID, when `slop_type` or a non-empty `tests` comes with a verdict other than `slop`, or when a source tag carries `source_id`.
Response `200`: `{"accepted": ["client_id", ...], "rejected": [{"client_id": "...", "error": "invalid_target"}]}`.
A later tag from the same install on the same target replaces the earlier one.
Limits per install: 60 per minute, 500 per day.

### 6.3 Reports

`POST /v1/reports` (Install).

```json
{
  "client_id": "uuid",
  "platform": "yt",
  "source_id": "@somechannel",
  "source_name": "Some Channel",
  "examples": ["dQw4w9WgXcQ"],
  "reason": "Posts 40 AI history videos a day with the same voice.",
  "slop_type": "filler",
  "tests": ["mass_produced"],
  "ext_version": "1.0.0"
}
```

`examples` holds 0 to 3 item IDs. `reason` is 1 to 500 characters. `source_name` is at most 120 characters.
Response `201`: `{"report": Report}`. Limit: 20 per install per day.

`GET /v1/reports` (Install) returns `{"reports": [Report, ...]}` for that install, newest first.

```json
{
  "id": "rpt_9x2k...",
  "platform": "yt",
  "source_id": "@somechannel",
  "source_name": "Some Channel",
  "status": "under_review",
  "verdict": null,
  "protects": 0,
  "created_at": "...",
  "updated_at": "..."
}
```

`status` is `under_review`, `slop`, `likely_slop`, `ai_made`, `disputed`, `clear` or `dismissed`.
`protects` is the estimated number of active installs that now receive the verdict (section 9.6), set once a verdict lands.
A report's status follows its source: it stays `under_review` until a reviewer decides or dismisses it, or until the source's list verdict changes after the report was filed, whichever comes first; it then shows that verdict.

### 6.4 Public source pages and the decision log

`GET /v1/sources/{platform}/{source_id}` returns `404` with code `not_rated` when the server knows nothing about the source, otherwise:

```json
{
  "source": {
    "platform": "yt",
    "id": "UC...",
    "aliases": ["UC...", "@somechannel"],
    "name": "Some Channel",
    "verdict": "likely_slop",
    "signals": ["platform_label", "mostly_ai", "community_consensus"],
    "slop_type": "filler",
    "tests": ["low_effort", "mass_produced"],
    "large": false,
    "audience_known": false,
    "imported": false,
    "attribution": null,
    "appeal_open": false,
    "updated_at": "...",
    "rescore_at": "...",
    "evidence": {
      "taggers": 41,
      "tags": { "slop": 35, "ai_fine": 4, "not_slop": 2 },
      "items_seen": 23,
      "ai_item_share": 0.91,
      "uploads_per_day": null
    }
  },
  "history": [LogEntry, ...]
}
```

`verdict` is `null` when the source is known but not rated. Fields without data are `null`.
A lookup by any alias returns the same source.
A source that only seed lists or the calibration set brought in (no verdict, tags, reports, appeals, decisions, items or log rows) answers `404 not_rated` too, with the same body as an unknown source, so no public answer can tell that a list names it.
`POST /v1/appeals` (6.5) answers such a source the same way.
`audience_known` is `true` once staff have recorded the source's size (the `large` decision field, 6.7), or, only with `YOUTUBE_DERIVED_USE` (9.7), when the YouTube Data API reported a subscriber count; `large` is then the recorded answer.
While it is `false`, the size is not known and `large` is `false`.

Public pages never name a data source, and never show YouTube Data API data:
- `imported` is always `false` and `attribution` always `null`. Both stay in the wire format for older clients and are deprecated. Seed lists are review leads only (9.3), so nothing public depends on them. The review API fills in `imported` for reviewers and `attribution` for staff (6.7).
- `evidence.uploads_per_day` is always `null`.
- `name` comes from viewers' reports, never from the YouTube Data API, so it is `null` until someone reports the source.

The decision log never names a data source either: reasons the scoring service writes never mention seed lists, and reviewers cannot publish a reason or reasoning that names one, imported or only in the registry, by name or ID (6.7).
The one public page that names datasets is `/credits` (14.3).
Log entries written before this rule were rewritten, and staff keep the original text internally: where the scoring service's reason named a seed list it now says "It met a rule Colander no longer uses", and a list's name in a reviewer's or an appeal's words reads `[withheld]`.
When a list is imported, its name is withheld the same way wherever the log already holds it.

`GET /v1/log?limit=&platform=&verdict=&cursor=` returns `{"entries": [LogEntry, ...], "next_cursor": "..." | null}`, newest first, default limit 50, max 200.

```json
{
  "id": "log_...",
  "at": "...",
  "platform": "yt",
  "target_type": "source",
  "target_id": "UC...",
  "source_id": "UC...",
  "source_name": "Some Channel",
  "from": "likely_slop",
  "to": "slop",
  "reason": "Staff review confirmed mass-produced narration over stock footage.",
  "signals": ["mostly_ai", "staff_review"],
  "actor": "staff",
  "actor_name": "Sam"
}
```

`actor` is `community` (the scoring service), `curator`, `staff` or `appeal`. `from` and `to` may be `null` (not rated).

`GET /v1/stats` returns public counts for the website: `{"sources": {"slop": n, "likely_slop": n, "ai_made": n, "disputed": n, "clear": n}, "items": n, "decisions_7d": n, "appeals": {"open": n, "median_days": x | null}, "active_installs": n, "list_sequence": n, "list_updated_at": "..."}`.

### 6.5 Appeals

| Request | Auth | Effect |
| --- | --- | --- |
| `POST /v1/appeals` `{"platform","source_id","email","statement"}` | none, 5 per IP per day | Creates an appeal. `201` `{"appeal": Appeal, "secret": "..."}`. The secret lets the creator check status and verify. It is also emailed as a link. An unknown source, or one only seed lists or the calibration set brought in, gets `404 not_rated` "Colander has no information about this source."; a known source without a verdict gets `404 not_rated` "This source has no verdict to appeal." |
| `GET /v1/appeals/{id}?secret=` | secret | `{"appeal": Appeal}` |
| `POST /v1/appeals/{id}/verify` `{"secret"}` | secret | Checks for the code on the account. YouTube is checked through the Data API when a key is configured and the day's budget allows (9.7), at most 10 times per appeal and 30 times per IP an hour. Otherwise the appeal moves to `pending_manual` for staff. |
| `POST /v1/review/appeals/{id}/verify` | staff | Staff confirm the code is on the account |
| `POST /v1/review/appeals/{id}/resolve` `{"outcome": "upheld" \| "denied", "reasoning"}` | staff | Upheld sets Clear. Denied restores the scored verdict. Both write the decision log, so `reasoning` that names a seed list gets `400 source_named` (6.7). |

```json
{
  "id": "apl_...",
  "platform": "yt",
  "source_id": "UC...",
  "source_name": "Some Channel",
  "code": "colander-7KQ2M9XD",
  "status": "awaiting_verification",
  "statement": "...",
  "outcome": null,
  "reasoning": null,
  "created_at": "...",
  "verified_at": null,
  "resolved_at": null
}
```

`status`: `awaiting_verification`, `pending_manual`, `under_review`, `upheld`, `denied`, `expired` (unverified after 14 days).
An appeal's email address is blanked 30 days after the appeal closes (upheld, denied or expired).
Once verified (`under_review`), the source verdict becomes Disputed at once and the next list publication carries it.
Appeal pages never show a support or donation link.

### 6.6 Accounts and sessions

Members and curators sign in through the Worker with a 6-digit code emailed to them, or with a passkey.
There are no passwords and no emailed sign-in links.

| Request | Effect |
| --- | --- |
| `POST /v1/auth/code` `{"email", "next", "turnstile"?}` | Emails a 6-digit code and sets the flow cookie `__Host-colander_flow` (HttpOnly, Secure, SameSite=Strict, Max-Age 600; `colander_flow` in dev). Always `202` for a valid address, so the answer never tells whether an account exists. 5 codes an hour and 10 a day per address, 30 an hour per IP (`429`). `turnstile` is required, and checked with Turnstile, only when `TURNSTILE_SECRET_KEY` is set (`400 turnstile_failed`). |
| `POST /v1/auth/code/verify` `{"code"}` | Needs the flow cookie of the same browser. A code works once, for 10 minutes; 5 wrong codes end it (`400 code_expired`), a wrong code is `400 code_invalid`, 30 tries an hour per IP. 10 wrong codes in a day for one address pause code sign-in for that address for 24 hours (`400 code_paused`; codes requested meanwhile are not sent, the answer is still `202`) and send one notice; passkeys keep working. `200` `{"account": Account}` with a new session; the first sign-in creates the account. |
| `POST /v1/auth/passkey/options` | A WebAuthn challenge, tied for 5 minutes to the passkey cookie `__Host-colander_pk` (HttpOnly, Secure, SameSite=Strict; `colander_pk` in dev), which is separate from the code's flow cookie, so a passkey prompt in another tab never ends a code that is waiting. With a session it is a step-up and allows only that account's passkeys (`409 no_passkey` when it has none). Without one, 60 an hour per IP. `200` `{"options"}` (PublicKeyCredentialRequestOptionsJSON). |
| `POST /v1/auth/passkey/verify` `{"credential"}` | Needs the passkey cookie. Signs in, or steps up, with a passkey: `200` `{"account"}` with a new passkey session, or `400 passkey_invalid`. The challenge is used up in the same transaction that records the signature counter and starts the session, so only one request can use it. A passkey sign-in cancels every request the account has waiting. |
| `POST /v1/auth/invite/options` `{"invite"}`, `POST /v1/auth/invite/verify` `{"invite", "credential", "name"}` | Enrolls a reviewer's passkey with an invite (6.9). Both need a session of the same account (an email code is enough), so an invite works only together with control of that mailbox. The invite works once, within 24 hours, and only while the account holds the role it was issued for (`400 invite_invalid`). Verify signs the session in with the new passkey and emails a notice. |
| `POST /v1/auth/verify` `{"token"}` | Finishes a sign-in link mailed before codes, for one release; links die 20 minutes after they were sent. `400 link_invalid` otherwise. |
| `POST /v1/auth/logout` `{"everywhere"?}` | Ends the session. `everywhere` ends every session of the account, its reviewer token and its unused pairing codes, and from a passkey sign-in of the last 10 minutes also removes every other passkey (with an email notice). |
| `POST /v1/auth/cancel` `{"secret"}` | The cancel link from a held-request email (below): `200` `{"cancelled": kind}` or `404`. |
| `GET /v1/account` | `200` `{"account": Account}` or `401 signed_out` |
| `PATCH /v1/account` `{"display_name"}` | Updates the public name used in the decision log and supporters page |
| `GET /v1/account/passkeys` | `{"passkeys": [{"id", "name", "created_at", "last_used_at", "synced"}], "current"}`, `current` the passkey this session signed in with |
| `POST /v1/account/passkeys/options`, `POST /v1/account/passkeys` `{"credential", "name"}` | Adds a passkey (`201` `{"passkey"}`), at most 10 per account (`409 too_many_passkeys`), with an email notice. A member needs a sign-in from the last 10 minutes, with a passkey once the account holds one; a curator, staff member or admin only from a passkey sign-in of that account (`403 passkey_required` with only a code; their first passkey comes from an invite, `403 invite_required`). Registration challenges use the passkey cookie too. |
| `DELETE /v1/account/passkeys/{id}` | Removes a passkey after a passkey sign-in of the last 10 minutes, with an email notice. Sessions that signed in with it count as email sign-ins from then on. |
| `GET /v1/account/export` | Everything kept about the account as a JSON attachment: the account, passkeys (name, dates, whether synced), session dates, the reviewer token's dates, the subscription summary, the synced settings, the decisions it authored, its calibration labels (14.5, never the frame that sampled the source), waiting requests, its recent pairing codes (kind, times, browser and version, never the code) and its audit events. |
| `DELETE /v1/account` | Ends Plus and deletes the account (6.8). `204`, and the session cookie is cleared. Staff and admin accounts are never deleted (`403 staff_account`): an admin lowers the role on the admin host first. |
| `POST /v1/account/requests` `{"kind", "passkey_id"?}`, `DELETE /v1/account/requests/{id}` | Held requests, below |
| `DELETE /v1/account/reviewer-token` | Disconnects the side panel and ends an unused reviewer code. A reviewer token comes only from a reviewer pairing code (section 7). |

```json
{
  "id": "acc_...", "email": "...", "display_name": "Sam", "role": "member", "plan": Plan | null, "created_at": "...",
  "session": { "method": "email" | "passkey", "authenticated_at": "..." } | null,
  "passkey_count": 0,
  "reviewer_token": { "expires_at": "...", "last_used_at": "..." | null } | null,
  "requests": [{ "id": "req_...", "kind": "delete" | "export" | "remove_passkey" | "email_change", "created_at": "...", "due_at": "...", "done_at": null }]
}
```

`role` is `member`, `curator`, `staff` or `admin` (6.9).
`session` describes the request's own session; answers that do not come from one leave it `null`.

Sessions are the SHA-256 of 32 random bytes, last 30 days, record `last_seen_at` at most hourly, and are new on every sign-in and every step-up: the old token ends.
A session from before code sign-in that still arrives under the old cookie name `colander_session` moves to `__Host-colander_session` with the same token, once, and only when no `__Host-` cookie came with it; sessions created since are never read under the old name.

Step-up: export, deletion, removing a passkey and adding one to an account that already holds one need a sign-in from the last 10 minutes (`403 recent_auth_required`), with a passkey whenever the account holds one (`403 passkey_required`); reviewer pairing codes always need a passkey sign-in from the last 10 minutes (section 7).
The website then asks the person to confirm with their passkey, or with an emailed code when the account has none, and repeats the request.

Held requests: an account that holds a passkey but was confirmed with an email code only may still ask for deletion, an export or removing a passkey it lost.
The request waits 72 hours; the email it sends has a cancel link to `{public_url}/account/cancel#<secret>`, and any passkey sign-in cancels it.
A staff or admin account cannot ask for deletion (`403 staff_account`), and a deletion that comes due after the account became staff is cancelled instead.
Then deletions and passkey removals run on their own, and a held export may be downloaded after a code sign-in of the last 10 minutes for 7 days.

Every sign-in, credential change, role change, staff action and read of personal data writes the audit log (6.9).
The one exception is a staff read of which seed lists name a source: `seed_provenance_reads` (6.7) records it for 24 months, longer than the audit log, and since it names the channel it stays out of the audit log; a restore loses its rows written after the restore point.
In dev mode (`COLANDER_DEV=1`) codes and other mail are printed in the `wrangler dev` output instead of emailed.

### 6.7 Review (curators and staff)

Authority depends on the host (6.9).
On getcolander.com a reviewer acts with curator authority at most: with a session that signed in with a passkey in the last 12 hours (`403 passkey_required` otherwise; an email code alone gives member rights) or with a reviewer token (`401 invalid_token`, or `401 token_expired` after its 7 days).
A reviewer token carries curator authority only, also a staff member's, because it works in any browser on any device.
On the admin host staff and admins act with their full role, through Cloudflare Access, and decide as `staff` in the public log.
Curators may decide sources that are not large and items; large sources and appeals need staff authority (`403 staff_required`, "Staff decide them in the admin console").

| Request | Returns |
| --- | --- |
| `GET /v1/review/queue?kind=all\|reports\|appeals\|escalations\|leads&cursor=` | `{"items": [QueueItem], "next_cursor"}` ordered by priority then age. `leads` lists only seed leads, and `escalations` includes them all; `all` includes only the priority-3 ones that something backs, so thousands of leads do not bury the reports. |
| `GET /v1/review/sources/{platform}/{source_id}` | `{"source": Source, "seed_lists": n, "layers": Layers, "reports": [ReportDetail], "appeals": [Appeal], "items": [ItemSummary], "history": [LogEntry]}`, and with staff authority (the admin host) also `"seeds": [SeedProvenance]` and `"seed_suppression": {"at", "reason"} \| null`. Unlike the public page, `source.imported` is true when a live seed list entry (14.4) names the source, and `seed_lists` counts those lists for every reviewer. Only staff authority learns which lists: `source.attribution` then names each with its license and use, for example `Example List (CC0-1.0), lead`, and is `null` with curator authority, which is all getcolander.com and a reviewer token give, also to staff. Each read that shows a staff account any `seeds` is recorded in `seed_provenance_reads` (account, source, registry IDs, time), never shown, and deleted after 24 months. |
| `POST /v1/review/sources/{platform}/{source_id}/decision` | Body `{"verdict": Verdict \| "none", "reason", "signals": [Signal], "slop_type", "tests", "large": bool?}`. Writes the log and publishes. Slop and Likely slop need AI evidence: `400 ai_evidence_required` unless the provenance layer is met or the body records a provenance signal. Curators get `403 staff_required` for large sources and for sources with an appeal in `pending_manual` or `under_review`. A reason that names a seed list Colander imported, or any registry dataset by any of its names (14.3), gets `400 source_named`, as does appeal `reasoning` (6.5). |
| `POST /v1/review/sources/{platform}/{source_id}/suppress-seeds` `{"reason", "lift": bool?}` | Staff authority only, so the admin host only (`403 staff_required` elsewhere). Suppresses seed lists on the source, for an objection under GDPR Article 21 or a case staff closed: its seed entries and calibration item are deleted, and no import or sample takes it again. `"lift": true` lifts it. `reason` (1 to 500 characters) is for staff and never published. Answers the review source. |
| `GET /v1/review/calibration/next` | `{"item": CalibrationItem \| null}`: the next calibration item this reviewer has not labeled (14.5). Staff authority (the admin host) also gets items whose two labels disagree, for a third. |
| `POST /v1/review/calibration/{platform}/{source_id}/label` `{"label", "tests", "evidence", "note"?, "language"?, "kind"?}` | Records this reviewer's label and answers the next item as above. `label` is `slop`, `ai_not_slop`, `not_ai`, `gone` or `unsure`; `tests` (low_effort, mass_produced, hollow) go with `slop` only; `evidence` holds the provenance signals the labeler saw on the platform; `note` is at most 500 characters. Every label but `gone` and `unsure` needs `language`, one of `CALIBRATION_LANGUAGES` in `packages/shared/src/api.ts` (`en`, `es` and so on, `other`, or `none` for no words), and `kind`, `music` or `video` (`400 invalid_language`, `400 invalid_kind`); `gone` and `unsure` record neither. `404 not_in_calibration`, `409 already_labeled`. |
| `POST /v1/review/items/{platform}/{item_id}/decision` | Same body plus `"source_id"` |
| `POST /v1/review/reports/{id}/dismiss` `{"reason"}` | Closes a report with no verdict change |

```json
{
  "id": "q_...",
  "kind": "report",
  "priority": 2,
  "created_at": "...",
  "platform": "yt",
  "source_id": "UC...",
  "source_name": "...",
  "summary": "3 reports: mass-produced history narration",
  "large": false,
  "verdict": "likely_slop",
  "computed_verdict": "slop",
  "report_count": 3,
  "lead": false
}
```

`kind` is `report`, `appeal` or `escalation`. Escalations are raised by the scoring service (section 9); `lead` is true for a seed lead, an escalation of its own kind (9.5), whose summary counts the seed lists and never names one, for example `Seed lead on 2 seed lists, not evidence`.
Priority 1 is an appeal, or an appeal escalation; 2 is any other escalation except a seed lead; 3 is a report, or a seed lead backed by an open report, a slop tag or a calibrated `seed` list that names its YouTube channel ID; 4 is any other seed lead. A large source moves up by one, never above 1.

```json
{
  "seed": "example-list",
  "name": "Example List",
  "license": "CC0-1.0",
  "use": "lead",
  "platform": "yt",
  "alias": "@somechannel",
  "batch": 3,
  "imported_at": "...",
  "listed_at": "...",
  "expires_at": "...",
  "note": null
}
```

`SeedProvenance` is one live seed entry: the registry entry, the ID as the file listed it, the import batch, when that batch ran, the upstream date of the file (from which expiry counts), when the entry stops being a lead, and `note`, where staff saw the source for Colander's own lists (14.1), otherwise `null`.
`CalibrationItem` is `{"platform", "source_id", "labels"}`: only what a labeler needs to find the source on its platform, and how many labels it has; never its verdict, tags or seed lists.
`Layers` is `{"provenance": Layer, "behavior": Layer, "rubric": Layer, "consensus": Layer}` with `Layer = {"met": bool, "signals": [Signal], "detail": "Plain sentence"}`.

### 6.8 Billing and entitlements

| Request | Auth | Effect |
| --- | --- | --- |
| `POST /v1/trial` | Install | `200` `{"token": PlanToken}` for a 14-day Plus trial, once per install (`409 trial_used` after) and 5 per IP a day. No card, no account. The trial's synced settings are deleted once it ends. |
| `POST /v1/billing/checkout` `{"price": "plus_yearly" \| "plus_monthly"}` | Session | `200` `{"url": "<hosted checkout>"}`. `400 invalid_price` for any other price. `409 already_subscribed` while the account's plan is `active`, `trialing` or `past_due`. |
| `POST /v1/billing/donate` `{"amount_cents", "recurring", "credit_name"}` | none | `200` `{"url"}`. `amount_cents` 100 to 100000 (`400 invalid_amount`). `credit_name` optional, one line of at most 80 characters (`400 invalid_credit_name`), shown on the supporters page if set. 10 per IP per hour. |
| `POST /v1/billing/cancel` `{"refund": bool}` | Session | `200` `{"account": Account}`. Cancels at period end; repeating it changes nothing. With `refund: true` and a charge under 30 days old, refunds it and ends Plus now, also after an earlier cancel at period end. `409 not_refundable` (nothing changes) when `refund` is true and the charge is older. `404 no_plan` without a running plan. |
| `POST /v1/billing/webhook` | Stripe signature | Subscription and payment events. `400 invalid_signature` for a bad or stale signature; `200` for applied, ignored and repeated events; `500` asks Stripe to retry. |
| `POST /v1/entitlement` | Session | `200` `{"token": PlanToken}` when the account has an active plan, else `404 no_plan` |
| `POST /v1/entitlement/refresh` `{"token"}` | none | A fresh token if the subscription behind it is still active, else `404 no_plan`. The token may have expired but must verify (`400 invalid_plan`). Trial tokens always get `404 no_plan`. |
| `GET /v1/supporters` | none | `{"supporters": [{"name", "since"}]}` for supporters who opted into credit |
| `GET /v1/sync`, `PUT /v1/sync` `{"version", "data"}` | Plan | Plus settings sync. `data` is an opaque JSON object up to 64 KB. `PUT` with a stale `version` gets `409` and the current blob. |

`Plan` in the account object: `{"plan": "plus", "interval": "year" | "month", "status": "active" | "trialing" | "past_due" | "canceled", "current_period_end": "...", "cancel_at_period_end": bool, "refundable": bool}`.
`plan` is `null` until the account first subscribes, and an ended subscription stays as `canceled` (Stripe's `unpaid`, `paused` and `incomplete_expired` also show as `canceled`).
`refundable` is true while the plan runs and its latest charge is under 30 days old and not refunded.

Paid plan tokens carry the account ID as `sub`, so settings sync keeps one blob per account across renewals, refreshes and browsers.
Their `exp` is `current_period_end` plus 3 days; while a renewal payment is retried (`past_due`) it is the start of the unpaid period plus 3 days, and no token is issued once that has passed.

Without `STRIPE_SECRET_KEY` every `/v1/billing/*` route answers `503 billing_unavailable`, and the webhook does so without `STRIPE_WEBHOOK_SECRET` too.
Entitlements and supporters keep answering from stored state.

Checkout returns to `{public_url}/plans/welcome` after paying and to `{public_url}/plans?checkout=<price>&cancelled=1` when closed.
Donations return to `{public_url}/support/thanks` and `{public_url}/support?cancelled=1`.

Supporters are donors who gave a `credit_name`, newest first by their first donation; a repeated name appears once.
Refunded donations drop off the list, and amounts and emails are never shown.
A donor's credit is changed or cleared on request by an admin, by the Checkout Session ID on the receipt (6.9).

Deleting an account (`DELETE /v1/account`) settles billing first: a running Plus ends at once, its latest charge is refunded when it is still refundable, and every Stripe customer of the account is deleted (Stripe keeps what tax law requires).
Without Stripe keys an account that ever subscribed cannot be deleted (`503 billing_unavailable`), so nothing is deleted half way.
Then, in one transaction, the account goes with its sessions, passkeys, flows, reviewer token, pairing codes, held requests and subscriptions; its synced settings and calibration labels go; its decisions and log entries keep no name, so the log shows a former reviewer; and an `account_deleted` audit row remains.
An erasure record in the backup bucket makes a later restore of a dump or of an earlier point in time delete the account again before anything else.
Later Stripe webhooks for the account are ignored as belonging to an unknown account.
`DELETE /v1/install` (Install) erases what the server holds for one install: its tags, reports, trial and the trial's synced settings; the sources they touched are scored again.

### 6.9 Roles, the admin host and the admin API

There are four roles in one column, with a fixed permission table in code (`api/src/permissions.ts`); the Store refuses any other value.

| Permission | member | curator | staff | admin | Where |
| --- | --- | --- | --- | --- | --- |
| Own account: name, passkeys, sign out everywhere, export | yes | yes | yes | yes | Main host, session |
| Delete own account | yes | yes | - | - | Main host, session; an admin lowers a staff or admin role first |
| Checkout, cancel, refund, plan tokens | yes | yes | yes | yes | Main host, session |
| Review queue and source detail; decide items and sources that are not large; dismiss reports | - | yes | yes | yes | Main host with a fresh passkey session or a reviewer token; the admin host |
| Decide large sources, set the large flag, verify and resolve appeals | - | - | yes | yes | Admin host only |
| See which seed lists name a lead, with their provenance; suppress seed lists on a source; give the third calibration label | - | - | yes | yes | Admin host only |
| People list; grant or revoke curator; issue curator passkey invites | - | - | yes | yes | Admin host only |
| Grant or revoke staff; invite staff and admins; end every credential of an account; change a member's email | - | - | - | yes | Admin host only |
| Change supporter credit, read the audit log | - | - | - | yes | Admin host only |

Roles change only on accounts strictly below the actor's role and only to roles strictly below it, never on the actor's own account, and never to admin.
Admin is granted only through the ops channel's bootstrap (`grant-role` grants staff and admin only until it first grants admin, and never again, even if no admin is left).
Raising an account to curator or above ends its sessions and deletes its passkeys, reviewer token and unused pairing codes in the same transaction, so a passkey added while it was a member never carries review authority; lowering it below curator deletes the reviewer token, and a reviewer code still waiting is then refused at the claim (`403 forbidden`).
Nobody issues an invite for their own account.

The admin hosts are `admin.getcolander.com`, `staging-admin.getcolander.com` and, in dev, `admin.localhost` on the dev port (`ADMIN_HOST`, 10).
Cloudflare Access protects them, with A3T Identity as the identity provider and independent MFA by security key or platform biometric; One-time PIN with pre-enrolled keys is the fallback.
The edge verifies the Access application token on every admin-host request that reaches the Worker (RS256 against `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `iss`, `aud` equal to `CF_ACCESS_AUD`, `exp`, `nbf`, type `app`, an email) and answers `403 access_required` to anything else, including an environment without both values.
The Store finds the account by the Access email and requires role `staff` or `admin` (`403 not_staff`).
A3T Identity passes its subject as the custom OIDC claim `sub`: the first sign-in pins it on the account (`a3t:<sub>`), and a token with another subject is refused after that; a token without one comes from One-time PIN.
The admin host serves only `/v1/admin/*` and `/v1/review/*` of the API (anything else is `404`), with no CORS; `/` sends to `/admin`.
On getcolander.com `/admin` and `/admin/*` redirect to the admin host, and `/v1/admin/*` is `404`.
In dev mode on `http://localhost` only, `POST /__dev/access` `{"email", "subject"?}` on `admin.localhost` stands in for Access: it answers a token and sets the `CF_Authorization` cookie, signed by a key that exists only in that process and trusted nowhere else.

| Request | Permission | Effect |
| --- | --- | --- |
| `GET /v1/admin/me` | staff | `{"account": Person, "authority", "permissions"}` |
| `GET /v1/admin/people?q=` | staff | Up to 50 accounts whose email contains `q` (audited with the IDs found, never `q`), or every reviewer. |
| `PUT /v1/admin/people/role` `{"email", "role"}` | staff | Sets the role (creates a member account for a new address). `{"person": Person}` |
| `POST /v1/admin/people/{id}/invite` | staff | `201` `{"invite", "url", "expires_at"}`: a single-use invite for a review account, valid 24 hours, bound to the account and its role, shown only to the issuer; the account gets an email notice. `url` is `{public_url}/account/invite#invite=<invite>`. |
| `POST /v1/admin/people/{id}/revoke` | admin | Ends every session and deletes every passkey, the reviewer token and the unused pairing codes |
| `PUT /v1/admin/people/{id}/email` `{"email", "checkout_session", "amount_cents", "date"}` | admin | Members only. Checks the Checkout Session with Stripe (this account's checkout, the amount and the UTC date `YYYY-MM-DD`; `400 receipt_mismatch`), then holds the move 7 days with a cancel link to the old address. When it runs, every session, passkey and token ends and both addresses hear; an account raised to a review role meanwhile is not moved, and the change is cancelled. `{"due_at"}` |
| `POST /v1/admin/donations/{id}/credit` `{"credit_name"}` | admin | Replaces or clears (`""`) a donor's supporter credit by Checkout Session ID |
| `GET /v1/admin/audit?target=&before=` | admin | The newest 100 audit rows, `{"entries", "next_cursor"}`. Audited. |

```json
{ "id": "acc_...", "email": "...", "display_name": "Sam", "role": "curator", "created_at": "...", "passkey_count": 1, "access_pinned": false }
```

The audit log is one insert-only table: `at`, `actor_id`, `actor_sub` (`a3t:`, `otp:` or `github:`), `actor_email`, `host` (`main`, `admin`, `ops` or `job`), `action`, `target`, `before`, `after`, `reason` and `request_id` (the cf-ray or the GitHub run).
Triggers refuse any update and any delete of a row younger than 400 days; a restore keeps the rows written since the dump.
Every day its new rows are copied to `audit/` in the backup bucket, under a 400-day bucket lock.
A point-in-time restore copies the rows first, its own `ops:pitr-restore` row included, and after the restart puts back from `audit/` every row written after the restore point.
After either restore every session, reviewer token, unused pairing code and sign-in flow ends, and what the rows written after the restore point took away goes again: passkeys of revoked accounts and moved addresses, removed passkeys and those a sign out everywhere took (its row names the passkey it kept), lowered roles, A3T subject pins, and cancelled or refused held requests; a raised role is not raised again.
Seed list suppressions and lifts are repeated from their own records (14.4).
It names members by account ID, never by address: a people search records the IDs it found, and an email change a short hash of each address (`sha256:` and 16 hex digits of SHA-256 over `audit:` and the address), so no member's address outlives their account in it.

## 7. Website and extension handoff

The website hands a plan token or a reviewer token to the extension with a pairing code, the same way in every browser.
A reviewer token is never issued any other way.
The website never talks to the extension directly, so nothing depends on an extension ID, a host permission or the browser.
A code also works when the website is open in another browser or on another device.

| Request | Auth | Effect |
| --- | --- | --- |
| `POST /v1/pair` `{"kind": "plan" \| "reviewer"}` | Session | `201` `{"id", "code": "KXQ4-JP7M", "expires_at"}`. `plan` needs an active plan (`404 no_plan`); `reviewer` needs the curator, staff or admin role (`403 forbidden`) and a passkey sign-in of the last 10 minutes (`403 passkey_required`, `403 recent_auth_required`); any other kind is `400 invalid_kind`. A new code ends the account's earlier unused code of the same kind. 20 codes per account an hour. |
| `GET /v1/pair/{id}` | Session | `200` `{"status": "pending" \| "claimed" \| "expired", "ext_version", "browser"}` for the account's own code, `404 not_found` for any other. The website checks every 2 seconds while the code is on screen. |
| `POST /v1/pair/claim` `{"code", "ext_version", "browser"}` | none, any origin | `200` `{"kind", "token", "account"}`: a plan token (section 5) minted now for the account, or a reviewer token (6.6: 7 days, curator authority only, audited as `token_issued`) that replaces the account's earlier one; `account` is the account's email masked as `p***@example.com`, so the person sees whose account they connected. `404 invalid_code` for a wrong, used or expired code; `404 no_plan` when the plan ended since the code was made; `403 forbidden` when the role went; these leave the code unused. 10 claims per address per 10 minutes, an IPv6 address counted by its /48, wrong codes included (`429`). |

A code is 8 Crockford base32 characters (40 bits), shown as two groups of 4.
The server reads a typed code without regard to case, spaces or dashes, and reads I and L as 1 and O as 0.
Codes are stored only as SHA-256, last 10 minutes and work once; the hourly prune deletes them an hour after they expire.
`ext_version` is the extension's version and `browser` one of `chrome`, `edge`, `brave`, `opera`, `firefox`, `safari` and `chromium`, so the website can say "Connected Colander 1.4.0 in Firefox"; anything else is `400 invalid_field`.

The website shows the code and the extension takes it, never the reverse: a link the extension opened could be crafted by someone else (the device-code phishing pattern), while a code the person types into their own extension leaks only if they hand it over.
The website says "Never share this code" beside it, with its countdown.
The person types it in Options under Plan or in the review side panel; the extension stores a plan token only after it verifies it (section 5), and shows the masked email of the account it came from.
Wrong codes from all addresses together are counted, and the watchdog alerts when they reach 300 an hour; that count never refuses a claim, so a guesser cannot lock anyone out.

Unpacked development builds of the Chrome extension carry a fixed manifest `key`, so the end-to-end tests can open its pages by ID; store packages never carry one.

## 8. Privacy rules for the network

The extension makes exactly these requests: list snapshot and deltas, adapter configuration, tags, reports, report status, trial, entitlement refresh, pairing claims, settings sync (Plus) and the review API (reviewers only).
No request ever carries a page URL, the user's platform account name, or watch history.
List downloads carry no identifier at all.
A pairing claim carries the code, the extension version and the browser name, and never the install ID.

Firefox asks before an add-on sends data, so the Firefox build declares no required data collection and two optional kinds, which Firefox grants only when the person allows each:
- `websiteContent` for tags and reports, which carry what was seen on a page and the install ID. Until it is allowed, tags wait in the queue on the device and Options opens at Sharing, where one click allows it; a report is refused with that explanation.
- `authenticationInfo` for the trial, the entitlement refresh, settings sync, pairing claims and the review API, which carry or fetch a plan or reviewer token. Start 14 days free and Connect ask for it from their click.

List downloads and the adapter configuration need neither, because they carry no identifier.
Server logs never record request paths that contain item or source IDs together with an install hash.

## 9. Scoring (normative for the server)

Thresholds here are the starting values the spec asks to calibrate.
Keep them in one place: `Thresholds` in `api/src/scoring/rules.ts`.

### 9.1 Reputation

Each install's latest tag per target counts with weight `w = clamp(0.1 + 0.9 * maturity * accuracy, 0.05, 1.0)`.
`maturity = min(1, days since the install's first tag / 30)`.
`accuracy = (agree + 1) / (decided + 2)`, over the install's tags on targets that now hold a staff, appeal or consensus verdict (Slop or Likely slop with `community_consensus`, or Clear with `not_slop_consensus`; AI-made verdicts from community AI consensus are excluded because they would feed back into the weights that produced them).
A tag agrees when `slop` meets Slop or Likely slop, `not_slop` meets Clear, and `ai_fine` meets AI-made.
Plan, payment and donation state are never inputs.

### 9.2 Tag sums per target

`S`, `A` and `N` are the weighted sums of `slop`, `ai_fine` and `not_slop` tags. `T = S + A + N`. `n` is the number of distinct installs.

### 9.3 Layers

- Provenance (AI evidence) is met when any holds: at least 2 distinct installs reported `platform_label` on the target (for a source that is not mixed, on any of its items); staff recorded `platform_label`, `content_credentials`, `creator_statement` or `watermark`; or community AI consensus: `S + A >= 3`, `n >= 3` and `(S + A) / T >= 0.7`.
- Behavior (sources; items inherit their source's) is met when any holds: `ai_item_share >= 0.8` over at least 5 items seen with evidence (Kagi's 80% rule, emitted as `mostly_ai`), where an item counts as AI-made only through independent evidence (platform label reports from 2 or more installs, or a reviewer decision), never through community AI consensus, so tags alone cannot make a source look mass-produced; staff recorded `high_volume`, `templated`, `near_duplicates`, `link_funnel` or `cross_posting`; or, only with `YOUTUBE_DERIVED_USE` (9.7), uploads per day of at least 10 from the YouTube Data API.
- Rubric is met when, among slop tags with `S >= 1`, at least two of the three tests are each selected by a weighted share of 0.5 or more. `mass_produced` also counts as selected when Behavior is met. Emits `rubric_low_effort` and `rubric_hollow` where they pass.
- Consensus for slop: `S >= 3`, `n >= 3`, `S / T >= 0.7`, and the source is not frozen by burst detection. Emits `community_consensus`.
- Not-slop consensus: `N >= 3` and `N / T >= 0.7`. Emits `not_slop_consensus`.
- Split: `S >= 2`, `N + A >= 2` and `0.3 <= S / T <= 0.7`.

An entry of a seed list (section 14) is a review lead, never evidence: it meets no layer, and on its own it never gives a verdict or a list entry.
A source with community or staff evidence gets exactly the verdict that evidence gives without the seed list.
The lead only puts the source in the review queue (9.5).
Imports from before the license check, which took lists of any license, were cleared: for audits, staff keep only each list's name, license, entry count and a hash of the cleared IDs.
Imports from before the seed registry (migration 8) raise no lead either; only registry entries in `seed_entries` do.

### 9.4 Verdict, first rule that matches wins

1. A verified open appeal: Disputed (`open_appeal`).
2. An unexpired staff or curator decision: that verdict.
3. Not-slop consensus: Clear.
4. No provenance: not rated (no list entry).
5. Split: Disputed.
6. Provenance, Behavior and Consensus all met: Slop, except that it is capped at Likely slop and raises an escalation when the source is large, or when its audience size is unknown (staff never recorded its size, and, with `YOUTUBE_DERIVED_USE` only, the YouTube Data API reported no subscriber count). Only a reviewer can then make it Slop. Without `YOUTUBE_DERIVED_USE`, every source whose size staff have not recorded stays at Likely slop until a reviewer decides.
7. Provenance and (Behavior or Rubric), with `S >= 1`: Likely slop.
8. Provenance only: AI-made.

Sources become mixed when at least 5 items have been seen and `ai_item_share < 0.8`.
A mixed source gets no source-level Slop or Likely slop verdict, item label reports do not count toward its provenance (it falls to rule 8 only on source-level evidence, otherwise not rated), and its items are scored on their own and keep their own list entries.
Item entries are emitted only when an item has its own verdict that differs from its source's list verdict.
Signals on a list entry are the union of the signals that fired for the layers that were met.

### 9.5 Expiry, escalations and brigading

- Every list verdict carries `rescore_at = changed_at + 90 days`. At expiry, staff and curator decisions lapse and the target is scored again; if the result is Slop it becomes an escalation and stays Likely slop until reviewed.
- An escalation is raised when: rule 6 is capped; 3 or more open reports exist on a source; a burst is detected; a verdict lapses into Slop; a live entry of a cleared lead or seed list (14.4) names a source that no reviewer has decided and on which staff have not suppressed seed lists (a seed lead). A reviewer's decision on the source closes the seed lead for good, and so do the entry's expiry, its list losing its clearance, and a suppression.
- Burst: more than 20 slop tags in one hour on one source from installs younger than 7 days. The consensus layer of that source is frozen for 72 hours and an escalation is raised.
- A source is large when staff set `large`, or, only with `YOUTUBE_DERIVED_USE` (9.7), when the YouTube Data API reports 100,000 subscribers or more. A source whose audience is unknown is treated like a large one for rule 6 only, and is not shown as large.
- The scoring pass runs every 5 minutes and, debounced by 5 seconds, after any review decision, appeal change or report.
- Every verdict change writes a decision log entry. Changes made by the scoring pass use actor `community` and a reason generated from the signals.

### 9.6 Active install estimate

List snapshot and delta requests are counted per UTC hour without any identifier.
The counts come from edge analytics: every hour the Worker reads the number of `/v1/list/*` requests to its host in each whole hour (`httpRequestsAdaptiveGroups`, cache hits included) into `list_requests`.
`active_installs = round(requests in the last 24 counted hours / 24)`, because each install syncs hourly.
Dev mode has no edge analytics, so there the Worker counts the requests itself.

### 9.7 YouTube Data API

The Worker follows the YouTube API Services Developer Policies:
- Retention: figures and responses obtained with the API key alone are never kept 30 days.
  Responses are not cached, so the per-channel figures are dated by the call that returned them; the hourly prune deletes them once they are 29 days old, and a source still needed is looked up again after 20 days.
  Dumps create that table but hold none of its rows, so no backup keeps the figures.
  Dumps taken before migration 5 did hold API data: restoring one runs that migration's data changes on its rows again, and the runbook deletes them (deploy.md, "Dumps from before migration 5").
- Identifiers: a lookup links the channel ID and handle it returns to the source as aliases, and the channel ID becomes its canonical ID.
  The next lookup refreshes them, but they are not deleted: they are dumped, published in a source's `id` and `aliases`, and listed, until counsel confirms whether identifiers found through the API may be kept and shipped.
- Names: the API's channel title is never stored. Source names and the decision log's `source_name` come from viewers' reports.
- Derived metrics: subscriber counts and uploads per day feed scoring (Behavior's `high_volume`, `large` and a known audience) only when `YOUTUBE_DERIVED_USE` is `1`, which needs YouTube's approval first. Off, uploads per day is never computed and no figure is stored; a lookup only links a channel ID and its handle.
- Quota: every call is charged to a ledger of the Pacific date (YouTube resets quotas at midnight Pacific Time) with its unit cost before it is made, failed calls included, and no call is made once the day's charges would pass `YOUTUBE_DAILY_UNITS`.
  When YouTube answers `quotaExceeded`, the day counts as used up.
  Production and staging use one Google Cloud project and each keeps its own ledger, so their budgets together stay at 8,000 of the project's 10,000 units.
  A restore keeps the larger count of each day, so units spent stay spent.
- Rate: each scoring pass looks up at most 10 channels, and background lookups stop once the day's charges reach 80% of the budget, which keeps the rest for appeal checks: with derived use a lookup can cost 21 units.
  A channel that fails is logged and waits for its next refresh while the others go on; a used-up share ends the lookups until the next Pacific day.
  Appeal checks fall back to staff when the whole budget is used up.

## 10. Configuration of the Worker

Vars are set per environment in `api/wrangler.jsonc`.
Secrets are set per environment with `wrangler secret put`, and for `wrangler dev` in `api/.dev.vars`, which git ignores.
The client address always comes from `CF-Connecting-IP`.

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `COLANDER_SIGNING_KEY` | secret, required | - | Base64 of the 32-byte Ed25519 seed (section 12) |
| `IP_SALT` | secret, required | - | Salt of the HMAC that hashes client addresses before any rate limit or storage |
| `PUBLIC_URL` | var | `https://getcolander.com` | Origin used in emails and redirects; its host is the passkey relying party ID and its origin the only accepted passkey origin |
| `COLANDER_DEV` | var | empty | `1` is dev mode: mail printed instead of sent, plain cookie names without Secure, no miss rate limiter, list requests counted by the Worker, and the `/__dev/*` routes. With a `PUBLIC_URL` on `http://localhost` it also makes the admin host `admin.localhost`, with the dev Access stub, and lets the ops channel take `OPS_TOKEN`. |
| `ADMIN_HOST` | var | `admin.getcolander.com`; staging `staging-admin.getcolander.com` | The admin host (6.9); empty means none |
| `CF_ACCESS_TEAM_DOMAIN` | var | empty | The Access team domain, `<team>.cloudflareaccess.com`; until it and `CF_ACCESS_AUD` are set the admin host answers `403` |
| `CF_ACCESS_AUD` | var | empty | The AUD tag of the environment's Access application for the admin host |
| `OPS_GITHUB_REPOSITORY`, `OPS_GITHUB_REPOSITORY_ID` | var | `rudecompany/colander`, its numeric ID | The only repository whose GitHub Actions OIDC tokens the ops channel takes |
| `OPS_GITHUB_ENVIRONMENT` | var | `production`; staging `staging` | The GitHub environment those tokens must name |
| `OPS_TOKEN` | dev only | unset | The ops bearer of `api/.dev.vars`, taken only in dev mode on `http://localhost` |
| `TURNSTILE_SECRET_KEY` | secret, optional | unset | Turnstile on `POST /v1/auth/code`; set it together with the website's `PUBLIC_TURNSTILE_SITE_KEY` |
| `COLANDER_TEST_NOW` | var, dev only | unset | An RFC 3339 time that freezes the clock when `COLANDER_DEV=1`; then no job runs on its own |
| `COLANDER_MAIL_FROM` | var | `Colander <hello@getcolander.com>` | Sender of sign-in, appeal and billing mail |
| `RESEND_API_KEY` | secret, optional | unset | Resend, the fallback when the Email Sending binding fails |
| `YOUTUBE_API_KEY` | secret, optional | unset | YouTube lookups (channel ID and handle) and automatic appeal verification (9.7) |
| `YOUTUBE_DAILY_UNITS` | var | `8000`; `api/wrangler.jsonc` sets `7000` in production and `1000` in staging | YouTube Data API units the Worker may spend per Pacific day. Both environments share one project's 10,000, so their values add up to 8,000 at most (9.7). |
| `YOUTUBE_DERIVED_USE` | var | empty, which is off | `1` lets subscriber counts and uploads per day feed scoring. Set it only after YouTube approves Colander's derived metrics (9.7). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret, optional | unset | Billing. Without them billing routes answer `503 billing_unavailable`. |
| `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY` | var | empty | Price IDs of the Plus prices; checkout answers `503 billing_unavailable` until they are set |
| `STRIPE_MANAGED_PAYMENTS` | var | empty, which is on | Plus checkout with Stripe Managed Payments as merchant of record. `0` turns it off. |
| `STRIPE_API_BASE` | var, optional | `https://api.stripe.com` | Stripe API origin, for tests against a fake |
| `CF_ANALYTICS_TOKEN` | secret, optional | unset | Zone Analytics read token for the hourly list request count (section 9.6) |
| `CF_ZONE_ID` | var | empty | Zone of that count; empty skips the hourly pull |
| `ALERT_ADDRESS` | var | the ops address | Recipient of watchdog alerts; must equal `destination_address` of the `ALERTS` binding |

The bindings are `STORE` (the `Store` Durable Object), `LISTS` and `BACKUPS` (R2), `EMAIL` and `ALERTS` (Email Sending), `MISSES` (Rate Limiting) and `ASSETS` (the website).

## 11. Extension build configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `WXT_COLANDER_API` | `http://localhost:8787` | Server origin |
| `WXT_COLANDER_PUBLIC_KEYS` | the dev key from `testdata/dev-signing.pub` | Trusted Ed25519 public keys |
| `WXT_COLANDER_SITE` | same as the API | Website origin for links |
| `WXT_COLANDER_STORE_BUILD` | unset | `1` leaves the development manifest `key` out; `extension/scripts/build-store.sh` sets it |

Store packages are built by `extension/scripts/build-store.sh chrome|edge|firefox` from `extension/release.env`, which holds these values for production and is committed, so AMO's reviewers rebuild the Firefox package from its sources zip byte for byte.

## 12. Keys

`COLANDER_SIGNING_KEY` is the base64 of the 32-byte Ed25519 seed.
Public keys are the base64 of the raw 32-byte key, and lists and envelopes carry the key ID (sections 3 and 4), so clients pick the right trusted key.

Key custody:
- Production and staging keys are made on a trusted offline machine with `make keygen` (`scripts/keygen.ts`), which never overwrites a file and prints the public key and key ID.
- The seed lives only in the Worker secret of its environment (`wrangler secret put COLANDER_SIGNING_KEY`) and in two offline copies of each production key; Worker secrets cannot be read back, so those copies are the only way to recover it.
- A key is never committed, never stored in GitHub and never sent over the ops channel: `sign-config` signs with the Worker's own key.
- Staging has its own key, which no release build trusts.
- Release builds of the extension trust the current and the next production public key (`WXT_COLANDER_PUBLIC_KEYS`), so the key rotates without breaking an updated install (`docs/deploy.md`, "Rotate the signing key").

`testdata/dev-signing.key` and `.pub` are a published development pair for local runs and tests only.

## 13. Contract fixtures

`testdata/contract/` holds signed fixtures generated by `node testdata/contract/generate.mjs`, an independent Node implementation, with the development key.
`list-snapshot.bin` and `list-delta.bin` follow section 3; `list-expected.json` lists their decoded entries (with the target key, hash hex and the ISO date the `updated` day number came from) and the 7 entries left after applying the delta.
One entry, `yt:s:@catrescuetales`, sets flag bit 5 (`imported`), as lists published before bit 5 was reserved did: decoders must still read it, while the Worker's lists always write it as 0.
`config-envelope.json` follows section 4 with payload `{"version":7,"note":"contract fixture"}`.
`plan-token.txt` follows section 5.
The TypeScript encoder in `packages/shared/src/list.ts`, which the Worker publishes with, is the byte-for-byte reference: it must reproduce `list-snapshot.bin` and `list-delta.bin` from `list-expected.json`.
The signers in `packages/shared/src/signing.ts` must reproduce `config-envelope.json` and `plan-token.txt`, and the decoders the Worker and the extension use must verify and decode all fixtures.
Never edit the fixtures by hand; change the generator and rerun it.

## 14. Seed sources

Outside datasets reach Colander only through the seed registry, `packages/shared/src/seed-registry.json`.
Its shape is `packages/shared/src/seed-registry.schema.json`; its rules are `validateEntry` in `packages/shared/src/seeds.ts`, which CI runs through `scripts/check-seeds.ts` and the Worker runs again before every import.
The Worker bundles the registry; the website reads it only to prerender `/credits`; the extension never reads it.

### 14.1 Entries

| Field | Meaning |
| --- | --- |
| `id` | Stable ID, 3 to 63 lowercase letters, digits and dashes. Also the key `seeds/<id>.json` of its object in the private backup bucket. |
| `name`, `homepage` | The dataset's own name and page, as `/credits` shows them |
| `aliases` | Other names people know the dataset by, each at least 4 characters, such as a short name or its domain; at least one for a third-party dataset (14.3) |
| `platforms` | The platforms read from the file; a `lines` file holds one |
| `license`, `license_url`, `attribution` | SPDX identifier (or `LicenseRef-written-grant`, `LicenseRef-Colander-internal`), its URL, and the exact credit the license requires, `null` when it requires none |
| `collection`, `scraped` | How the maintainer collected the list, citing their README or a statement from them, and whether it was scraped from a platform (`null` until they have said) |
| `use` | `lead`, `seed` or `frame` (14.2) |
| `format` | `lines` (one ID per line; `!` and `#` start comment lines; for Colander's own lists, `LicenseRef-Colander-internal`, the ID needs a note after it of where staff saw it, kept for staff, and a line without one is skipped; other lists' notes are ignored), `ubo` (uBlock Origin or Adblock Plus rules; every YouTube channel ID in a rule; a rule that names a channel only by handle is excluded, since a handle can pass to another owner, and `[Adblock Plus 2.0]` headers are comments) or `soul-over-ai` (Soul Over AI's artist JSON array; only artists whose own disclosure is `full`, never removed ones) |
| `sha256` | Hex SHA-256 of the file text the owner cleared; every import must match it |
| `upstream` | The upstream version imported (`ref`, a commit or version) and its date, from which expiry counts |
| `expires_after_days` | An entry stops being a lead this many days after the upstream date of the batch that last listed it, 1 to 730 |
| `calibration` | `{"report": "YYYY-MM-DD", "groups": [{"group", "n", "ai", "slop"}]}`, blind label counts from `scripts/calibration-report.ts`; required for `seed` |
| `dev_only` | Fictional data for `make dev` and tests: usable only with `COLANDER_DEV=1`, never cleared, licensed `LicenseRef-Colander-internal` |
| `clearance` | `{"status": "pending" \| "cleared" \| "refused" \| "revoked", "by", "at"}`; only the owner clears |

The registry is public, like the repository: it never holds a list, the clearance records or notes on refused lists.
Those live in the private bucket (14.4).

### 14.2 Rules

- Only `CC0-1.0`, `CC-BY-4.0`, `MIT`, `LicenseRef-written-grant` and `LicenseRef-Colander-internal` can be cleared.
  Non-commercial, no-derivatives, share-alike, GPL and unlicensed lists never are.
- `CC-BY-4.0` and `MIT` need `attribution`; every other license but `LicenseRef-written-grant` takes none, so `/credits` names only datasets whose license asks for credit; a public license needs `license_url`.
- A third-party dataset needs at least one alias.
- `cleared` needs `by` in `SEED_OWNERS` (the owner's GitHub login, `slantview`), `at`, `sha256`, `upstream.date`, and `scraped: false`.
- `lead`: the entries put their sources in the review queue as seed leads (9.5).
  Every new dataset starts here.
- `seed`: a lead list that passed blind calibration in every group it reports: at least 100 labeled sources overall and 30 per group, with 95% Wilson lower bounds of 0.90 on the share that is AI-made and 0.80 on the share that is slop (`CALIBRATION` in `seeds.ts`), and expiry within 180 days of its upstream date.
  The block needs the group `all` and at least one group of each kind the report writes, by platform, audience, language and music or video (`CALIBRATION_GROUPS`), copied whole from the report: a list stays `lead` until it has them all.
  Its leads rank with reports (6.7).
  It is still never evidence and never gives a verdict.
- `frame`: a sampling pool for the calibration set (14.5).
  It is never imported as leads and never evidence.
- Changes need the owner.
  `.github/CODEOWNERS` gives the registry, `seeds.ts`, `scripts/check-seeds.ts`, `.github/workflows/seed-guard.yml` and itself to `@slantview`.
  `scripts/check-seeds.ts` fails any change to a cleared entry, to a clearance, to an entry added or taken out other than as pending, to `SEED_OWNERS`, or to any of those files but the registry, unless the GitHub actors are owners as the base commit listed them.
  The `api` job runs it on every push and pull request; the required `seed-guard` check (`seed-guard.yml`, on `pull_request_target`) runs the base branch's copy of the checker and its rules against the pull request's commit, so a pull request cannot change the check that judges it, and needs both its author and its last pusher to be owners.
- The same check fails when any file in the repository is a byte-for-byte copy of a registered list.
- It also fails unless `.github/dependabot.yml` excludes `seed-guard.yml`, so no Dependabot pull request touches an owner-only file; the owner bumps its pins by hand.

### 14.3 Credits

`/credits` names exactly the cleared, third-party entries whose license asks for credit (`credits()` in `seeds.ts`), with the exact `attribution` text and links to each dataset and license, and says what Colander changes.
It prerenders from the registry, so the deploy that carries a clearance also carries its credit, before any import can run.
No other page or file of the website names a dataset, and neither does the extension; tests scan both builds for every name of every third-party dataset, `datasetNames()` in `seeds.ts`: its name, ID, aliases, homepage and, on GitHub, the owner and repository there.
The same names are what `400 source_named` (6.7) refuses in the decision log, for every registry entry, and what an import withholds from the log.
The website's tests build with a fictional registry (`web/tests/seed-registry.ts`), so `/credits` renders a dataset's card in them.
The extension's about text (Options, Privacy) says where the list comes from and links to `/credits`.

### 14.4 Imports, expiry, revocation and suppression

The private object `seeds/<id>.json` in the environment's backup bucket is `{"file": "<the list text>", "records": {"dpia", "lia", "permission_doc"}}`: the cleared file, and where the data protection impact assessment, the legitimate interest assessment and, for a written grant only, the grant are kept.

| Ops command | Body | Effect |
| --- | --- | --- |
| `import-seed` | `{"seed", "apply": bool?}` | Checks the entry: in the registry and valid (`404 unknown_seed`, `409 seed_invalid`), cleared (`409 seed_not_cleared`; a `dev_only` entry only in dev mode), not a frame (`409 seed_is_frame`); then the object: present (`404 no_seed_object`), its file matching `sha256` (`409 seed_hash_mismatch`), its records there (`409 records_required`). It reads the file by `format` and answers the change: `entries`, `by_platform`, `added`, `kept`, `dropped`, `suppressed`, `skipped`, `excluded`. Without `"apply": true` nothing is written. With it, one transaction records the batch in `seed_imports`, lists every entry in `seed_entries` with the upstream date, deletes the dropped ones and the sources only they made, and withholds the list's name wherever the public log holds it; a scoring pass then raises the leads. |
| `revoke-seed` | `{"seed", "reason", "confirm"}`, `confirm` equal to `seed` | Deletes every entry of the seed at once and every calibration item sampled from it as `seed:<id>` or `random:<id>`, with their labels, marks its batches revoked with the reason, deletes the sources only they made, starts a scoring pass, and deletes `seeds/<id>.json` from the private bucket. Answers `entries`, `sampled`, `sources` and `file`, `deleted` or `kept` when the bucket refused. The reason appears in the public run log: it never names a creator or holds legal advice. |

An entry is live, and raises a lead, while its registry entry is usable (cleared, or `dev_only` in dev mode), its use is `lead` or `seed`, and its upstream date plus `expires_after_days` lies ahead.
The daily `seeds` job at 04:00 UTC deletes the entries that are not live (expired, or their list lost its clearance in a deploy), every calibration item sampled from an entry that is withdrawn (gone from the registry, or not usable: refused, revoked or no longer cleared, as opposed to expired), the sources only they made, and staff provenance reads (6.7) older than 24 months, and starts a scoring pass; until it runs, leads already check liveness when they are read.
Staff suppress seed lists on a source with `suppress-seeds` (6.7): an import skips it, and its entries and calibration item go.
Each suppression and lift is first recorded as its own object under `objections/` in the backup bucket, naming the channel by every alias of the source, under a 7-day bucket lock and deleted after 120 days, and is audited as `seeds_suppressed` or `seeds_unsuppressed` with the target `src:<source ID>`, never the channel or the reason.
After a restore of a dump or of an earlier point in time, the Worker repeats every record in order before it publishes; a suppressed channel that the restored data lacks gets a source of its own, so no import lists it again.
Answers carry counts and the registry ID only, never a channel: the ops run log is public.
Like every seed list command, these run from the Ops workflow alone (`docs/deploy.md`, "The ops channel").

### 14.5 The calibration set

| Ops command | Body | Effect |
| --- | --- | --- |
| `calibration-sample` | `{"frame", "n"}`, `n` 1 to 1,000 | Adds up to `n` random sources to `calibration_items` from `seed:<id>` (a live lead or seed list's entries), `community` (sources with tags or reports) or `random:<id>` (a cleared frame's object, read like an import). Sources already sampled or suppressed are left out. Answers `sampled` and `available`. |
| `calibration-export` | `{}` | Writes every item with its labels (with their language, kind and staff note), current verdict, computed verdict and seed lists to `calibration/<time>.json` in the private backup bucket and answers only the key and counts. |

Curators and staff label each item blind through `/console/calibration` (6.7): two labels each, and staff settle a disagreement with a third through `/admin/calibration` on the admin host.
`scripts/calibration-report.ts` reads an export and prints, per frame and per group (all, each platform, the audience size staff recorded, each language, and music or video, each settled on what most labelers recorded), the counts and Wilson lower bounds, Cohen's kappa between the first two labelers, and the computed verdicts against the settled labels.
A `seed:<id>` frame's `calibration` block goes into the registry entry when the owner promotes the list.
Labels are never evidence and never published, and the daily `seeds` job deletes calibration items 24 months after their last label.
