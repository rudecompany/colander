// Styles for everything Colander adds to a host page. Shadow roots adopt one constructed
// sheet, which page CSS cannot reach and CSP style-src does not govern. No fonts are loaded
// into host pages: the system font stack only (spec: Typography).

export const SHEET = `
:host {
	all: initial;
	--font: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	--surface: #ffffff;
	--raised: #f3f0e9;
	--border: #d9d5cc;
	--border-strong: #bdb8ad;
	--text: #1a1c1f;
	--muted: #5a5f66;
	--brand: #1f4e8c;
	--brand-fg: #ffffff;
	--hover: rgb(26 28 31 / 0.06);
	--ink: #1a1c1f;
	--on-ink: #f2f0eb;
	--on-ink-muted: #a7abb1;
	--on-ink-brand: #8fb8f0;
	--slop: #a8380f; --slop-tint: #fbe9e2; --slop-media: #ff8a5c;
	--likely: #7a5200; --likely-tint: #fbf0d6; --likely-media: #ffc857;
	--ai: #48535f; --ai-tint: #eceff3; --ai-media: #c2cad6;
	--disputed: #6b3fa0; --disputed-tint: #f0e8fa; --disputed-media: #c8a6ff;
	--clear: #1b6e45; --clear-tint: #e3f4ea; --clear-media: #6fd6a3;
	--shadow: 0 8px 28px rgb(26 28 31 / 0.16), 0 1px 3px rgb(26 28 31 / 0.08);
	--fast: 120ms;
	--slow: 200ms;
	--ease: cubic-bezier(0, 0, 0.2, 1);
	font: 400 14px/20px var(--font);
	color: var(--text);
	-webkit-font-smoothing: antialiased;
}
:host([theme='dark']) {
	--surface: #15171a;
	--raised: #1f2226;
	--border: #3a3e44;
	--border-strong: #5a5f66;
	--text: #f2f0eb;
	--muted: #a7abb1;
	--brand: #8fb8f0;
	--brand-fg: #15171a;
	--hover: rgb(242 240 235 / 0.08);
	--slop: #ff8a5c; --slop-tint: #3a2219;
	--likely: #ffc857; --likely-tint: #372c14;
	--ai: #c2cad6; --ai-tint: #2a2e34;
	--disputed: #c8a6ff; --disputed-tint: #2e2540;
	--clear: #6fd6a3; --clear-tint: #183026;
	--shadow: 0 8px 28px rgb(0 0 0 / 0.5), 0 1px 3px rgb(0 0 0 / 0.4);
}
* { box-sizing: border-box; }
button, input, textarea, a { font: inherit; color: inherit; }
button { margin: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.ink :focus-visible, .ink:focus-visible, .cover :focus-visible, .toast :focus-visible { outline-color: var(--on-ink-brand); }
svg { display: block; flex: none; }
.lucide { width: 14px; height: 14px; stroke-width: 1.75; }
.num { font-variant-numeric: tabular-nums; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Verdict colors: on light or dark surfaces, and on media (ink). */
.v-slop { color: var(--slop); } .v-likely_slop { color: var(--likely); } .v-ai_made { color: var(--ai); }
.v-disputed { color: var(--disputed); } .v-clear { color: var(--clear); }
.ink .v-slop, .cover .v-slop { color: var(--slop-media); }
.ink .v-likely_slop, .cover .v-likely_slop { color: var(--likely-media); }
.ink .v-ai_made, .cover .v-ai_made { color: var(--ai-media); }
.ink .v-disputed, .cover .v-disputed { color: var(--disputed-media); }
.ink .v-clear, .cover .v-clear { color: var(--clear-media); }

/* Verdict chip: glyph and word, never truncated. Hover or focus offers Why. */
.chip {
	display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px;
	border: 0; border-radius: 6px; font: 600 12px/16px var(--font); white-space: nowrap;
	transition: background-color var(--fast) var(--ease);
}
.chip.ink { background: var(--ink); color: var(--on-ink); }
.chip.ink:hover { background: #2b2e33; }
.chip.tint { color: var(--text); }
.chip.tint[data-v='slop'] { background: var(--slop-tint); }
.chip.tint[data-v='likely_slop'] { background: var(--likely-tint); }
.chip.tint[data-v='ai_made'] { background: var(--ai-tint); }
.chip.tint[data-v='disputed'] { background: var(--disputed-tint); }
.chip.tint[data-v='clear'] { background: var(--clear-tint); }
.chip.plain { height: 28px; padding: 0 10px; font-size: 14px; line-height: 20px; gap: 8px; }
.chip .why { display: none; align-items: center; gap: 6px; font-weight: 400; color: inherit; opacity: 0.8; }
.chip .why::before { content: ''; width: 1px; height: 12px; background: currentColor; opacity: 0.4; }
.chip:hover .why, .chip:focus-visible .why { display: inline-flex; }

/* Tag button: 28 px, the lucide tag and the word. */
.tag {
	display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px 0 8px;
	border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text);
	font: 600 12px/16px var(--font); white-space: nowrap;
	transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.tag:hover { background: var(--raised); }
.tag.ink { background: var(--ink); border-color: transparent; color: var(--on-ink); }
.tag.ink:hover { background: #2b2e33; }
.tag[aria-expanded='true'] { border-color: var(--brand); }

/* Text buttons: Show, Why, Undo. */
.link {
	display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px; border: 0; border-radius: 6px;
	background: none; color: var(--brand); font: 600 14px/20px var(--font); white-space: nowrap; text-decoration: none;
	transition: background-color var(--fast) var(--ease);
}
.link:hover { background: color-mix(in srgb, var(--brand) 12%, transparent); }
.link.sm { height: 24px; padding: 0 6px; font-size: 12px; line-height: 16px; }

/* Collapsed bar: one 40 px line that replaces the card. Enter shows the item. */
.bar {
	display: flex; align-items: center; gap: 8px; width: 100%; height: 40px; padding: 0 4px 0 12px;
	background: var(--raised); border: 1px solid var(--border); border-radius: 10px; color: var(--text);
	animation: cl-in var(--slow) var(--ease);
}
.bar .verdict { font-weight: 600; white-space: nowrap; }
.bar .dot { color: var(--muted); }
.bar .reason { flex: 1 1 auto; min-width: 0; color: var(--muted); font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .actions { display: flex; gap: 0; flex: none; }

/* Swipe feeds: the video is covered and paused until Show or Skip. */
.cover {
	position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
	gap: 12px; padding: 24px; background: #15171a; color: var(--on-ink); text-align: center; border-radius: inherit;
	animation: cl-in var(--slow) var(--ease);
}
.cover .verdict { display: flex; align-items: center; gap: 8px; font: 600 16px/24px var(--font); }
.cover .reason { color: var(--on-ink-muted); max-width: 32ch; }
.cover .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 4px; }
.cover .link { color: var(--on-ink-brand); }
.btn {
	display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px;
	border-radius: 6px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
	font: 600 14px/20px var(--font); white-space: nowrap; transition: background-color var(--fast) var(--ease), filter var(--fast) var(--ease);
}
.btn:hover { background: var(--raised); }
.btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-fg); }
.btn.primary:hover { filter: brightness(1.08); background: var(--brand); }
.btn[disabled] { opacity: 0.45; cursor: default; }
.cover .btn { background: transparent; border-color: #5a5f66; color: var(--on-ink); }
.cover .btn:hover { background: rgb(242 240 235 / 0.08); }
.cover .btn.primary { background: var(--on-ink-brand); border-color: var(--on-ink-brand); color: #15171a; }

/* Layer: popovers, notices and the report dialog live above the page. */
.layer { position: fixed; inset: 0; pointer-events: none; }
.pop {
	position: fixed; pointer-events: auto; width: 288px; max-width: calc(100vw - 16px); padding: 12px;
	background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
	animation: cl-in var(--fast) var(--ease);
}
.pop h2, .dialog h2 { margin: 0; font: 600 14px/20px var(--font); }
.pop .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; }
.pop p { margin: 0; }
.muted { color: var(--muted); }
.caption { font-size: 12px; line-height: 16px; }
.close { width: 24px; height: 24px; padding: 0; display: inline-grid; place-items: center; border: 0; border-radius: 6px; background: none; color: var(--muted); }
.close:hover { background: var(--hover); color: var(--text); }
.opts { display: flex; flex-direction: column; gap: 2px; }
.opt {
	display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 6px;
	background: none; color: var(--text); text-align: left; font: 400 14px/20px var(--font); transition: background-color var(--fast) var(--ease);
}
.opt:hover { background: var(--hover); }
.opt .t { font-weight: 600; }
.opt .d { display: block; color: var(--muted); font-size: 12px; line-height: 16px; font-weight: 400; }
.opt .mark { width: 16px; display: grid; place-items: center; }
.rule { height: 1px; margin: 8px 0; background: var(--border); border: 0; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.scam { font-size: 12px; line-height: 16px; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.scam:hover { color: var(--text); }
.done { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0 8px; }
.done svg { color: var(--clear); margin-top: 2px; }
.group { margin-top: 8px; }
.group > .label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; line-height: 16px; }
.choices { display: flex; flex-wrap: wrap; gap: 4px; }
.choice {
	height: 28px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); color: var(--text);
	font: 400 12px/16px var(--font); transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}
.choice:hover { background: var(--raised); }
.choice[aria-pressed='true'], .choice[aria-checked='true'] { background: color-mix(in srgb, var(--brand) 14%, var(--surface)); border-color: var(--brand); color: var(--text); font-weight: 600; }
.check { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 14px; line-height: 20px; cursor: pointer; }
.check input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--brand); cursor: pointer; }
.check.top { align-items: flex-start; padding: 4px 0; }
.check.top input { margin-top: 2px; }
.check .t { display: block; }
.check .d { display: block; color: var(--muted); font-size: 12px; line-height: 16px; }

/* Why popover: five lines at most. */
.why-sig { margin: 0; padding: 0; list-style: none; }
.why-sig li { display: flex; gap: 6px; align-items: baseline; }
.why-src { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 16px; }
.why-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 12px; line-height: 16px; }
.why-links a { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.why-actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px -4px -4px; }

/* Notices: one at a time, announced politely, never stacked. */
.toast {
	position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
	display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px); min-height: 40px; padding: 4px 4px 4px 16px;
	background: var(--ink); color: var(--on-ink); border-radius: 10px; box-shadow: var(--shadow);
	animation: cl-up var(--slow) var(--ease);
}
.toast.solo { padding-right: 16px; }
.toast .link { color: var(--on-ink-brand); }
.toast .link:hover { background: rgb(143 184 240 / 0.16); }

/* Report source dialog. */
.backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px; background: rgb(26 28 31 / 0.48); pointer-events: auto; animation: cl-in var(--fast) var(--ease); }
.dialog {
	width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 24px;
	background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
}
.dialog .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
.dialog h2 { display: flex; align-items: center; gap: 8px; font-size: 16px; line-height: 24px; }
.field { margin-top: 16px; border: 0; padding: 0; min-width: 0; }
.field > .label, .field > legend { display: block; padding: 0; margin-bottom: 8px; font-weight: 600; }
.source-box { display: flex; flex-direction: column; gap: 0; padding: 8px 12px; background: var(--raised); border-radius: 6px; }
.examples { display: flex; flex-direction: column; gap: 0; max-height: 196px; overflow: auto; margin: 0 -4px; padding: 0 4px; }
.examples .check { min-height: 32px; }
.examples .check span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea {
	display: block; width: 100%; min-height: 80px; padding: 8px 12px; resize: vertical; border: 1px solid var(--muted); border-radius: 6px;
	background: var(--surface); color: var(--text); font: 400 14px/20px var(--font);
}
textarea:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.count { margin-top: 4px; text-align: right; }
.error { margin-top: 12px; color: var(--slop); }
.dialog .foot { justify-content: flex-end; margin-top: 24px; }

@keyframes cl-in { from { opacity: 0; } }
@keyframes cl-up { from { opacity: 0; transform: translate(-50%, 8px); } }
@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
