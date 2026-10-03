// Thumbnail scenes for the demo feed, as data, so the Svelte Thumb and the in-page builder draw
// the same pictures. Each scene is an illustration made with the mcp-image generator and checked
// for no lettering, faces, people or brands (src/assets/demo, 512x288 WebP, about 100 KB for all
// eight). Slop is one template image repeated with only a large numeral changing, drawn in code:
// mass production, shown honestly. The background tone shows while an image loads.
import type { ThumbScene } from '../copy';
import { THUMB_IMAGES } from './thumb-images';

/** Tone 1 to 4 from the thumbnail palette, or `d` for the detail color. */
export type Tone = 1 | 2 | 3 | 4 | 'd';

/** One line of the large numeral on a template thumbnail, in the 160 by 90 viewBox. `{n}` is the part number. */
export interface NumeralLine {
	text: string;
	x: number;
	y: number;
	size: number;
	/** Illustration colors picked for the reserved area of each image, not theme tokens. */
	fill: string;
	halo: string;
}

export const THUMB_SCENES: Record<ThumbScene, { bg: Tone; image: string; numeral?: NumeralLine[] }> = {
	gears: { bg: 1, image: THUMB_IMAGES.gears },
	// The right 40 percent of the Rome image is calm sky, kept clear for the part number.
	'template-a': {
		bg: 2,
		image: THUMB_IMAGES['template-a'],
		numeral: [
			{ text: 'Part', x: 129, y: 36, size: 12, fill: '#1a1c1f', halo: '#f2f0eb' },
			{ text: '{n}', x: 129, y: 70, size: 36, fill: '#1a1c1f', halo: '#f2f0eb' }
		]
	},
	'tide-pool': { bg: 3, image: THUMB_IMAGES['tide-pool'] },
	bread: { bg: 1, image: THUMB_IMAGES.bread },
	// The left 40 percent of the bedroom image is a calm dark wall, kept clear for the numeral.
	'template-b': {
		bg: 3,
		image: THUMB_IMAGES['template-b'],
		numeral: [{ text: '{n}', x: 33, y: 62, size: 38, fill: '#f2f0eb', halo: '#1a1c1f' }]
	},
	kite: { bg: 1, image: THUMB_IMAGES.kite },
	coins: { bg: 4, image: THUMB_IMAGES.coins },
	kettle: { bg: 2, image: THUMB_IMAGES.kettle }
};

/** The text of a numeral line for a part number. */
export const numeralText = (line: NumeralLine, part: number) => line.text.replace('{n}', String(part));

/** The thumbnail palette: illustration only, not theme tokens. Detail on tone 1 is 8.14:1 in light. */
export const THUMB_PALETTE = {
	light: { t1: '#e7e1d6', t2: '#d3cbbe', t3: '#c5cbd2', t4: '#a9afb6', td: '#3b3f45' },
	dark: { t1: '#2a2d31', t2: '#33373c', t3: '#3a4047', t4: '#4a5058', td: '#c9cdd2' }
} as const;

const vars = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';');

/** For shadow roots, which carry theme="light", "dark" or "auto". */
export const THUMB_CSS =
	`.cl-thumb{${vars(THUMB_PALETTE.light)}}` +
	`:host([theme='dark']) .cl-thumb{${vars(THUMB_PALETTE.dark)}}` +
	`@media (prefers-color-scheme:dark){:host([theme='auto']) .cl-thumb{${vars(THUMB_PALETTE.dark)}}}`;

/** For pages: light-dark() follows the page's color scheme, including inside the band. */
export const THUMB_STYLE = Object.keys(THUMB_PALETTE.light)
	.map((k) => {
		const key = k as keyof typeof THUMB_PALETTE.light;
		return `--${k}:light-dark(${THUMB_PALETTE.light[key]},${THUMB_PALETTE.dark[key]})`;
	})
	.join(';');

export const toneVar = (t: Tone) => `var(--t${t})`;
