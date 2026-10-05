// Reactive views of chrome.storage.local for extension pages. Dates and numbers are formatted
// by @colander/shared/format, like every other surface.
import type { ToWorker } from '../lib/messages';

export function stored<T>(key: string, fallback: T): { value: T; ready: boolean } {
	const s = $state({ value: fallback, ready: false });
	void chrome.storage.local.get(key).then((r) => {
		s.value = (r[key] as T | undefined) ?? fallback;
		s.ready = true;
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && changes[key]) s.value = (changes[key].newValue as T | undefined) ?? fallback;
	});
	return s;
}

export function send<T = { ok: boolean; error?: string }>(m: ToWorker): Promise<T> {
	return chrome.runtime.sendMessage(m) as Promise<T>;
}
