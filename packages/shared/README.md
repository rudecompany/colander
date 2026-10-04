# @colander/shared

The one visual system for the Colander website and the Colander extension.
Tokens, copy, date and price formats, glyphs, Svelte components and the in-page builders all live here, so the two apps match exactly.
No app defines its own button, card, chip, badge, segmented control, stat, date format, price string, privacy copy or verdict copy.

## What lives where

| Path | What it holds |
| --- | --- |
| `src/styles/colander.css` | The only token file: color, type, spacing, radius, shadow and motion tokens, the Mittsu mapping, the band, utilities and texture. |
| `src/styles/parts.css` | Component CSS shared by pages and the in-page shadow DOM: chip, buttons, links, popover, evidence card, toast. |
| `src/styles/tokens.css` | Mittsu's base tokens, which colander.css overrides. |
| `src/verdicts.ts` | Verdict, strictness, tag, test and signal vocabulary, and the strictness table. |
| `src/copy.ts` | The definition, privacy facts, permissions, plan copy, platform surfaces, in-page strings and the demo feed. |
| `src/layers.ts` | The four evidence layers and their words. |
| `src/utils/format.ts` | Every date, time, number and price format (en-GB dates). |
| `src/glyphs.ts` | Geometry for the mark, the small mark, the paused marks and the 5 verdict glyphs, plus the toolbar colors. |
| `src/inpage/` | The in-page builders, their stylesheet (SHEET), Declarative Shadow DOM helpers and the demo feed. |
| `src/components/colander/` | Colander components for both apps. |
| `src/components/ui/` | The Mittsu components, themed for Colander. |
| `scripts/gen-inpage-tokens.ts` | Writes `src/inpage/tokens.generated.ts` from colander.css and parts.css. |

## Using it

Import `@colander/shared/styles/tokens.css`, then `@colander/shared/styles/colander.css`, once at the app root.
colander.css pulls in parts.css and the Atkinson Hyperlegible Next font.
Import each Mittsu component's CSS the app uses, such as `@colander/shared/components/ui/button/button.css`.
Colander components import the Mittsu CSS they need themselves.
Components come from `@colander/shared`, and the in-page builders from `@colander/shared/inpage`.

```svelte
<script lang="ts">
	import { PageHeader, StrictnessControl, VerdictChip } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
</script>
```

## Principles

The product is the picture: every image of Colander is a shipped component rendered live, never a mockup.
Every value has one source in this package, and in-page tokens are generated, never copied by hand.
Copy is plain, calm, fair and open: sentence case, no exclamation marks, digits for numbers.
Say "Hidden for you", "Support our work" and "list", and follow the spec's say-and-not table for every other word.
Verdict words describe items and sources, never people.
Every surface follows the system's light or dark setting.
Everything reads complete without motion or JavaScript; motion is 120 ms or 200 ms ease-out, and none under reduced motion.

## Color

Color has jobs.
Verdict colors appear only inside a VerdictChip.
Brand blue is for actions, links, focus and selected states only.
Everything else is paper, ink and neutral, and color is never the only signal.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--cl-paper` | #FAF7F2 | #121417 | Page base on every website and extension page |
| `--cl-wash` | #F2EEE6 | #181A1E | The only alternating section tint |
| `--cl-surface` | #FFFFFF | #15171A | Cards, inputs, popovers |
| `--cl-surface-raised` | #F3F0E9 | #1F2226 | Segmented tracks, row hover, BrowserFrame chrome, Kbd |
| `--cl-border` | #D9D5CC | #3A3E44 | Hairlines |
| `--cl-border-strong` | #767B82 | #6B7078 | Outlines of controls and badges |
| `--cl-text` | #1A1C1F | #F2F0EB | Text, the mark on pages, filled data dots |
| `--cl-text-muted` | #5A5F66 | #A7ABB1 | Secondary text, the second clause of two-tone headlines |
| `--cl-brand` | #1F4E8C | #8FB8F0 | Links, focus ring, selected text, quiet buttons |
| `--cl-brand-fill` | #1F4E8C | #3870C0 | Primary button fill, switch on-track |
| `--cl-brand-fg` | #FFFFFF | #FFFFFF | Text on brand-fill |
| `--cl-brand-tint` | #E4EAF1 | #1F2A3A | Selected segment, nav item and strictness card |
| `--cl-mark` | #4F88D8 | #4F88D8 | Toolbar icon, favicon and store icon only |
| `--cl-ink` | #1A1C1F | #1A1C1F | Ink chips on media and toasts |
| `--cl-on-ink`, `--cl-on-ink-muted`, `--cl-on-ink-brand` | #F2F0EB, #A7ABB1, #8FB8F0 | same | Text and links on ink and on the band |
| `--cl-on-ink-fill` | #3870C0 | #3870C0 | Primary buttons on ink |
| `--cl-band`, `--cl-band-card`, `--cl-band-line` | #1A1C1F, #24272C, #3A3E44 | #1F2226, #2A2E33, #3A3E44 | The one ink band per page and the Plus price card |
| `--cl-dot` | #D9D5CC | #2C3035 | Decorative dots |
| `--cl-dot-strong` | #8A857B | #6B7078 | Data dots and bullets |
| `--cl-host-line`, `--cl-host-fill` | black at 14% and 5% | white at 18% and 10% | In-page hairlines and pills on host pages |

Contrast ratios for every pair are recorded beside the tokens in colander.css.
A new color is added only with its computed ratio.
The `.cl-band` class gives its whole subtree the dark values, in both modes; a test keeps them equal to the dark block.
The `.cl-ink` class does the same for toasts.

## Type

Atkinson Hyperlegible Next is the only family, with tabular figures everywhere.
Host pages get the system font stack instead.
Nothing is set below 12 px, and tracking is never tighter than -0.02em.

| Role | Token and class | Value |
| --- | --- | --- |
| display-xl | `--cl-display-xl`, `.cl-display-xl` | 600 64/66, 52/56 from 640 to 1023 px, 40/44 below 640, -0.02em; the website hero only |
| display-lg | `--cl-display-lg`, `.cl-display-lg` | 600 44/48, 36/40, 30/36, -0.02em; website H2, inner-page H1, welcome H1 |
| display | `--cl-display`, `.cl-display` | 700 32/40; options section H1, source page H1 |
| title-lg | `--cl-title-lg`, `.cl-title-lg` | 600 24/32, -0.01em |
| title | `--cl-title`, `.cl-title` | 600 20/28 |
| lead | `--cl-lead`, `.cl-lead` | 400 20/30, 18/28 below 640 |
| body-lg | `--cl-body-lg` | 400 16/24 |
| body | `--cl-body`, `--cl-body-strong` | 400 or 600 14/20 |
| caption | `--cl-caption` | 400 12/16 |
| chip | `--cl-chip` | 600 12/16 |
| stat-lg | `--cl-stat-lg`, `.cl-stat-lg` | 600 48/52, 36/40 below 640 |
| stat | `--cl-stat`, `.cl-stat` | 600 28/32 |
| eyebrow | `.cl-eyebrow` | 600 12/16, +0.02em, after a 3-dot mark |
| figure | `.cl-figure` | 600 12/16, +0.02em; dates, times, step numbers, versions, Kbd |

Two-tone headlines put the continuation in `.cl-tone2`, at the same size and weight.
Body text runs to 68ch (`.cl-measure`) and display text to 22ch (`.cl-measure-display`).

## Space, shape and depth

Components use 4, 8, 12, 16, 24 and 32 (`--cl-s1` to `--cl-s6`).
Page layout adds 48, 64, 96 and 128 (`--cl-s7` to `--cl-s10`).
`.cl-container` is the website's 1200 px container with 32, 24 or 16 px of side padding, and `.cl-grid` its 12 columns with a 24 px gutter.
`.cl-section` gives 128, 96 or 64 px of block padding.
Radius 6 (`--cl-r-chip`) is for chips, badges, inputs, buttons, menu items, Kbd, checkboxes and segmented selections.
Radius 10 (`--cl-r-card`) is for cards, popovers, menus, toasts, dialogs, tracks and frames.
Full (`--cl-r-full`) is for badges, switches, radios, pills and dots, and no other radius is allowed.
Depth comes from tone and hairlines: paper, then surface cards with 1 px borders, then floating things.
`--cl-shadow-pop` is the one shadow, only on popovers, menus, tooltips, toasts, dialogs and the popup drawn on the website.
All texture is CSS: `.cl-dots` (DotField), `.cl-perf` and `.cl-perf-v` (PerforationRow).

## Mittsu components

Button, SegmentedControl, Switch, Checkbox, RadioGroup, Input, Textarea, NativeSelect, Field, Card, Badge, Kbd, Tabs, Tooltip, Popover, Dialog, Toast, Table, Separator, Empty and Timeline are themed for Colander.

| Button size | Height | Padding | Type | Where |
| --- | --- | --- | --- | --- |
| `sm` | 28 | 10 | 600 12/16 | In-page pills, toast actions |
| `md` | 32 | 12 | 600 14/20 | Extension and in-page default |
| `lg` | 36 | 14 | 600 14/20 | Website header |
| `xl` | 40 | 16 | 600 16/24 | Website default, options forms |
| `xxl` | 44 | 20 | 600 16/24 | Website hero, mobile full width, welcome bar, footer CTA |

Button variants are `primary`, `secondary` and `quiet`; the older `outline` and `ghost` still work.
There is no red or destructive variant: a destructive confirm is Primary inside a Dialog.
`href` renders a link styled as a button, and `loading` shows a static 3-dot mark and "Loading".
Inputs and selects are 32 tall (`md`) in the extension and 40 (`lg`) on the website.
SegmentedControl is 32 (`md`), 40 (`lg`) or 44 (`xl`), with a brand-tint fill that slides under the selection.
Cards pad 16 (`md`) or 24 (`lg`), never cast a shadow, and take an optional `title` and `aside`.
Every Badge is an outline pill, 20 tall (`md`) or 24 (`lg`).
Field errors are the circle-alert icon and the message in the text color, never a verdict color.

## Colander components

| Component | What it is |
| --- | --- |
| ColanderMark | The brand mark; `outline` for paused, `attention` for the dot |
| VerdictGlyph, VerdictChip | The verdict's shape, and the chip in `sm`, `md` and `lg`, `tint` or `ink` |
| VerdictTransition | Chip, arrow, chip, read as "Verdict changed from X to Y" |
| VerdictTally | Chips with counts, inline or as rows with a DotMeter |
| EvidenceCard | Why an item has its verdict: `popover`, `inline` or `full` |
| StrictnessControl, StrictnessTable | The three-stop control with its hint, and the table of treatments |
| FeedDemo, Thumb, BrowserFrame | The recreated feed (`full` or `mini`), its thumbnails and the browser window |
| PopupView | The toolbar popup as pure presentation, for the extension and the website |
| PageHeader, Eyebrow | Eyebrow, two-tone title and lede for inner pages and options sections |
| SettingRow | A labeled row with its control on the right |
| StatCell | A number with its label, foot line and zero-state sentence |
| DotUnitChart, DotMeter | Data dots in a grid or a row |
| PerforationRow, DotField, PerforatedDisc | The motif |
| PlatformTag, PlusTag | Outline badges with the platform name, or a lock and "Plus" |
| PriceCard | Free or Plus from PLAN_COPY |
| PrivacyFacts, PermissionsTable | What leaves the device, what never does, and why each permission is asked |
| LogRow | One decision log entry, 56 tall, optionally expanding |
| Lifecycle | Steps on perforation nodes: filled done, ring current, hollow later |
| LiveBadge | "Core list v.412, updated 3 min ago" |
| Menu | A trigger and a short list of actions on bits-ui's dropdown menu |
| Toast | The ink toast with its 4-dot countdown |
| CopyButton | Copies a value and says "Copied" |
| InPage | One shadow host on a page, filled by an in-page builder |

## In-page UI

The builders in `src/inpage/ui.ts` make the chip, Tag and Report pills, evidence popover, tag menu, detail and report sheets, and toast.
Hidden items have no builder: they leave the page like ads under an ad blocker, and the popup lists them.
Each takes a context `{ doc, site, fmt, strings }` from `inpageContext()` and callbacks, and returns plain elements.
They never touch `chrome.*` or the global document, and icons render from Lucide icon nodes through the context's document.
`Layer` keeps one popover, one sheet and one toast at a time above a host page.
`makeHost` makes a `<colander-ui>` shadow host that adopts SHEET and keeps clicks and keys from reaching the page.
SHEET is the generated tokens, parts.css and the in-page rules, with the system font, and stays under 14 KB.
The chip, evidence popover and toast share their markup and CSS with VerdictChip, EvidenceCard and Toast, so they match by construction.

## On the website

The website registers a prerender document once, for example with linkedom: `setServerDocument(() => parseHTML('<!doctype html><html><body></body></html>').document)`.
InPage then prerenders its builder as Declarative Shadow DOM, so the page reads complete without JavaScript.
In the browser, InPage reuses that shadow root, or attaches one after client-side navigation, and rebuilds with live callbacks.
`theme="auto"` follows the system setting.
`dsd()`, `dsdHost()` and `prerender()` serialize a builder by hand when a page needs the markup itself.
FeedDemo puts the whole recreated feed in one shadow host, so the hero ships the sheet once.

## Generated tokens

`pnpm -C packages/shared gen:tokens` rewrites `src/inpage/tokens.generated.ts` from colander.css and parts.css.
`node scripts/gen-inpage-tokens.ts --check` fails when the committed file is stale, for WXT's prepare hook and the web prebuild.
Page-only tokens, such as the website type steps, stay out of host pages.

## Checks

`pnpm -C packages/shared check` runs svelte-check with warnings as errors.
`pnpm -C packages/shared test` runs the vitest suite: the generated tokens match their sources, the band matches the dark block, SHEET stays under 14 KB, parts.css holds no color values, and the builders render in Node.
Hex colors belong only in this package, and `Intl.DateTimeFormat` only in `src/utils/format.ts`.
