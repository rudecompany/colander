// The demo feed thumbnails as bundled assets. Both apps resolve these through Vite, so they ship
// with the website and with the extension's own pages; content scripts never render the demo.
import type { ThumbScene } from '../copy';
import bread from '../assets/demo/bread.webp';
import coins from '../assets/demo/coins.webp';
import gears from '../assets/demo/gears.webp';
import kettle from '../assets/demo/kettle.webp';
import kite from '../assets/demo/kite.webp';
import templateA from '../assets/demo/template-a.webp';
import templateB from '../assets/demo/template-b.webp';
import tidePool from '../assets/demo/tide-pool.webp';

export const THUMB_IMAGES: Record<ThumbScene, string> = {
	gears,
	'template-a': templateA,
	'tide-pool': tidePool,
	bread,
	'template-b': templateB,
	kite,
	coins,
	kettle
};
