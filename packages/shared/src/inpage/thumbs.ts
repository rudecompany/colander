// Thumbnail scenes for the demo feed, as data, so the Svelte Thumb and the in-page builder draw
// the same pictures. Neutral tones only, at most 6 primitives in 2 tones each. Slop is one
// template repeated with a changing part number: mass production, shown honestly.
import type { ThumbScene } from '../copy';

/** Tone 1 to 4 from the thumbnail palette, or `d` for the detail color. */
export type Tone = 1 | 2 | 3 | 4 | 'd';
export type Prim =
	| { rect: [x: number, y: number, w: number, h: number]; tone: Tone }
	| { circle: [cx: number, cy: number, r: number]; tone: Tone }
	| { path: string; tone: Tone; stroke?: number }
	| { numeral: true; x: number; y: number; size: number; tone: Tone };

/** viewBox 0 0 160 90. The first entry is the background tone. */
export const THUMB_SCENES: Record<ThumbScene, { bg: Tone; prims: Prim[] }> = {
	gears: {
		bg: 1,
		prims: [
			{ rect: [0, 70, 160, 20], tone: 3 },
			{ circle: [58, 44, 20], tone: 3 },
			{ circle: [58, 44, 7], tone: 1 },
			{ circle: [104, 40, 13], tone: 3 },
			{ circle: [104, 40, 4.5], tone: 1 }
		]
	},
	'template-a': {
		bg: 2,
		prims: [
			{ path: 'M10 26L36 10L62 26Z', tone: 4 },
			{ rect: [17, 28, 8, 40], tone: 4 },
			{ rect: [32, 28, 8, 40], tone: 4 },
			{ rect: [47, 28, 8, 40], tone: 4 },
			{ numeral: true, x: 72, y: 60, size: 24, tone: 'd' }
		]
	},
	'tide-pool': {
		bg: 3,
		prims: [
			{ circle: [126, 24, 9], tone: 4 },
			{ path: 'M0 54q20-8 40 0t40 0t40 0t40 0V90H0Z', tone: 4 },
			{ circle: [44, 70, 10], tone: 3 },
			{ circle: [104, 74, 13], tone: 3 }
		]
	},
	bread: {
		bg: 1,
		prims: [
			{ path: 'M30 62a50 26 0 0 1 100 0Z', tone: 4 },
			{ path: 'M58 50l12-12M76 50l12-12M94 50l12-12', tone: 1, stroke: 4 },
			{ rect: [20, 64, 120, 8], tone: 4 }
		]
	},
	'template-b': {
		bg: 3,
		prims: [
			{ circle: [44, 45, 24], tone: 4 },
			{ circle: [54, 37, 20], tone: 3 },
			{ numeral: true, x: 86, y: 62, size: 36, tone: 'd' }
		]
	},
	kite: {
		bg: 3,
		prims: [
			{ path: 'M80 10L104 38L80 70L56 38Z', tone: 1 },
			{ path: 'M80 10V70M56 38H104', tone: 3, stroke: 2 },
			{ path: 'M80 70q-12 8 -4 20', tone: 1, stroke: 2 }
		]
	},
	coins: {
		bg: 1,
		prims: [
			{ circle: [58, 50, 18], tone: 4 },
			{ circle: [90, 42, 18], tone: 4 },
			{ circle: [90, 42, 11], tone: 1 },
			{ rect: [110, 60, 36, 8], tone: 4 },
			{ rect: [114, 50, 32, 8], tone: 4 }
		]
	},
	kettle: {
		bg: 2,
		prims: [
			{ path: 'M50 74h58l-6-32a23 23 0 0 0 -46 0Z', tone: 4 },
			{ path: 'M104 54l18-12', tone: 4, stroke: 6 },
			{ rect: [69, 14, 20, 6], tone: 4 },
			{ circle: [132, 72, 10], tone: 1 }
		]
	}
};

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
