// Reactive views of chrome.storage.local for extension pages.
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

/** "3 minutes ago", "yesterday", in plain words. */
export function ago(t: number | null | undefined, now = Date.now()): string {
	if (!t) return 'never';
	const s = Math.round((now - t) / 1000);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	if (s < 45) return 'just now';
	if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
	if (s < 86_400) return rtf.format(-Math.round(s / 3600), 'hour');
	return rtf.format(-Math.round(s / 86_400), 'day');
}

export function fmtDate(t: number | string | null | undefined): string {
	if (!t) return '';
	return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtNum(n: number): string {
	return n.toLocaleString();
}
