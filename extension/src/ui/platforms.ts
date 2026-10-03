// Switching platforms on and off from extension pages. Chrome only shows its site access
// prompt for a permission request made directly in a click handler, so request first.
import type { Platform } from '@colander/shared/verdicts';
import { ORIGINS } from '../lib/platforms';
import { send } from './store.svelte';

export async function enablePlatforms(ps: Platform[]): Promise<boolean> {
	if (!ps.length) return true;
	const granted = await chrome.permissions.request({ origins: ps.flatMap((p) => ORIGINS[p]) });
	if (!granted) return false;
	for (const p of ps) await send({ type: 'set-platform', platform: p, on: true });
	return true;
}

export async function disablePlatform(p: Platform): Promise<void> {
	await send({ type: 'set-platform', platform: p, on: false });
	// Builds that hold the permission permanently (end-to-end tests) cannot drop it; that is fine.
	await chrome.permissions.remove({ origins: ORIGINS[p] }).catch(() => false);
}

export async function granted(p: Platform): Promise<boolean> {
	return chrome.permissions.contains({ origins: ORIGINS[p] });
}
