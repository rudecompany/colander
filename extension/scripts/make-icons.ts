// Renders the toolbar and store icons from the brand geometry in packages/shared/src/glyphs.ts.
// Usage: node scripts/make-icons.ts   (writes public/icons/*.png and screenshots/toolbar-icons.png)
//
// Active is the filled mark in the mark color with its holes knocked out, no tile and no halo.
// Paused is the outlined mark in the paused gray, with pause bars in place of the holes from 32 px;
// at 16 px it is drawn on whole pixels so no edge is a faint half-alpha pixel.
// Attention adds a paper dot with an ink ring at the top right, set off by a 1 px knockout.
// 16 and 32 px are drawn on the pixel grid from MARK_SMALL's proportions: a rim, the bowl and
// 3 holes of 2 by 2 px at 16, two rows of holes at 32. 48 and 128 use the full MARK, and 128 is the
// store icon: 96 px of artwork inside 16 px of transparent padding.
//
// It fails unless the mark keeps 3:1 against six Chrome toolbar colors and active and paused
// differ by more than 30% in filled pixels, so the states never rely on color alone.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { markShapes, MARK_VIEWBOX, TOOLBAR, _shapesToSvg } from '../../packages/shared/src/glyphs.ts';

const SIZES = [16, 32, 48, 128] as const;
const STATES = ['active', 'paused', 'active-dot', 'paused-dot'] as const;
type State = (typeof STATES)[number];
/** Chrome toolbar colors: light, light incognito-ish gray, and four dark themes. */
const TOOLBARS = ['#FFFFFF', '#F1F3F4', '#202124', '#282828', '#35363A', '#3C3C3C'];

/** The attention dot's diameter per size. */
const DOT: Record<number, number> = { 16: 5, 32: 8, 48: 12, 128: 24 };

/** Pixel-grid drawings for the toolbar sizes, in px. */
function small(size: 16 | 32, paused: boolean): string {
	const k = size / 16;
	const c = paused ? TOOLBAR.paused : TOOLBAR.mark;
	if (!paused) {
		const holes =
			size === 16
				? [[4, 7], [7, 7], [10, 7]].map(([x, y]) => `M${x} ${y}h2v2h-2Z`)
				: [[8.5, 12.5], [14.5, 12.5], [20.5, 12.5], [11.5, 17.5], [17.5, 17.5]].map(([x, y]) => `M${x} ${y}h3v3h-3Z`);
		// Rim and bowl as one filled shape, holes cut out with even-odd.
		const rim = `M${2 * k} ${3 * k}H${14 * k}A${k} ${k} 0 0 1 ${14 * k} ${5 * k}H${2 * k}A${k} ${k} 0 0 1 ${2 * k} ${3 * k}Z`;
		const bowl = `M${2 * k} ${5 * k}H${14 * k}A${6 * k} ${7 * k} 0 0 1 ${2 * k} ${5 * k}Z`;
		return `<path d="${rim}" fill="${c}"/><path d="${bowl}${holes.join('')}" fill="${c}" fill-rule="evenodd"/>`;
	}
	// Paused at 16: whole pixels only, so every outline pixel is the full paused gray (anti-aliased
	// 1.5 px walls fall below 3:1 on light toolbars): the 2 px rim over a hollow bowl of 1 px walls.
	if (size === 16) {
		const px = [
			[1, 3, 14, 2], // rim
			[2, 5, 1, 2], [13, 5, 1, 2], // walls, stepping in toward the floor
			[3, 7, 1, 2], [12, 7, 1, 2],
			[4, 9, 1, 1], [11, 9, 1, 1],
			[5, 10, 1, 1], [10, 10, 1, 1],
			[6, 11, 4, 1] // floor
		];
		return `<path d="${px.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w!}Z`).join('')}" fill="${c}" shape-rendering="crispEdges"/>`;
	}
	// Paused from 32: the rim as one line and the bowl as an open arc, so it reads lighter than
	// active by shape as well as color, with two pause bars.
	const w = 2;
	const rim = `M${1.75 * k} 8H${14.25 * k}`;
	const bowl = `M${2.75 * k} ${5.5 * k}A${5.25 * k} ${6.5 * k} 0 0 0 ${13.25 * k} ${5.5 * k}`;
	const bars = `<path d="M12 12h3v8h-3ZM17 12h3v8h-3Z" fill="${c}"/>`;
	return `<g fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"><path d="${rim}"/><path d="${bowl}"/></g>${bars}`;
}

/** The full mark for 48 and 128, from glyphs.ts. 128 keeps 16 px of padding around 96 px of artwork. */
function large(size: 48 | 128, paused: boolean): { body: string; viewBox: string } {
	const m = markShapes(size === 128 ? 96 : size, { outline: paused });
	const color = paused ? TOOLBAR.paused : TOOLBAR.mark;
	const [x, y, w] = (paused ? MARK_VIEWBOX : m.viewBox).split(' ').map(Number) as [number, number, number];
	const pad = size === 128 ? (16 * w) / 96 : 0;
	return {
		body: `<g style="color:${color}">${_shapesToSvg(m.shapes, m.strokeWidth)}</g>`,
		viewBox: `${x - pad} ${y - pad} ${w + 2 * pad} ${w + 2 * pad}`
	};
}

function svg(size: (typeof SIZES)[number], state: State): string {
	const paused = state.startsWith('paused');
	let body: string;
	let viewBox: string;
	if (size === 16 || size === 32) {
		body = small(size, paused);
		viewBox = `0 0 ${size} ${size}`;
	} else ({ body, viewBox } = large(size, paused));
	if (!state.endsWith('dot')) return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
	// The dot sits at the top right in pixel space, over the artwork, with a 1 px transparent ring around it.
	const d = DOT[size]!;
	const inset = size === 128 ? 16 : 0;
	const cx = size - inset - d / 2;
	const cy = inset + d / 2;
	const art = `<svg x="0" y="0" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
		`<mask id="k"><rect width="${size}" height="${size}" fill="white"/><circle cx="${cx}" cy="${cy}" r="${d / 2 + 1}" fill="black"/></mask>` +
		`<g mask="url(#k)">${art}</g>` +
		`<circle cx="${cx}" cy="${cy}" r="${d / 2 - 0.5}" fill="${TOOLBAR.dot}" stroke="${TOOLBAR.ring}" stroke-width="1"/>` +
		`</svg>`
	);
}

const lum = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x! + 0.05) / (y! + 0.05);
};

const failures: string[] = [];
for (const bg of TOOLBARS) {
	for (const [name, color] of [['mark', TOOLBAR.mark], ['paused', TOOLBAR.paused]] as const) {
		const r = ratio(color, bg);
		if (r < 3) failures.push(`${name} ${color} on ${bg}: ${r.toFixed(2)}:1, below 3:1`);
	}
}

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const png: Record<string, Buffer> = {};
for (const state of STATES) {
	for (const size of SIZES) {
		await page.setContent(`<body style="margin:0;background:transparent">${svg(size, state)}</body>`);
		png[`${state}-${size}`] = await page.locator('svg').first().screenshot({ omitBackground: true });
		writeFileSync(new URL(`${state}-${size}.png`, out), png[`${state}-${size}`]!);
	}
}

// Active and paused must differ in shape, not only color: compare filled pixels at each size.
for (const size of SIZES) {
	const filled = await page.evaluate(
		async (srcs) =>
			Promise.all(
				srcs.map(async (src) => {
					const img = new Image();
					img.src = src;
					await img.decode();
					const c = new OffscreenCanvas(img.width, img.height);
					const ctx = c.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					const d = ctx.getImageData(0, 0, img.width, img.height).data;
					let n = 0;
					for (let i = 3; i < d.length; i += 4) if (d[i]! > 127) n++;
					return n;
				})
			),
		['active', 'paused'].map((s) => `data:image/png;base64,${png[`${s}-${size}`]!.toString('base64')}`)
	);
	const [a, p] = filled as [number, number];
	const diff = Math.abs(a - p) / Math.max(a, p);
	if (diff <= 0.3) failures.push(`active and paused at ${size} px differ by ${(diff * 100).toFixed(0)}% in filled pixels, 30% needed`);
	console.log(`${size} px: active ${a} filled pixels, paused ${p}, ${(diff * 100).toFixed(0)}% apart`);
}

// Contrast is judged on opaque pixels: at 16 px every paused pixel is either clear or the full
// paused gray, so no anti-aliased edge falls below 3:1 on a toolbar. (The attention variant shares
// the geometry; its round dot is anti-aliased on purpose.)
const partial = await page.evaluate(async (src) => {
	const img = new Image();
	img.src = src;
	await img.decode();
	const c = new OffscreenCanvas(img.width, img.height);
	const ctx = c.getContext('2d')!;
	ctx.drawImage(img, 0, 0);
	const d = ctx.getImageData(0, 0, img.width, img.height).data;
	let n = 0;
	for (let i = 3; i < d.length; i += 4) if (d[i]! > 0 && d[i]! < 255) n++;
	return n;
}, `data:image/png;base64,${png['paused-16']!.toString('base64')}`);
if (partial) failures.push(`paused at 16 px has ${partial} partly transparent pixels; draw it on whole pixels`);

// The contact sheet: every state and size on the six toolbars, then the toolbar sizes at 8x.
const tag = (state: State, size: number, scale = 1) =>
	`<img src="data:image/png;base64,${png[`${state}-${size}`]!.toString('base64')}" width="${size * scale}" height="${size * scale}" style="image-rendering:pixelated">`;
const row = (bg: string) =>
	`<div style="display:flex;gap:20px;align-items:center;padding:12px 16px;background:${bg};font:12px system-ui;color:${lum(bg) > 0.5 ? TOOLBAR.ring : TOOLBAR.dot}"><span style="width:64px">${bg}</span>${STATES.map((s) => SIZES.map((z) => tag(s, z)).join('')).join('<span style="width:12px"></span>')}</div>`;
const zoom = (bg: string) =>
	`<div style="display:flex;gap:24px;align-items:center;padding:16px;background:${bg}">${STATES.map((s) => [16, 32].map((z) => tag(s, z, z === 16 ? 8 : 4)).join('')).join('')}</div>`;
await page.setViewportSize({ width: 1380, height: 600 });
await page.setContent(`<body style="margin:0;width:max-content">${TOOLBARS.map(row).join('')}${zoom('#F1F3F4')}${zoom('#202124')}</body>`);
mkdirSync(new URL('../screenshots/', import.meta.url), { recursive: true });
writeFileSync(new URL('../screenshots/toolbar-icons.png', import.meta.url), await page.screenshot({ fullPage: true }));
await browser.close();

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}
console.log('icons written');
