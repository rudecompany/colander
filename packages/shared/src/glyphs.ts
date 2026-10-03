// Verdict glyphs and the Colander mark, redrawn from docs/img/generate.js on a 48-unit grid
// centred on the origin (viewBox -24 -24 48 48). Each glyph differs in outline so it reads
// without color. Strokes are 4 units so they stay at least 1 px wide at the 12 px chip size.
import type { Verdict } from './verdicts';

export const GLYPH_VIEWBOX = '-24 -24 48 48';
export const MARK_VIEWBOX = '-26 -26 52 52';
/** Tighter crop for the 16 px simplification so it fills small toolbar icons. */
export const MARK_SMALL_VIEWBOX = '-22 -22.5 44 44';

type Shape = { d: string; fill?: boolean; stroke?: boolean; evenodd?: boolean };

const DROP = 'M0 -21C4 -13 14 -5 14 7A14 14 0 0 1 -14 7C-14 -5 -4 -13 0 -21Z';
const hole = (x: number, y: number, r = 2) =>
	`M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;

export const GLYPHS: Record<Verdict, Shape[]> = {
	// A solid drop: the thing being drained.
	slop: [{ d: DROP, fill: true }],
	// The same drop, lower part filled: half certain.
	likely_slop: [
		{ d: 'M-14 7A14 14 0 0 0 14 7Z', fill: true },
		{ d: DROP, stroke: true }
	],
	// A four-point sparkle with a small companion: the mark people already read as AI.
	ai_made: [
		{ d: 'M-3 -17Q0.5 -0.5 17 3Q0.5 6.5 -3 23Q-6.5 6.5 -23 3Q-6.5 -0.5 -3 -17Z', fill: true },
		{ d: 'M16 -22Q17.2 -16.2 23 -15Q17.2 -13.8 16 -8Q14.8 -13.8 9 -15Q14.8 -16.2 16 -22Z', fill: true }
	],
	// A diamond split down the middle: two sides.
	disputed: [
		{ d: 'M-3 -19L-22 0L-3 19Z', fill: true },
		{ d: 'M3 -19L21 0L3 19Z', stroke: true }
	],
	// A solid circle with a check cut out: settled and fine.
	clear: [
		{
			d: 'M-20 0a20 20 0 1 0 40 0a20 20 0 1 0 -40 0ZM-7.16 -0.84L-3.07 3.25L8.1 -8.77L11.91 -5.23L-2.93 10.75L-10.84 2.84Z',
			fill: true,
			evenodd: true
		}
	]
};

/** The full mark: a colander from the side. Rim with two handles, bowl, three rows of holes, foot. */
export const MARK: Shape[] = [
	{ d: 'M-22.5 -14h45a2.5 2.5 0 0 1 0 5h-45a2.5 2.5 0 0 1 0 -5Z', fill: true },
	{
		d:
			'M-19 -9A19 19 0 0 0 19 -9Z' +
			hole(-9, -3) +
			hole(0, -3) +
			hole(9, -3) +
			hole(-5, 3) +
			hole(5, 3) +
			hole(0, 7),
		fill: true,
		evenodd: true
	},
	{ d: 'M-6.5 9.5h13a1.5 1.5 0 0 1 1.5 1.5v1.5a1.5 1.5 0 0 1 -1.5 1.5h-13a1.5 1.5 0 0 1 -1.5 -1.5v-1.5a1.5 1.5 0 0 1 1.5 -1.5Z', fill: true }
];

/** The 16 px simplification: the bowl and three holes. */
export const MARK_SMALL: Shape[] = [
	{ d: 'M-21 -16h42a3.5 3.5 0 0 1 0 7h-42a3.5 3.5 0 0 1 0 -7Z', fill: true },
	{
		d: 'M-19 -9A19 24 0 0 0 19 -9Z' + hole(-8.5, 0, 3.6) + hole(0, 0, 3.6) + hole(8.5, 0, 3.6),
		fill: true,
		evenodd: true
	}
];

function shapesToSvg(shapes: Shape[], strokeWidth: number): string {
	return shapes
		.map((s) => {
			const rule = s.evenodd ? ' fill-rule="evenodd"' : '';
			return s.stroke
				? `<path d="${s.d}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`
				: `<path d="${s.d}" fill="currentColor"${rule}/>`;
		})
		.join('');
}

/** Inline SVG markup for a verdict glyph, colored by currentColor. Decorative: the verdict word always sits beside it. */
export function glyphSvg(verdict: Verdict, size = 12): string {
	return `<svg viewBox="${GLYPH_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${shapesToSvg(GLYPHS[verdict], 4)}</svg>`;
}

/** Inline SVG markup for the mark. `outline` draws the paused state; `small` uses the 16 px simplification. */
export function markSvg(size = 24, opts: { outline?: boolean; small?: boolean } = {}): string {
	const shapes = (opts.small ? MARK_SMALL : MARK).map((s) => (opts.outline ? { ...s, fill: false, stroke: true } : s));
	return `<svg viewBox="${opts.small ? MARK_SMALL_VIEWBOX : MARK_VIEWBOX}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${shapesToSvg(shapes, 3)}</svg>`;
}

export { shapesToSvg as _shapesToSvg };
export type { Shape as GlyphShape };
