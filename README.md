# Colander

Drain the slop. Keep the substance.

Colander is a Chrome extension that hides AI slop on YouTube, TikTok, Instagram and Facebook the way an ad blocker hides ads.
It matches every card against a shared, signed list on the device, explains every action, and makes every action reversible.
Anyone can tag and report slop, creators can appeal, and every verdict change is published in a public decision log.
Blocking is free; the Plus plan and donations pay for review, and paying never changes a verdict.

The product spec is [docs/product-requirements.md](docs/product-requirements.md).
Every interface between the parts is defined in [docs/contracts.md](docs/contracts.md), which is the source of truth when code and prose disagree.

## What is in this repository

| Path | What it is | Stack |
| --- | --- | --- |
| [extension/](extension/README.md) | The Manifest V3 extension: platform adapters, matching, seamless hiding with grid reflow, in-page chips, Tag and Why, popup, options, welcome page and the curator side panel | WXT, Svelte 5, TypeScript |
| [api/](api/README.md) | The whole backend in one Cloudflare Worker: edge routing and caching, the `Store` Durable Object on SQLite (tags and reports, scoring, review, appeals, accounts, billing, settings sync), signed list snapshots and deltas through R2, and the website through Workers Static Assets | TypeScript, Cloudflare Workers |
| [web/](web/README.md) | The public website: landing page, definition, source pages, appeals, decision log, plans, support, transparency, sign-in, the account page and the review console, and the admin console served on the admin host | SvelteKit (static), Svelte 5 |
| [packages/shared](packages/shared/README.md) | Verdict vocabulary, signal names, verdict glyphs and the brand mark, the Colander theme on top of Mittsu components, the in-page UI and the components the website and extension share, API types, and the list format, Ed25519 signing and canonical IDs used by the extension and the Worker | TypeScript, Svelte 5, Mittsu |
| [e2e/](e2e/README.md) | Full-stack tests: the Worker under `wrangler dev`, the website and the extension together in Chromium | Playwright |
| [testdata/](testdata) | The signed contract fixtures, which the TypeScript encoder must reproduce byte for byte, and the published development signing key | Node |
| [scripts/](docs/deploy.md) | Deploy tooling: the contract smoke test, offline signing key generation, the Cloudflare bootstrap, the restore drill and the Wrangler config guard | Node 24, Bash |

## Quick start

You need Node 24 with pnpm 10, and Chrome 137 or newer.

```sh
make setup      # install the workspace
make dev        # build the website and serve everything with wrangler dev on http://localhost:8787
make seed       # once, in a second terminal: fictional demo data and its first scoring pass
make extension  # build the extension into extension/dist/chrome-mv3
```

Load the extension from `chrome://extensions` with Developer mode on, Load unpacked, and pick `extension/dist/chrome-mv3`.
Its development ID is `nninnogmbhfebflkcgghlmjmplmpodlc` on every machine.
The welcome tab asks which platforms to switch on, and Chrome asks for site access for those only.

`make dev` runs the Worker in dev mode with the development signing key, so sign-in codes print to its output instead of being emailed.
Its local Durable Object and R2 state live in `api/.wrangler`; delete that folder to start over.
The demo data includes a staff member, `rae@colander.test`, and a curator, `sam@colander.test`.
Staff work in the admin console on http://admin.localhost:8787, where dev mode stands in for Cloudflare Access: in the browser console on any admin.localhost page run `await fetch('/__dev/access', {method: 'POST', body: JSON.stringify({email: 'rae@colander.test'})})`, then open `/admin`.
Curators review on http://localhost:8787/console with a passkey, which comes from an invite issued on the admin host's People page.
To make yourself admin, run `curl -X POST localhost:8787/ops/grant-role -H "Authorization: Bearer $(sed -n 's/^OPS_TOKEN=//p' api/.dev.vars)" -d '{"email": "you@example.com", "role": "admin"}'` once; the dev ops token comes from `api/.dev.vars`.

## How it fits together

![Architecture: the extension on the device, the services behind it](docs/img/architecture.svg)

The extension downloads a signed list and matches cards on the device, so no browsing data leaves it.
Tags and reports go to the server, the scoring service turns them into verdicts under the two-layer rule, reviewers confirm what needs a person, and the next list carries the result to every install.
Platform page selectors ship as signed declarative configuration, so a site redesign is fixed without a store review.

## Testing

| Command | What it covers |
| --- | --- |
| `make test-api` | The Wrangler config guard, type checks, the Worker's tests inside workerd (the store, every scoring rule, the HTTP API, billing against a fake Stripe, backups, ops and the list format against the contract fixtures), a dump that loads into stock SQLite, and dry-run deploys of both environments |
| `make test-web` | Type checks, then the website's Playwright tests with axe accessibility checks in light and dark |
| `make test-extension` | Type checks, unit tests and the extension's Playwright tests on saved platform fixtures, including the speed budgets |
| `make e2e` | The Worker under `wrangler dev`, the website and the extension together: blocking from the real list, tag, report, review, appeal, side panel, trial and a privacy audit |
| `make test` | The first three together |
| `pnpm -C extension test:live` | The adapters against the real YouTube and TikTok pages, which also runs daily in CI |

## Deploying

Colander runs on Cloudflare as one TypeScript Worker on getcolander.com (`api/`): the API, the website as static assets, a Durable Object as the database, and R2 for the signed list and the backups.
Staging runs the same Worker on staging.getcolander.com behind Cloudflare Access.
GitHub Actions is the whole pipeline:

- Every pull request runs CI; the required checks are `secrets`, `workflows`, `api`, `contract`, `web-and-extension` and `full-stack`.
- Staff and admin work happens on admin.getcolander.com behind Cloudflare Access with A3T Identity and hardware-key MFA; the ops channel takes only GitHub OIDC tokens from workflows on a protected main.
- Every green commit on main deploys to staging and passes a smoke test there.
- Merging the release PR that release-please keeps open deploys that commit to production, smoke-tests it and rolls it back on failure.
- Extension releases are built with provenance, attached to their GitHub release and submitted to the Chrome Web Store as a staged publish.
- Hourly probes and weekly and monthly restore drills watch production from outside.

[docs/deploy.md](docs/deploy.md) is the runbook: the one-time setup in order, every secret and variable, the ops channel, and rollback, restore and key rotation.
The design behind it is [docs/hosting-plan.md](docs/hosting-plan.md).

```sh
make deploy-dry                       # build and check both Worker environments without uploading
make smoke SMOKE_URL=https://getcolander.com SMOKE_KEYS=<production public key>
node scripts/keygen.ts signing.key    # a new signing key, offline
```

The backend was a Go server until the TypeScript Worker matched it table for table and byte for byte in a parity harness; both live on in git history.

## Status

Every P0 requirement for version 1.0 is built and tested: blocking from lists on all four platforms, strictness and pause, platform AI labels, tagging, reporting, Why, Show and Always allow, signed list sync, consensus and review, appeals, privacy by default, counts and activity, Plus and donations, and accessibility.
The 1.1 items (articles and search results, the Family plan, Content Credentials, Firefox and Edge) are not built.

Fairness rules are enforced in code and tested: tags alone never make anything Slop, a reviewer needs AI evidence to rate Slop or Likely slop, mixed sources are judged item by item, appeals unhide a source while staff review it, and curators cannot decide large or appealed sources.
Audience size is unknown unless staff set it: TikTok, Instagram and Facebook give no audience figures, and YouTube's figures do not feed scoring until YouTube approves derived metrics.
So a Slop verdict on any platform waits for a reviewer, a curator or staff, until then; plan review capacity accordingly.

Some things need people or accounts rather than code.

- Instagram and Facebook selectors are tested on hand-built fixtures only; run `pnpm -C extension test:live` with signed-in storage states before those platforms ship.
- Outside seed lists are review leads only and never decide a verdict.
  The `import-seed` ops command reads a list object from the private bucket and accepts only CC0-1.0, CC-BY-4.0, MIT or a written grant; it refuses non-commercial, no-derivatives, share-alike, GPL and unlicensed lists.
- Stripe Managed Payments needs Stripe's eligibility approval and its terms accepted in the dashboard.
- The extension asks for the `scripting` permission in addition to the spec's minimal list, because per-platform site access needs runtime content script registration; the spec's permission list should add it.
- The open questions in the spec still stand: legal review of labels and platform terms, the calibration set behind the thresholds, the code and data licenses, and trademark clearance for the name.
