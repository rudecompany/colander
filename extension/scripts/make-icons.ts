// Renders the toolbar and store icons from the brand geometry in packages/shared/src/glyphs.ts.
// Usage: node scripts/make-icons.ts   (writes public/icons/*.png and commits nothing else)
//
// States (spec: Logo and motif): active is the filled mark, paused the outlined mark at half
// strength, and either can carry the attention dot at the top right. 16 and 32 px use the
// MARK_SMALL simplification. The ink mark gets a thin light halo so it stays crisp on dark
// toolbars as well as light ones.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MARK, MARK_SMALL, MARK_SMALL_VIEWBOX, MARK_VIEWBOX, type GlyphShape } from '../../packages/shared/src/glyphs.ts';

const INK = '#1A1C1F';
const HALO = '#FFFFFF';
const DOT = '#1F4E8C';
const SIZES = [16, 32, 48, 128];
const STATES = ['active', 'paused', 'active-dot', 'paused-dot'] as const;

function svg(size: number, state: (typeof STATES)[number]): string {
	const small = size <= 32;
	const shapes: GlyphShape[] = small ? MARK_SMALL : MARK;
	const [x, y, w, h] = (small ? MARK_SMALL_VIEWBOX : MARK_VIEWBOX).split(' ').map(Number) as [number, number, number, number];
	const unit = w / size; // viewBox units per pixel
	const paused = state.startsWith('paused');
	const line = Math.max(1.25 * unit, 2.6);
	// Active: the halo is the filled silhouette grown by about 1 px. Paused: only the outline
	// grows, so the paused icon never reads stronger than the active one on a dark toolbar.
	// Paused strokes each outer outline and fills the holes, so small sizes stay clean.
	const outline = (d: string) => d.split(/(?=M)/)[0]!;
	const holes = (d: string) => d.split(/(?=M)/).slice(1).join('');
	const halo = shapes
		.map((s) =>
			paused
				? `<path d="${outline(s.d)}" fill="none" stroke="${HALO}" stroke-opacity="0.55" stroke-width="${line + 2 * unit}" stroke-linejoin="round"/>`
				: `<path d="${s.d}" fill="${HALO}" stroke="${HALO}" stroke-width="${2.8 * unit}" stroke-linejoin="round"/>`
		)
		.join('');
	const mark = shapes
		.map((s) =>
			paused
				? `<g opacity="0.5"><path d="${outline(s.d)}" fill="none" stroke="${INK}" stroke-width="${line}" stroke-linejoin="round"/>${holes(s.d) ? `<path d="${holes(s.d)}" fill="${INK}"/>` : ''}</g>`
				: `<path d="${s.d}" fill="${INK}"${s.evenodd ? ' fill-rule="evenodd"' : ''}/>`
		)
		.join('');
	// The attention dot: about a third of the icon, inset from the top-right corner, ringed in white.
	const r = (size <= 16 ? 3.2 : size * 0.12) * unit;
	const cx = x + w - r - 0.6 * unit, cy = y + r + 0.6 * unit;
	const dot = state.endsWith('dot')
		? `<circle cx="${cx}" cy="${cy}" r="${r + 1.2 * unit}" fill="${HALO}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${DOT}"/>`
		: '';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${size}" height="${size}" shape-rendering="geometricPrecision">${halo}${mark}${dot}</svg>`;
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const state of STATES) {
	for (const size of SIZES) {
		await page.setContent(`<body style="margin:0;background:transparent">${svg(size, state)}</body>`);
		const png = await page.locator('svg').screenshot({ omitBackground: true });
		writeFileSync(new URL(`${state}-${size}.png`, out), png);
	}
}
// A contact sheet on light and dark toolbars, for looking at the result.
const sheet = (bg: string) =>
	`<div style="display:flex;gap:16px;align-items:center;padding:16px;background:${bg}">${STATES.map((s) => SIZES.map((z) => `<img src="data:image/svg+xml;base64,${Buffer.from(svg(z, s)).toString('base64')}" width="${z}" height="${z}">`).join('')).join('<span style="width:16px"></span>')}</div>`;
// Toolbar sizes again at 6x with hard pixels, to judge crispness.
const zoom = (bg: string) =>
	`<div style="display:flex;gap:24px;align-items:center;padding:16px;background:${bg}">${STATES.map((s) => [16, 32].map((z) => `<img src="data:image/png;base64,${readFileSync(new URL(`${s}-${z}.png`, out)).toString('base64')}" style="width:${z * 6}px;height:${z * 6}px;image-rendering:pixelated">`).join('')).join('')}</div>`;
await page.setViewportSize({ width: 1500, height: 600 });
await page.setContent(`<body style="margin:0">${sheet('#f1f3f4')}${sheet('#35363a')}${sheet('#202124')}${zoom('#f1f3f4')}${zoom('#202124')}</body>`);
writeFileSync(new URL('../screenshots/toolbar-icons.png', import.meta.url), await page.screenshot({ fullPage: true }));
await browser.close();
console.log('icons written');
