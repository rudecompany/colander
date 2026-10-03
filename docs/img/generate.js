// Generates the five diagrams from the product requirements doc as standalone SVG files.
// Usage: node gen.js <output directory>
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

// Colander palette (see "Color tokens" in the spec). Line colors are neutral greys for diagrams.
const C = {
  ink: '#1A1C1F',
  quiet: '#5A5F66',
  edge: '#BDB8AD',
  line: '#8E8A80',
  grid: '#E4E0D8',
  tint: '#F3F0E9',
  accent: '#1F4E8C',
  accentFill: '#E4EAF1', // brand blue at 12% over white
  bg: '#FFFFFF',
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.len ? ` textLength="${o.len}" lengthAdjust="spacingAndGlyphs"` : ''} font-size="${o.size || 13}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill || C.ink}">${esc(s)}</text>`;
const svg = (h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 ${h}" width="760" height="${h}" role="img" aria-label="${esc(label)}" font-family="${FONT}" font-size="13">\n<title>${esc(label)}</title>\n<rect width="760" height="${h}" fill="${C.bg}"/>\n${body}\n</svg>\n`;
const title = s => t(24, 34, s, { size: 15, weight: 600 });
const marker = id =>
  `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.line}"/></marker></defs>`;

// Shared glyph geometry
const hole = (x, y) => `M${x - 2} ${y}a2 2 0 1 0 4 0a2 2 0 1 0 -4 0Z`;
const spark = (x, y, r, k) =>
  `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
// Colander mark centred on (cx, cy)
const mark = (cx, cy) =>
  `<rect x="${cx - 25}" y="${cy - 10}" width="50" height="5" rx="2.5"/>` +
  `<path fill-rule="evenodd" d="M${cx - 19} ${cy - 5}A19 19 0 0 0 ${cx + 19} ${cy - 5}Z${hole(cx - 9, cy + 1)}${hole(cx, cy + 1)}${hole(cx + 9, cy + 1)}${hole(cx - 5, cy + 7)}${hole(cx + 5, cy + 7)}${hole(cx, cy + 11)}"/>` +
  `<rect x="${cx - 8}" y="${cy + 13.5}" width="16" height="4.5" rx="1.5"/>`;

function iconSheet() {
  const label0 = 'Each verdict has its own shape, so it reads without color';
  const y0 = 60, cy = 112, my = 108;
  const [c1, c2, c3, c4, c5, c6] = [80, 200, 320, 440, 560, 680];
  const cell = cx => `<rect x="${cx - 52}" y="${y0}" width="104" height="104" rx="10" fill="${C.tint}" stroke="${C.edge}" stroke-width="1"/>`;
  const drop = cx =>
    `M${cx} ${cy - 22}C${cx + 4} ${cy - 14} ${cx + 14} ${cy - 6} ${cx + 14} ${cy + 6}A14 14 0 0 1 ${cx - 14} ${cy + 6}C${cx - 14} ${cy - 6} ${cx - 4} ${cy - 14} ${cx} ${cy - 22}Z`;
  const label = (cx, name, desc) =>
    t(cx, 190, name, { anchor: 'middle', weight: 600 }) + t(cx, 208, desc, { anchor: 'middle', size: 11.5, fill: C.quiet });
  const parts = [
    title(label0),
    cell(c1), `<g fill="${C.ink}">${mark(c1, my)}</g>`, label(c1, 'Brand mark', 'Colander'),
    cell(c2), `<path d="${drop(c2)}" fill="${C.ink}"/>`, label(c2, 'Slop', 'Solid drop'),
    cell(c3),
    `<path d="M${c3 - 14} ${cy + 6}A14 14 0 0 0 ${c3 + 14} ${cy + 6}Z" fill="${C.ink}"/>`,
    `<path d="${drop(c3)}" fill="none" stroke="${C.ink}" stroke-width="2.5" stroke-linejoin="round"/>`,
    label(c3, 'Likely slop', 'Half-filled drop'),
    cell(c4),
    `<path d="${spark(c4 - 3, cy + 3, 20, 3.5)}" fill="${C.ink}"/>`,
    `<path d="${spark(c4 + 16, cy - 15, 7, 1.2)}" fill="${C.ink}"/>`,
    label(c4, 'AI-made', 'Sparkle'),
    cell(c5),
    `<polygon points="${c5 - 3},${cy - 19} ${c5 - 22},${cy} ${c5 - 3},${cy + 19}" fill="${C.ink}"/>`,
    `<polygon points="${c5 + 3},${cy - 19} ${c5 + 22},${cy} ${c5 + 3},${cy + 19}" fill="none" stroke="${C.ink}" stroke-width="2.5" stroke-linejoin="round"/>`,
    label(c5, 'Disputed', 'Split diamond'),
    cell(c6),
    `<path fill-rule="evenodd" fill="${C.ink}" d="M${c6 - 20} ${cy}a20 20 0 1 0 40 0a20 20 0 1 0 -40 0ZM${c6 - 7.16} ${cy - 0.84}L${c6 - 3.07} ${cy + 3.25}L${c6 + 8.1} ${cy - 8.77}L${c6 + 11.91} ${cy - 5.23}L${c6 - 2.93} ${cy + 10.75}L${c6 - 10.84} ${cy + 2.84}Z"/>`,
    label(c6, 'Clear', 'Circle and check'),
  ];
  return svg(232, label0, parts.join('\n'));
}

function verdictFlow() {
  const label0 = 'An item is hidden only after three checks pass in order';
  const lx = 24, lw = 340, ox = 452, ow = 284, bh = 56, r1 = 60, r2 = 156, r3 = 252, r4 = 348, mid = 194;
  const box = (x, y, w, main) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${bh}" rx="8" fill="${main ? C.accentFill : C.bg}" stroke="${main ? C.accent : C.edge}" stroke-width="${main ? 2 : 1.25}"/>`;
  const pair = (x, y, name, body) =>
    t(x + 16, y + 24, name, { weight: 600 }) + t(x + 16, y + 40, body, { size: 11.5, fill: C.quiet });
  const a = d => `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.25" marker-end="url(#verdict-arrow)"/>`;
  const small = (x, y, s, anchor) => t(x, y, s, { size: 11.5, fill: C.quiet, anchor });
  const parts = [
    marker('verdict-arrow'),
    title(label0),
    a(`M${mid} ${r1 + bh}V${r2}`), a(`M${mid} ${r2 + bh}V${r3}`), a(`M${mid} ${r3 + bh}V${r4}`),
    a(`M${lx + lw} ${r1 + 28}H${ox}`), a(`M${lx + lw} ${r2 + 28}H${ox}`), a(`M${lx + lw} ${r3 + 28}H${ox}`),
    box(lx, r1, lw, false), pair(lx, r1, '1. AI evidence?', 'Platform label, credentials or creator statement'),
    box(lx, r2, lw, false), pair(lx, r2, '2. Mass-produced or hollow?', 'Source behavior or the content rubric says so'),
    box(lx, r3, lw, false), pair(lx, r3, '3. Confirmed?', 'Community consensus or staff review agrees'),
    box(lx, r4, lw, true), pair(lx, r4, 'Slop: hide', 'All three checks passed'),
    box(ox, r1, ow, false), pair(ox, r1, 'Not rated: allow', 'No AI evidence, so it cannot be slop'),
    box(ox, r2, ow, false), pair(ox, r2, 'AI-made: label', 'AI evidence only'),
    box(ox, r3, ow, false), pair(ox, r3, 'Likely slop: collapse', 'Evidence is in, consensus still forming'),
    small(mid + 10, r1 + bh + 24, 'yes'), small(mid + 10, r2 + bh + 24, 'yes'), small(mid + 10, r3 + bh + 24, 'yes'),
    small(lx + lw + 44, r1 + 20, 'no', 'middle'), small(lx + lw + 44, r2 + 20, 'no', 'middle'), small(lx + lw + 44, r3 + 20, 'not yet', 'middle'),
    `<rect x="24" y="420" width="712" height="72" rx="8" fill="${C.tint}" stroke="${C.edge}" stroke-width="1.25"/>`,
    t(40, 444, 'Overrides at any point', { weight: 600 }),
    small(40, 460, 'Split tags or an open appeal set Disputed: the item is shown with a mark.'),
    small(40, 476, 'A Not slop consensus or an upheld appeal sets Clear: the item is always allowed.'),
  ];
  return svg(516, label0, parts.join('\n'));
}

function architecture() {
  const label0 = 'Matching stays on the device, and only tags and reports go to the server';
  const k1 = 40, k2 = 272, k3 = 504, cw = 216, ch = 72, rowA = 88, swy = 184, rowB = 376, rowC = 472;
  const box = (x, y, w, h, main) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${main ? C.accentFill : C.bg}" stroke="${main ? C.accent : C.edge}" stroke-width="${main ? 2 : 1.25}"/>`;
  const frame = (y, h) => `<rect x="24" y="${y}" width="712" height="${h}" rx="10" fill="${C.tint}" stroke="${C.edge}" stroke-width="1"/>`;
  const trio = (x, y, name, l1, l2) =>
    t(x + 12, y + 24, name, { weight: 600 }) + t(x + 12, y + 40, l1, { size: 11.5, fill: C.quiet }) + t(x + 12, y + 56, l2, { size: 11.5, fill: C.quiet });
  const a = (d, both) =>
    `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.25"${both ? ' marker-start="url(#arch-arrow)"' : ''} marker-end="url(#arch-arrow)"/>`;
  const small = (x, y, s, anchor) => t(x, y, s, { size: 11.5, fill: C.quiet, anchor });
  const parts = [
    marker('arch-arrow'),
    title(label0),
    frame(56, 200), t(40, 77, 'On the device: the extension', { weight: 600 }),
    frame(344, 216), t(40, 365, 'Our services', { weight: 600 }),
    box(k1, rowA, cw, ch, false), trio(k1, rowA, 'Platform adapters', 'Read each card and its IDs.', 'Label, collapse or hide it.'),
    box(k2, rowA, cw, ch, true), trio(k2, rowA, 'Lists and settings', 'Kept on the device.', 'Matching happens here.'),
    box(k3, rowA, cw, ch, false), trio(k3, rowA, 'Popup, panel, options', 'Counts, recent actions,', 'strictness and plan.'),
    box(k1, swy, 680, 56, false),
    t(k1 + 12, swy + 24, 'Service worker', { weight: 600 }),
    small(k1 + 12, swy + 40, 'Syncs and verifies signed lists on a timer, and queues tags and reports for sending.'),
    box(k1, rowB, cw, ch, false), trio(k1, rowB, 'List service', 'Signed snapshots and', 'deltas through a CDN.'),
    box(k2, rowB, cw, ch, false), trio(k2, rowB, 'Scoring service', 'Reputation, consensus and', 'source signals set verdicts.'),
    box(k3, rowB, cw, ch, false), trio(k3, rowB, 'Tag service', 'Takes tags and reports.', 'Rate limits, abuse checks.'),
    box(k1, rowC, cw, ch, false), trio(k1, rowC, 'Billing', 'Hosted checkout. Sends', 'a signed plan token.'),
    box(k2, rowC, cw, ch, false), trio(k2, rowC, 'Review console', 'Staff queue for reports', 'and appeals.'),
    box(k3, rowC, cw, ch, false), trio(k3, rowC, 'Public site', 'Source pages, appeals,', 'decision log.'),
    a(`M${k1 + cw} ${rowA + 36}H${k2}`, true),
    a(`M380 ${swy}V${rowA + ch}`),
    a(`M148 ${rowA + ch}V${swy}`),
    a(`M148 ${rowB}V${swy + 56}`),
    a(`M612 ${swy + 56}V${rowB}`),
    a(`M${k3} ${rowB + 36}H${k2 + cw}`),
    a(`M${k2} ${rowB + 36}H${k1 + cw}`),
    a(`M380 ${rowB + ch}V${rowC}`, true),
    a(`M${k3} ${rowC + 36}H${k2 + cw}`),
    small(158, 304, 'signed lists'),
    small(622, 304, 'tags and reports'),
    small(380, 304, 'No page addresses or history cross here', 'middle'),
  ];
  return svg(584, label0, parts.join('\n'));
}

function feedMockup() {
  const label0 = 'Labeled and collapsed items stay on the page, and hidden items leave only a count';
  const px = 176, pw = 544, ry1 = 112, ry2 = 218, ry3 = 282, ry4 = 306;
  const thumb = y => `<rect x="${px}" y="${y}" width="160" height="90" rx="8" fill="${C.tint}" stroke="${C.edge}" stroke-width="1"/>`;
  const lines = y =>
    `<g fill="${C.grid}"><rect x="${px + 176}" y="${y + 10}" width="260" height="10" rx="5"/><rect x="${px + 176}" y="${y + 30}" width="200" height="10" rx="5"/><rect x="${px + 176}" y="${y + 62}" width="110" height="8" rx="4"/></g>`;
  const small = (x, y, s, anchor) => t(x, y, s, { size: 11.5, fill: C.quiet, anchor });
  const parts = [
    title(label0),
    // page frame and browser bar
    `<rect x="160" y="56" width="576" height="356" rx="10" fill="${C.bg}" stroke="${C.edge}" stroke-width="1.25"/>`,
    `<line x1="160" y1="96" x2="736" y2="96" stroke="${C.grid}"/>`,
    `<rect x="${px}" y="66" width="300" height="20" rx="10" fill="none" stroke="${C.grid}"/>`,
    // toolbar mark and count
    small(644, 80, 'Hidden on this page', 'end'),
    `<g transform="translate(668 77) scale(0.42)" fill="${C.ink}">${mark(0, 0)}</g>`,
    `<rect x="686" y="68" width="26" height="16" rx="8" fill="${C.accentFill}" stroke="${C.accent}" stroke-width="1.25"/>`,
    t(699, 80, '1', { anchor: 'middle', size: 11.5, weight: 600 }),
    // label
    thumb(ry1), lines(ry1),
    `<rect x="${px + 8}" y="${ry1 + 8}" width="78" height="20" rx="6" fill="${C.bg}" stroke="${C.ink}" stroke-width="1.25"/>`,
    `<path d="${spark(px + 20, ry1 + 18, 6, 1.1)}" fill="${C.ink}"/>`,
    t(px + 30, ry1 + 22, 'AI-made', { size: 11.5, weight: 600 }),
    // collapse
    `<rect x="${px}" y="${ry2}" width="${pw}" height="40" rx="8" fill="${C.bg}" stroke="${C.edge}" stroke-width="1.25"/>`,
    `<path d="M${px + 14.3} ${ry2 + 22.5}A5.7 5.7 0 0 0 ${px + 25.7} ${ry2 + 22.5}Z" fill="${C.ink}"/>`,
    `<path d="M${px + 20} ${ry2 + 11}C${px + 21.6} ${ry2 + 14.3} ${px + 25.7} ${ry2 + 17.5} ${px + 25.7} ${ry2 + 22.5}A5.7 5.7 0 0 1 ${px + 14.3} ${ry2 + 22.5}C${px + 14.3} ${ry2 + 17.5} ${px + 18.4} ${ry2 + 14.3} ${px + 20} ${ry2 + 11}Z" fill="none" stroke="${C.ink}" stroke-width="1.25"/>`,
    t(px + 36, ry2 + 25, 'Likely slop', { weight: 600 }),
    small(px + 122, ry2 + 25, 'Mass-produced, AI-made'),
    t(px + pw - 58, ry2 + 25, 'Show', { weight: 600, fill: C.accent, anchor: 'end' }),
    t(px + pw - 14, ry2 + 25, 'Why', { weight: 600, fill: C.accent, anchor: 'end' }),
    // hide
    `<line x1="${px}" y1="${ry3}" x2="302" y2="${ry3}" stroke="${C.line}" stroke-dasharray="4 4"/>`,
    `<line x1="594" y1="${ry3}" x2="${px + pw}" y2="${ry3}" stroke="${C.line}" stroke-dasharray="4 4"/>`,
    small(448, ry3 + 4, 'One item hidden: nothing is left in the page', 'middle'),
    // tag
    thumb(ry4), lines(ry4),
    `<rect x="652" y="${ry4 + 8}" width="60" height="28" rx="6" fill="${C.bg}" stroke="${C.ink}" stroke-width="1.25"/>`,
    `<polygon points="664,${ry4 + 17} 671,${ry4 + 17} 676,${ry4 + 22} 671,${ry4 + 27} 664,${ry4 + 27}" fill="none" stroke="${C.ink}" stroke-width="1.25" stroke-linejoin="round"/>`,
    t(683, ry4 + 26.5, 'Tag', { size: 12.5, weight: 600 }),
    // notes in the left gutter
    t(24, ry1 + 16, 'Label', { weight: 600 }), small(24, ry1 + 32, 'Chip on the item.'), small(24, ry1 + 48, 'Nothing removed.'),
    t(24, ry2 + 17, 'Collapse', { weight: 600 }), small(24, ry2 + 33, 'Shrinks to one line'),
    t(24, ry3 + 4, 'Hide', { weight: 600 }), small(24, ry3 + 20, 'Gone, but counted'),
    t(24, ry4 + 34, 'Tag', { weight: 600 }), small(24, ry4 + 50, 'Two clicks, in place'),
  ];
  return svg(436, label0, parts.join('\n'));
}

function roadmap() {
  const label0 = 'Each phase opens only when the gate before it passes';
  const y0 = 60, bw = 128, bh = 96, gy = 108;
  const [b0, b1, b2, b3, b4] = [24, 170, 316, 462, 608];
  const [g1, g2, g3, g4] = [161, 307, 453, 599];
  const band = (x, main) =>
    `<rect x="${x}" y="${y0}" width="${bw}" height="${bh}" rx="8" fill="${main ? C.accentFill : C.bg}" stroke="${main ? C.accent : C.edge}" stroke-width="${main ? 2 : 1.25}"/>`;
  const phase = (x, main, name, dates, l1, l2) =>
    band(x, main) + t(x + 10, y0 + 24, name, { weight: 600 }) + t(x + 10, y0 + 40, dates, { size: 11.5, fill: C.quiet, len: dates.length > 14 ? 104 : 0 }) +
    t(x + 10, y0 + 62, l1, { size: 11.5 }) + t(x + 10, y0 + 78, l2, { size: 11.5 });
  const gate = (x, l1, l2) =>
    `<line x1="${x}" y1="${gy + 8}" x2="${x}" y2="${y0 + bh + 14}" stroke="${C.line}" stroke-width="1"/>` +
    `<path d="M${x} ${gy - 8}l8 8l-8 8l-8 -8z" fill="${C.line}"/>` +
    t(x, 186, l1, { anchor: 'middle', size: 11.5, fill: C.quiet }) + t(x, 202, l2, { anchor: 'middle', size: 11.5, fill: C.quiet });
  const parts = [
    title(label0),
    phase(b0, false, '0 Foundations', 'Oct\u2013Nov 2026', 'Legal review,', 'calibration set'),
    phase(b1, false, '1 Private beta', 'Dec 2026\u2013Jan 2027', 'YouTube, for', '500 testers'),
    phase(b2, false, '2 Public beta', 'Feb\u2013Mar 2027', 'Adds TikTok and', 'Instagram'),
    phase(b3, true, '3 Version 1.0', 'Apr\u2013May 2027', 'Adds Facebook', 'and the Plus plan'),
    phase(b4, false, '4 Version 1.1', 'Jul\u2013Sep 2027', 'Articles, search,', 'Family, Firefox'),
    gate(g1, 'Counsel sign-off,', 'thresholds set'),
    gate(g2, 'Wrong calls at or', 'under 1 in 100'),
    gate(g3, 'Appeals in 7 days,', 'brigading drill'),
    gate(g4, '1.0 goals met', 'on the audit'),
  ];
  return svg(232, label0, parts.join('\n'));
}

const files = {
  'verdict-flow.svg': verdictFlow(),
  'feed-mockup.svg': feedMockup(),
  'architecture.svg': architecture(),
  'icon-sheet.svg': iconSheet(),
  'roadmap.svg': roadmap(),
};
for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), body, 'utf8');
  console.log('wrote', name, body.length, 'bytes');
}
