# Notes for addons.mozilla.org reviewers

This file ships in the sources zip of every Firefox version.
The test account for the Plus plan and the review side panel is in the version's approval notes, not here.

## Build the package from these sources

You need Node 24 and pnpm 10.32.1, which Corepack provides: run `corepack enable` once.
From the root of the sources zip:

```sh
pnpm install --frozen-lockfile
bash extension/scripts/build-store.sh firefox
```

The package is `extension/dist/colanderextension-<version>-firefox.zip`, byte for byte the one submitted.
Its configuration comes from `extension/release.env`: the server origin and the public Ed25519 keys the add-on trusts, all public values.
The release job runs the same script and checks the rebuild matches before it submits.

## What the add-on does

Colander hides AI slop on YouTube, TikTok, Instagram and Facebook from a shared list that it downloads, verifies and matches on the device.
It asks for site access per platform, only for the platforms the person switches on (`optional_host_permissions`), and runs nowhere else.
Every action is explained in the page and can be undone.

## Remote data, never remote code

Two things are downloaded, and both are data, verified with Ed25519 against keys bundled in the package:
- The list (`/v1/list/*`): fixed-size binary records of hashes and verdicts, decoded in `packages/shared/src/list.ts`.
- The adapter configuration (`/v1/config/adapters`): CSS selectors, attribute names, regular expressions and property paths, checked by `validateConfig` in `extension/src/adapters/schema.ts`.
  A copy is bundled (`extension/src/adapters/default-config.json`), and a remote copy replaces it only when it is signed and newer.
  One field, a bridge path segment ending in `()`, calls a getter on a page element's component data; only getters named in `BRIDGE_GETTERS` in `extension/src/adapters/bridge-read.ts` may be called, today only `data`.
  `validateConfig` refuses any other name and the reader skips it too, so remote data never chooses code to run.

There is no `eval`, no `new Function`, no remote script and no inline script.
`web-ext lint` reports `innerHTML` in the Svelte runtime chunk: that is Svelte cloning the compiled, static templates of the add-on's own pages, never remote or page content.
The in-page UI on the platforms is built with DOM calls and no `innerHTML` (`packages/shared/src/inpage`).

## Data collection

The manifest declares no required data collection and two optional kinds, and nothing is sent until the person allows each:
- `websiteContent`: tags and reports the person chooses to send, which carry the platform, the item or source ID, their answers and a random install ID.
  Until it is allowed, tags wait on the device and Options opens at Sharing, where one click allows it.
- `authenticationInfo`: the plan token of the paid Plus plan, or the reviewer token of a curator.
  It is asked for from the click on Connect or Start 14 days free.

List downloads and the adapter configuration carry no identifier at all.
No request carries a page address, a platform account name or what the person watches.
The privacy policy is at https://getcolander.com/privacy.

## Plus and pairing codes

Blocking is free.
Plus is an optional paid plan (with a 14-day trial that needs no account) that adds per-platform strictness, topics and settings sync; paying never changes a verdict.
Plus is bought on the website, never in the add-on.
The website hands the plan to the add-on with a pairing code: the signed-in account shows an 8-character code on the website, the person types it in Options under Plan, and the add-on exchanges it once for a signed plan token (`POST /v1/pair/claim`).
Curators connect the review sidebar the same way, with a reviewer code typed into the sidebar.
