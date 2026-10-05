// Where Colander installs from. Chrome, Brave and Opera install from the Chrome Web Store, and so
// does Edge until its own listing is live; Edge and Firefox get their own stores once their build
// variables are set (src/env.ts). Pages prerender the Chrome Web Store, so they work without
// JavaScript and a wrong guess costs nothing, then switch to this browser's store once they run.
import { PUBLIC_STORE_CHROME, PUBLIC_STORE_EDGE, PUBLIC_STORE_FIREFOX } from '$app/env/public';
import { fmtList } from '@colander/shared/format';

export interface Store {
	/** The browser the label names. */
	name: string;
	/** The store, for "Also in Edge Add-ons". */
	store: string;
	href: string;
	label: string;
	/** One line under the button, when the browser needs a step first. */
	hint?: string;
}

const CHROME: Store = { name: 'Chrome', store: 'the Chrome Web Store', href: PUBLIC_STORE_CHROME, label: 'Add to Chrome' };
const EDGE: Store | null = PUBLIC_STORE_EDGE ? { name: 'Edge', store: 'Edge Add-ons', href: PUBLIC_STORE_EDGE, label: 'Add to Edge' } : null;
const FIREFOX: Store | null = PUBLIC_STORE_FIREFOX ? { name: 'Firefox', store: 'Firefox Add-ons', href: PUBLIC_STORE_FIREFOX, label: 'Add to Firefox' } : null;

/** Every store with a live listing, in the order the site names them. */
export const STORES: Store[] = [CHROME, FIREFOX, EDGE].filter((s): s is Store => s !== null);

/** The desktop browsers Colander runs in, for copy: "Chrome, Edge, Brave and Opera". */
export const BROWSERS = fmtList(['Chrome', ...(FIREFOX ? ['Firefox'] : []), 'Edge', 'Brave', 'Opera']);

/** The store for a browser's user agent; any other browser gets the Chrome Web Store. */
export function storeFor(ua: string): Store {
	if (EDGE && /\bEdg\//.test(ua)) return EDGE;
	if (FIREFOX && /\bFirefox\//.test(ua)) return FIREFOX;
	if (/\bOPR\//.test(ua)) return { ...CHROME, name: 'Opera', label: 'Add to Opera', hint: "In Opera, add Opera's Install Chrome Extensions first." };
	return CHROME;
}

/** This browser's store, once the page runs (the root layout calls detectStore). */
export const install = $state<{ store: Store }>({ store: CHROME });

export function detectStore(): void {
	install.store = storeFor(navigator.userAgent);
}
