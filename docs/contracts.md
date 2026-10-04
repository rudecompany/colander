# Colander: engineering contracts

This document is the single source of truth for every interface that crosses a component boundary.
The extension, the Go server and the website are built against it in parallel.
If code and this document disagree, the code is wrong.
Behavior described in `docs/product-requirements.md` (the spec) is not repeated here unless a precise rule is needed.

## 1. Repository layout and ownership

| Path | What | Stack |
| --- | --- | --- |
| `packages/shared` | `@colander/shared`: verdict enums and words, signals, glyphs, the Colander theme (`colander.css`), Mittsu components, API types, and the list format, Ed25519 signing and canonical IDs (client and server halves, WebCrypto only) | TypeScript, Svelte 5 |
| `extension` | The Chrome MV3 extension | WXT, Svelte 5, TypeScript |
| `server` | Every backend service in one Go binary: list, tag, scoring, review, appeals, public API, accounts, billing | Go, SQLite |
| `web` | Public website, account pages and the review console, built static and served by the Go binary | SvelteKit (adapter-static), Svelte 5, Mittsu |

The JavaScript side is a pnpm workspace (`pnpm-workspace.yaml` at the root).
The Go module is `github.com/rudecompany/colander/server`.
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
It is sent as `Authorization: Install <id>` on tag, report and trial requests, and nowhere else.
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
                          bit 4 large source, bit 5 imported and not yet reviewed, bit 6 staff reviewed, bit 7 reserved 0
  10  signals    u16      bitmask, bit order in 3.1
  12  detail     u8       bits 0-1 slop type (0 none, 1 filler, 2 bait, 3 deceptive),
                          bit 2 low_effort, bit 3 mass_produced, bit 4 hollow, bits 5-7 reserved 0
  13  reserved   u8       0
  14  updated    u16      days since 2020-01-01 UTC when the verdict last changed
Trailer, 72 bytes
  0   key_id     8 bytes  first 8 bytes of SHA-256 over the raw 32-byte Ed25519 public key
  8   signature  64 bytes Ed25519 over header and entries (every byte before the trailer)
```

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
| `GET /v1/list/delta?since=N` | `200` with a delta from N to latest, `204` when N is the latest sequence, `410` when N is unknown or older than 30 days (client then fetches the snapshot). |

A delta carries the final state of every hash that changed after `base`, coalesced, with verdict 0 for entries that left the list.
The client applies it only when `base` equals its own sequence.
The server publishes a new sequence whenever any entry changes, at most once per 10 seconds, so a verified appeal reaches the list within a minute.

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
The server treats the payload as opaque bytes: `colander sign-config <file.json>` signs and stores it.
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

CORS: `/v1/list/*`, `/v1/config/*`, `/v1/tags`, `/v1/reports`, `/v1/trial`, `/v1/entitlement/refresh`, `/v1/sync`, `/v1/review/*` (bearer only) and `/v1/sources/*` answer any origin (`Access-Control-Allow-Origin: *`, no credentials), so the extension needs no host permission for the API.
Cookie-authenticated routes are same-origin only and require the header `X-Colander-CSRF: 1` on every non-GET request.

### 6.1 Auth schemes

| Scheme | Header | Used by |
| --- | --- | --- |
| Install | `Authorization: Install <install id>` | Extension: tags, reports, trial |
| Session | Cookie `colander_session` (HttpOnly, SameSite=Lax, Secure outside dev) | Website: account, billing, review console |
| Reviewer | `Authorization: Bearer <reviewer token>` | Extension side panel: review API |
| Plan | `Authorization: Plan <plan token>` | Extension: settings sync |

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
      "uploads_per_day": 14.2
    }
  },
  "history": [LogEntry, ...]
}
```

`verdict` is `null` when the source is known but not rated. Fields without data are `null`.
A lookup by any alias returns the same source.
`imported` is true when the source came from an imported seed list, reviewed or not; `attribution` then names the list and its license (for example `AiSList (CC BY-NC 4.0), blocklist`), and the source page must show it.

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
| `POST /v1/appeals` `{"platform","source_id","email","statement"}` | none, 5 per IP per day | Creates an appeal. `201` `{"appeal": Appeal, "secret": "..."}`. The secret lets the creator check status and verify. It is also emailed as a link. |
| `GET /v1/appeals/{id}?secret=` | secret | `{"appeal": Appeal}` |
| `POST /v1/appeals/{id}/verify` `{"secret"}` | secret | Checks for the code on the account. YouTube is checked through the Data API when a key is configured, at most 10 times per appeal and 30 times per IP an hour. Otherwise the appeal moves to `pending_manual` for staff. |
| `POST /v1/review/appeals/{id}/verify` | staff | Staff confirm the code is on the account |
| `POST /v1/review/appeals/{id}/resolve` `{"outcome": "upheld" \| "denied", "reasoning"}` | staff | Upheld sets Clear. Denied restores the scored verdict. Both write the decision log. |

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
Once verified (`under_review`), the source verdict becomes Disputed at once and the next list publication carries it.
Appeal pages never show a support or donation link.

### 6.6 Accounts and sessions

| Request | Effect |
| --- | --- |
| `POST /v1/auth/email` `{"email", "next"}` | Sends a sign-in link to `{public_url}/auth/callback?token=...&next=...`. Always `202`. 5 per email per hour. Links expire after 20 minutes and work once. |
| `POST /v1/auth/verify` `{"token"}` | Sets the session cookie (30 days). `200` `{"account": Account}`. Creates the account on first sign-in. Needs `X-Colander-CSRF: 1` like the cookie routes (`403 csrf_required`), so a cross-site form cannot sign a visitor into another account. |
| `POST /v1/auth/logout` | Clears the session |
| `GET /v1/account` | `200` `{"account": Account}` or `401` |
| `PATCH /v1/account` `{"display_name"}` | Updates the public name used in the decision log and supporters page |
| `POST /v1/account/reviewer-token` | Curators and staff only. `200` `{"token": "..."}`. Replaces any earlier token. |

```json
{ "id": "acc_...", "email": "...", "display_name": "Sam", "role": "member", "plan": Plan | null, "created_at": "..." }
```

`role` is `member`, `curator` or `staff`. Roles are granted with `colander grant-role <email> <role>`.
In dev mode (`COLANDER_DEV=1`) sign-in links are logged to stdout instead of emailed.

### 6.7 Review (curators and staff)

Session cookie or Reviewer bearer token. Curators may decide sources that are not large and items; large sources and appeals need staff (`403 staff_required`).

| Request | Returns |
| --- | --- |
| `GET /v1/review/queue?kind=all\|reports\|appeals\|escalations&cursor=` | `{"items": [QueueItem], "next_cursor"}` ordered by priority then age |
| `GET /v1/review/sources/{platform}/{source_id}` | `{"source": Source, "layers": Layers, "reports": [ReportDetail], "appeals": [Appeal], "items": [ItemSummary], "history": [LogEntry]}` |
| `POST /v1/review/sources/{platform}/{source_id}/decision` | Body `{"verdict": Verdict \| "none", "reason", "signals": [Signal], "slop_type", "tests", "large": bool?}`. Writes the log and publishes. Slop and Likely slop need AI evidence: `400 ai_evidence_required` unless the provenance layer is met or the body records a provenance signal. Curators get `403 staff_required` for large sources and for sources with an appeal in `pending_manual` or `under_review`. |
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
  "report_count": 3
}
```

`kind` is `report`, `appeal` or `escalation`. Escalations are raised by the scoring service (section 9).
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

## 7. Website and extension handoff

The extension declares `externally_connectable.matches` for the website origin.
The website finds the extension by its ID (build env `PUBLIC_EXTENSION_ID`) and sends:

| Message | Reply |
| --- | --- |
| `{"type": "colander:ping"}` | `{"ok": true, "version": "1.0.0"}` |
| `{"type": "colander:plan-token", "token": "..."}` | `{"ok": true}` after the extension verifies and stores the token |
| `{"type": "colander:reviewer-token", "token": "..."}` | `{"ok": true}`; the side panel can now use the review API |

The dev build uses a fixed manifest `key` so the extension ID is stable across machines.

## 8. Privacy rules for the network

The extension makes exactly these requests: list snapshot and deltas, adapter configuration, tags, reports, report status, trial, entitlement refresh, settings sync (Plus) and the review API (reviewers only).
No request ever carries a page URL, the user's platform account name, or watch history.
List downloads carry no identifier at all.
Server logs never record request paths that contain item or source IDs together with an install hash.

## 9. Scoring (normative for the server)

Thresholds here are the starting values the spec asks to calibrate. Keep them in one Go struct.

### 9.1 Reputation

Each install's latest tag per target counts with weight `w = clamp(0.1 + 0.9 * maturity * accuracy, 0.05, 1.0)`.
`maturity = min(1, days since the install's first tag / 30)`.
`accuracy = (agree + 1) / (decided + 2)`, over the install's tags on targets that now hold a staff, appeal or consensus verdict (Slop or Likely slop with `community_consensus`, or Clear with `not_slop_consensus`; AI-made verdicts from community AI consensus are excluded because they would feed back into the weights that produced them).
A tag agrees when `slop` meets Slop or Likely slop, `not_slop` meets Clear, and `ai_fine` meets AI-made.
Plan, payment and donation state are never inputs.

### 9.2 Tag sums per target

`S`, `A` and `N` are the weighted sums of `slop`, `ai_fine` and `not_slop` tags. `T = S + A + N`. `n` is the number of distinct installs.

### 9.3 Layers

- Provenance (AI evidence) is met when any holds: at least 2 distinct installs reported `platform_label` on the target (for a source that is not mixed, on any of its items); staff recorded `platform_label`, `content_credentials`, `creator_statement` or `watermark`; the source is an imported seed entry; or community AI consensus: `S + A >= 3`, `n >= 3` and `(S + A) / T >= 0.7`.
- Behavior (sources; items inherit their source's) is met when any holds: uploads per day of at least 10 from the YouTube Data API; `ai_item_share >= 0.8` over at least 5 items seen with evidence (Kagi's 80% rule, emitted as `mostly_ai`), where an item counts as AI-made only through independent evidence (platform label reports from 2 or more installs, or a reviewer decision), never through community AI consensus, so tags alone cannot make a source look mass-produced; or staff recorded `high_volume`, `templated`, `near_duplicates`, `link_funnel` or `cross_posting`. An imported blocklist seed entry also counts as `mostly_ai`.
- Rubric is met when, among slop tags with `S >= 1`, at least two of the three tests are each selected by a weighted share of 0.5 or more. `mass_produced` also counts as selected when Behavior is met. Emits `rubric_low_effort` and `rubric_hollow` where they pass.
- Consensus for slop: `S >= 3`, `n >= 3`, `S / T >= 0.7`, and the source is not frozen by burst detection. Emits `community_consensus`.
- Not-slop consensus: `N >= 3` and `N / T >= 0.7`. Emits `not_slop_consensus`.
- Split: `S >= 2`, `N + A >= 2` and `0.3 <= S / T <= 0.7`.

### 9.4 Verdict, first rule that matches wins

1. A verified open appeal: Disputed (`open_appeal`).
2. An unexpired staff or curator decision: that verdict.
3. Not-slop consensus: Clear.
4. No provenance: not rated (no list entry).
5. Split: Disputed.
6. Provenance, Behavior and Consensus all met: Slop, except that it is capped at Likely slop and raises an escalation when the source is large, when its audience size is unknown (no YouTube Data API figure and no staff `large` decision), or when it is an imported entry nobody has reviewed. Only a reviewer can then make it Slop.
7. Provenance and (Behavior or Rubric), with `S >= 1` or an imported blocklist seed: Likely slop.
8. Provenance only: AI-made.

Sources become mixed when at least 5 items have been seen and `ai_item_share < 0.8`.
A mixed source gets no source-level Slop or Likely slop verdict, item label reports do not count toward its provenance (it falls to rule 8 only on source-level evidence, otherwise not rated), and its items are scored on their own and keep their own list entries.
Item entries are emitted only when an item has its own verdict that differs from its source's list verdict.
Signals on a list entry are the union of the signals that fired for the layers that were met.

### 9.5 Expiry, escalations and brigading

- Every list verdict carries `rescore_at = changed_at + 90 days`. At expiry, staff and curator decisions lapse and the target is scored again; if the result is Slop it becomes an escalation and stays Likely slop until reviewed.
- An escalation is raised when: rule 6 is capped; 3 or more open reports exist on a source; a burst is detected; a verdict lapses into Slop.
- Burst: more than 20 slop tags in one hour on one source from installs younger than 7 days. The consensus layer of that source is frozen for 72 hours and an escalation is raised.
- A source is large when the YouTube Data API reports 100,000 subscribers or more, or staff set `large`. A source whose audience is unknown is treated like a large one for rule 6 only, and is not shown as large.
- The scoring pass runs every 5 minutes and, debounced by 5 seconds, after any review decision, appeal change or report.
- Every verdict change writes a decision log entry. Changes made by the scoring pass use actor `community` and a reason generated from the signals.

### 9.6 Active install estimate

The server counts list snapshot and delta requests per UTC hour without any identifier; the Worker reads the counts of whole hours from edge analytics, cache hits included.
`active_installs = round(requests in the last 24 counted hours / 24)`, because each install syncs hourly.

## 10. Configuration of the server

| Env | Default | Purpose |
| --- | --- | --- |
| `COLANDER_ADDR` | `:8787` | Listen address |
| `COLANDER_DB` | `data/colander.db` | SQLite file (WAL) |
| `COLANDER_SIGNING_KEY` | `data/signing.key` | Ed25519 private key, created by `colander keygen` |
| `COLANDER_PUBLIC_URL` | `http://localhost:8787` | Origin used in emails and redirects |
| `COLANDER_SITE_DIR` | `../web/build` | Built website to serve, with SPA fallback to `200.html` |
| `COLANDER_DEV` | unset | Dev mode: links logged, cookies not Secure |
| `YOUTUBE_API_KEY` | unset | YouTube enrichment and appeal verification |
| `RESEND_API_KEY`, `COLANDER_MAIL_FROM` | unset | Email delivery |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY` | unset | Billing. Without them billing routes answer `503 billing_unavailable`. |
| `STRIPE_MANAGED_PAYMENTS` | on | Plus checkout with Stripe Managed Payments as merchant of record. `0` turns it off. |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Stripe API origin, for tests against a fake |
| `COLANDER_CLIENT_IP_HEADER` | unset | Header a trusted reverse proxy sets to the client address, such as `CF-Connecting-IP` or `X-Forwarded-For`, for per-IP rate limits |

## 11. Extension build configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `WXT_COLANDER_API` | `http://localhost:8787` | Server origin |
| `WXT_COLANDER_PUBLIC_KEYS` | the dev key from `server/testdata/dev-signing.pub` | Trusted Ed25519 public keys |
| `WXT_COLANDER_SITE` | same as the API | Website origin for links and `externally_connectable` |

## 12. Keys

`COLANDER_SIGNING_KEY` is a text file holding the base64 of the 32-byte Ed25519 seed.
Public keys are the base64 of the raw 32-byte key.
`server/testdata/dev-signing.key` and `.pub` are a published development pair for local runs and tests only; production keys are made with `colander keygen` and never committed.

## 13. Contract fixtures

`testdata/contract/` holds signed fixtures generated by `node testdata/contract/generate.mjs` with the development key.
`list-snapshot.bin` and `list-delta.bin` follow section 3; `list-expected.json` lists their decoded entries (with the target key, hash hex and the ISO date the `updated` day number came from) and the 7 entries left after applying the delta.
`config-envelope.json` follows section 4 with payload `{"version":7,"note":"contract fixture"}`.
`plan-token.txt` follows section 5.
The Go and TypeScript encoders (`packages/shared/src/list.ts`) must reproduce `list-snapshot.bin` and `list-delta.bin` byte for byte from `list-expected.json`, the Go and TypeScript signers must reproduce `config-envelope.json` and `plan-token.txt`, and both the Go and TypeScript decoders must verify and decode all fixtures.
Never edit the fixtures by hand; change the generator and rerun it.
