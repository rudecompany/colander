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
| [extension/](extension/README.md) | The Manifest V3 extension: platform adapters, matching, in-page chips, collapsed bars, Tag and Why, popup, options, welcome page and the curator side panel | WXT, Svelte 5, TypeScript |
| [server/](server/README.md) | Every backend service in one binary: signed list snapshots and deltas, tags and reports, scoring, review, appeals, accounts, billing, settings sync, and the website itself | Go, SQLite |
| [web/](web/README.md) | The public website: landing page, definition, source pages, appeals, decision log, plans, support, transparency, account and the review console | SvelteKit (static), Svelte 5 |
| [packages/shared](packages/shared) | Verdict vocabulary, signal names, verdict glyphs and the brand mark, the Colander theme on top of Mittsu components, API types, and the list format, Ed25519 signing and canonical IDs used by the extension and the server | TypeScript, Svelte 5, Mittsu |
| [e2e/](e2e/README.md) | Full-stack tests: the real server, website and extension together in Chromium | Playwright |
| [testdata/contract](testdata/contract) | Signed fixtures that the Go and TypeScript code must both read byte for byte | Node |

## Quick start

You need Go 1.25 or newer, Node 24 with pnpm 10, and Chrome 137 or newer.

```sh
make setup      # install the workspace and Go modules
make dev        # build the website, seed demo data, serve everything on http://localhost:8787
make extension  # build the extension into extension/dist/chrome-mv3
```

Load the extension from `chrome://extensions` with Developer mode on, Load unpacked, and pick `extension/dist/chrome-mv3`.
Its development ID is `nninnogmbhfebflkcgghlmjmplmpodlc` on every machine.
The welcome tab asks which platforms to switch on, and Chrome asks for site access for those only.

`make dev` runs the server in dev mode, so sign-in links print to its output instead of being emailed.
The demo data includes a staff reviewer, `rae@colander.test`, and a curator, `sam@colander.test`; sign in as either on `/account` and open `/console`.

## How it fits together

![Architecture: the extension on the device, the services behind it](docs/img/architecture.svg)

The extension downloads a signed list and matches cards on the device, so no browsing data leaves it.
Tags and reports go to the server, the scoring service turns them into verdicts under the two-layer rule, reviewers confirm what needs a person, and the next list carries the result to every install.
Platform page selectors ship as signed declarative configuration, so a site redesign is fixed without a store review.

## Testing

| Command | What it covers |
| --- | --- |
| `make test-server` | `gofmt`, `go vet` and the Go tests with the race detector: the list format against the contract fixtures, every scoring rule, the HTTP API, billing against a fake Stripe |
| `make test-web` | Type checks, then the website's Playwright tests with axe accessibility checks in light and dark |
| `make test-extension` | Type checks, unit tests and the extension's Playwright tests on saved platform fixtures, including the speed budgets |
| `make e2e` | The real server, website and extension together: blocking from the real list, tag, report, review, appeal, side panel, trial and a privacy audit |
| `make test` | The first three together |
| `pnpm -C extension test:live` | The adapters against the real YouTube and TikTok pages, which also runs daily in CI |

## Deploying

The server and the website ship as one container.

```sh
make docker
docker run --rm -v colander-data:/data colander keygen      # once: creates the list signing key
docker run -d -p 8787:8787 -v colander-data:/data \
  -e COLANDER_PUBLIC_URL=https://your.domain colander
```

Configuration is by environment variable and is listed in [server/README.md](server/README.md): email through Resend, YouTube enrichment, Stripe billing with Managed Payments as merchant of record, and the client IP header of your proxy.
Build the extension for release with `WXT_COLANDER_API`, `WXT_COLANDER_SITE` and `WXT_COLANDER_PUBLIC_KEYS` set to the production origin and the public key printed by `keygen`, then `make extension-zip`.
Sign updated platform selectors with `colander sign-config`; installs pick them up on their next sync.

## Status

Every P0 requirement for version 1.0 is built and tested: blocking from lists on all four platforms, strictness and pause, platform AI labels, tagging, reporting, Why, Show and Always allow, signed list sync, consensus and review, appeals, privacy by default, counts and activity, Plus and donations, and accessibility.
The 1.1 items (articles and search results, the Family plan, Content Credentials, Firefox and Edge) are not built.

Fairness rules are enforced in code and tested: tags alone never make anything Slop, a reviewer needs AI evidence to rate Slop or Likely slop, mixed sources are judged item by item, appeals unhide a source while staff review it, and curators cannot decide large or appealed sources.
Because TikTok, Instagram and Facebook give no audience figures, a Slop verdict there always waits for staff review, so plan review capacity accordingly.

Some things need people or accounts rather than code.

- Instagram and Facebook selectors are tested on hand-built fixtures only; run `pnpm -C extension test:live` with signed-in storage states before those platforms ship.
- AiSList is licensed CC BY-NC 4.0, not MIT as the spec assumed, so its data is not bundled; `colander import-seed` imports a list file only with an explicit license acknowledgement.
- Stripe Managed Payments needs Stripe's eligibility approval and its terms accepted in the dashboard.
- The extension asks for the `scripting` permission in addition to the spec's minimal list, because per-platform site access needs runtime content script registration; the spec's permission list should add it.
- The open questions in the spec still stand: legal review of labels and platform terms, the calibration set behind the thresholds, the code and data licenses, and trademark clearance for the name.
