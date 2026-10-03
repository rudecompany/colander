// Registers the prerender document for the in-page builders before any page renders, and preloads
// the one font file every page needs: Atkinson Hyperlegible Next, latin, variable weight. The
// latin-ext file loads only when a page uses its characters (unicode-range).
import type { Handle } from '@sveltejs/kit/hooks';
import '#lib/server/inpage.ts';

export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		preload: ({ type, path }) => type === 'js' || type === 'css' || (type === 'font' && /latin-wght/.test(path))
	});
