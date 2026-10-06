// Reactive views of browser.storage.local for extension pages. Dates and numbers are formatted
// by @colander/shared/format, like every other surface.
import { ask } from '../lib/consent';
import type { ToWorker } from '../lib/messages';
import { browser } from 'wxt/browser';

export function stored<T>(key: string, fallback: T): { value: T; ready: boolean } {
	const s = $state({ value: fallback, ready: false });
	void browser.storage.local.get(key).then((r) => {
		s.value = (r[key] as T | undefined) ?? fallback;
		s.ready = true;
	});
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && changes[key]) s.value = (changes[key].newValue as T | undefined) ?? fallback;
	});
	return s;
}

export function send<T = { ok: boolean; error?: string }>(m: ToWorker): Promise<T> {
	return browser.runtime.sendMessage(m) as Promise<T>;
}

/**
 * Starts the 14-day trial from a click. A trial turns on settings sync with a plan token, so
 * Firefox asks first (lib/consent.ts), before any await, as its prompt needs the click.
 */
export async function startTrial(): Promise<{ ok: boolean; error?: string }> {
	const consent = ask(['authenticationInfo']);
	if (!(await consent)) return { ok: false, error: 'Firefox did not allow Colander to use a plan token, so the trial did not start. Choose it again to be asked again.' };
	return send<{ ok: boolean; error?: string }>({ type: 'start-trial' }).catch(() => ({ ok: false, error: 'Could not reach Colander.' }));
}
