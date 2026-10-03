// The one stylesheet for everything Colander adds to a host page. Shadow roots adopt it as a
// constructed sheet, which page CSS cannot reach and CSP style-src does not govern.
// Tokens and the shared component CSS come from tokens.generated.ts (made from colander.css and
// parts.css); only the font is overridden, with the system stack, so no font loads on host pages.
// Flat: the one shadow is for things that float. At most 14 KB (a test checks).
import { PARTS, TOKENS, TOKENS_DARK } from './tokens.generated';

const LOCAL = `
:host { all: initial; --cl-font: var(--cl-font-system); font: var(--cl-body); color: var(--cl-text); -webkit-font-smoothing: antialiased; }
:host([data-kind='bar']), :host([data-kind='stub']) { display: block; container-type: inline-size; }
:host([data-kind='stub']) { height: 100%; }
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea, a { font: inherit; color: inherit; }
button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--cl-brand); outline-offset: 2px; }
svg { display: block; flex: none; }
.lucide { width: 16px; height: 16px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.muted { color: var(--cl-text-muted); }
p, h2 { margin: 0; }

button.cl-chip { cursor: pointer; }
.cl-chip .why { display: none; align-items: center; gap: 6px; margin-left: 2px; }
.cl-chip .why::before { content: ''; width: 1px; height: 12px; background: currentColor; opacity: 0.5; }
.cl-chip:hover .why, .cl-chip:focus-visible .why, :host([data-open]) .cl-chip .why { display: inline-flex; }

.t { font: var(--cl-body-strong); white-space: nowrap; }
.r { min-width: 0; color: var(--cl-text-muted); font: var(--cl-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acts { display: flex; flex: none; gap: 0; }
.bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 4px 0 12px; border: 1px solid var(--cl-host-line); border-radius: var(--cl-r-card); animation: cl-in var(--cl-slow) var(--cl-ease); }
.bar .r { flex: 1 1 auto; }
.bar .acts { margin-left: auto; }
@container (max-width: 519px) { .bar .r { display: none; } }
@container (max-width: 379px) { .bar .t { display: none; } }
@container (max-width: 279px) { .bar .acts .lucide { display: none; } }
.stub { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 100%; height: 100%; min-height: 120px; padding: 8px; border: 1px solid var(--cl-host-line); border-radius: var(--cl-r-card); text-align: center; animation: cl-in var(--cl-slow) var(--cl-ease); }
.stub .r { max-width: 100%; }
@container (max-width: 199px) { .stub .r { display: none; } }

.cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; border-radius: inherit; animation: cl-in var(--cl-slow) var(--cl-ease); }
.cover .t { font: var(--cl-body-lg); font-weight: 600; }
.cover .r { max-width: 32ch; font: var(--cl-body); white-space: normal; }
.cover .acts { flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 4px; }

.pill { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px 0 8px; border: 0; border-radius: var(--cl-r-full); background: var(--cl-host-fill); color: var(--cl-text); font: var(--cl-chip); white-space: nowrap; transition: box-shadow var(--cl-fast) var(--cl-ease); }
.pill:hover, .pill[aria-expanded='true'] { box-shadow: inset 0 0 0 1px var(--cl-host-line); }

.layer { position: fixed; inset: 0; pointer-events: none; }
.layer > * { pointer-events: auto; }
.float { position: fixed; animation: cl-pop var(--cl-fast) var(--cl-ease); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.menu { width: 280px; padding: 8px; }
.menu h2 { padding: 4px 8px 8px; font: var(--cl-body-strong); }
.opt { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: var(--cl-r-chip); background: none; text-align: left; transition: background-color var(--cl-fast) var(--cl-ease); }
.opt:hover, .opt:focus-visible { background: color-mix(in srgb, var(--cl-text) 6%, transparent); }
.opt .cl-glyph { margin-top: 2px; }
.opt b, .check b { display: block; font: var(--cl-body-strong); }
.opt small, .check small { display: block; color: var(--cl-text-muted); font: var(--cl-caption); }
.sheet { display: grid; gap: 16px; }
.sheet h2 { font: var(--cl-body-strong); }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { margin-bottom: 8px; padding: 0; font: var(--cl-body-strong); }
.check { display: flex; align-items: flex-start; gap: 8px; min-height: 28px; padding: 4px 0; cursor: pointer; }
.check input { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--cl-brand-fill); }
.choice { padding: 8px 12px; border: 1px solid var(--cl-border-strong); border-radius: var(--cl-r-chip); }
.choice:has(input:checked), .tile:has(input:checked) { border-color: var(--cl-brand); box-shadow: inset 0 0 0 1px var(--cl-brand); background: var(--cl-brand-tint); }
.stack { display: grid; gap: 8px; }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tile { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--cl-border); border-radius: var(--cl-r-chip); cursor: pointer; }
.tile input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--cl-brand-fill); }
.tile img, .tile .ph { flex: none; width: 48px; height: 48px; border-radius: var(--cl-r-chip); object-fit: cover; background: var(--cl-surface-raised); }
.tile span { display: -webkit-box; overflow: hidden; font: var(--cl-caption); -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
textarea { display: block; width: 100%; padding: 8px 12px; border: 1px solid var(--cl-border-strong); border-radius: var(--cl-r-chip); background: var(--cl-surface); color: var(--cl-text); font: var(--cl-body); resize: vertical; }
.report { top: 72px; right: 24px; width: 400px; max-height: min(560px, calc(100vh - 96px)); overflow: auto; }
.steps { display: inline-flex; align-items: center; gap: 6px; color: var(--cl-text-muted); font: var(--cl-figure); letter-spacing: 0.02em; white-space: nowrap; }
.steps i { width: 6px; height: 6px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--cl-text-muted); }
.steps i.on { background: var(--cl-text); box-shadow: none; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
.err { display: flex; align-items: flex-start; gap: 6px; }
.toast-at { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); animation: cl-up var(--cl-slow) var(--cl-ease); }

@keyframes cl-in { from { opacity: 0; } }
@keyframes cl-pop { from { opacity: 0; transform: translateY(-4px); } }
@keyframes cl-up { from { opacity: 0; transform: translate(-50%, 8px); } }
@media (prefers-reduced-motion: reduce) { *:not(.cl-count > i) { animation: none !important; transition: none !important; } }
@media (forced-colors: active) {
	.cl-chip, .bar, .stub, .pill, .cl-pop, .cl-toast { border: 1px solid CanvasText; }
	.cl-glyph { color: CanvasText; }
}
`;

const min = (css: string) =>
	css
		.replace(/\s+/g, ' ')
		.replace(/\s*([{};,>])\s*/g, '$1')
		.replace(/:\s+/g, ':')
		.replace(/;}/g, '}')
		.trim();

/** For the content script: hosts carry theme="light" or theme="dark" from the page's own darkness. */
export const SHEET = TOKENS + PARTS + min(LOCAL);

/** For the website: theme="auto" follows the system setting, like the page around it. */
export const SHEET_AUTO = `${SHEET}@media (prefers-color-scheme:dark){:host([theme='auto']){${TOKENS_DARK}}}`;
