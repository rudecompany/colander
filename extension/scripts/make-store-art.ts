// Captures the Chrome Web Store listing art from the real UI: the storeart page of the end-to-end
// build renders the shipped components from demo values, and this writes store/*.png.
// Usage: pnpm -C extension store-art   (builds the end-to-end variant first)
//
// Output: five 1280x800 screenshots (the fifth in dark), the 440x280 promo tile, the 1400x560
// marquee and the 128x128 store icon. Every file is a 24-bit PNG without alpha, under 1 MB.
import { chromium } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(ROOT, 'dist/chrome-mv3-e2e');
const OUT = resolve(ROOT, 'store');
const EXT_ID = 'nninnogmbhfebflkcgghlmjmplmpodlc';

const FRAMES: { name: string; frame: string; width: number; height: number; dark?: boolean }[] = [
	{ name: 'screenshot-1', frame: '1', width: 1280, height: 800 },
	{ name: 'screenshot-2', frame: '2', width: 1280, height: 800 },
	{ name: 'screenshot-3', frame: '3', width: 1280, height: 800 },
	{ name: 'screenshot-4', frame: '4', width: 1280, height: 800 },
	{ name: 'screenshot-5', frame: '5', width: 1280, height: 800, dark: true },
	{ name: 'promo-tile-440x280', frame: 'tile', width: 440, height: 280 },
	{ name: 'marquee-1400x560', frame: 'marquee', width: 1400, height: 560 }
];

/** IHDR: width, height, bit depth and color type (2 is truecolor without alpha). */
function header(png: Buffer) {
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24], color: png[25] };
}

mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext('', {
	channel: 'chromium',
	headless: true,
	reducedMotion: 'reduce',
	deviceScaleFactor: 1,
	args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--host-resolver-rules=MAP * ~NOTFOUND']
});
const failures: string[] = [];
try {
	const page = await ctx.newPage();
	for (const f of FRAMES) {
		await page.emulateMedia({ colorScheme: f.dark ? 'dark' : 'light', reducedMotion: 'reduce' });
		await page.setViewportSize({ width: f.width, height: f.height });
		await page.goto(`chrome-extension://${EXT_ID}/storeart.html?frame=${f.frame}`);
		// Fonts and the demo thumbnails come from the extension itself.
		await page.waitForLoadState('networkidle');
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(300);
		// Opaque screenshots are truecolor PNGs: no alpha channel to flatten.
		const png = await page.screenshot({ type: 'png', animations: 'disabled', clip: { x: 0, y: 0, width: f.width, height: f.height } });
		const h = header(png);
		if (h.width !== f.width || h.height !== f.height) failures.push(`${f.name}: ${h.width}x${h.height}, expected ${f.width}x${f.height}`);
		if (h.color !== 2 || h.depth !== 8) failures.push(`${f.name}: not a 24-bit PNG without alpha (color type ${h.color}, depth ${h.depth})`);
		if (png.length > 1_000_000) failures.push(`${f.name}: ${png.length} bytes, over 1 MB`);
		writeFileSync(resolve(OUT, `${f.name}.png`), png);
		console.log(`${f.name}.png ${f.width}x${f.height} ${(png.length / 1024).toFixed(0)} KB`);
	}
} finally {
	await ctx.close();
}

// The store icon is the manifest's 128 px icon: 96 px of artwork inside 16 px of padding.
copyFileSync(resolve(ROOT, 'public/icons/active-128.png'), resolve(OUT, 'icon-128.png'));
const icon = header(readFileSync(resolve(OUT, 'icon-128.png')));
if (icon.width !== 128 || icon.height !== 128) failures.push(`icon-128: ${icon.width}x${icon.height}`);
console.log(`icon-128.png ${statSync(resolve(OUT, 'icon-128.png')).size} bytes`);

if (failures.length) {
	console.error(failures.join('\n'));
	process.exit(1);
}
