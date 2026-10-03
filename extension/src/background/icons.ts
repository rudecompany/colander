// Toolbar icon and badge: active (filled mark and count), paused (outlined mark at half
// strength), and the attention dot for a sync failure or a report verdict update.
import { needsAttention, type Status } from '../lib/settings';

type State = 'active' | 'paused';

const path = (state: State, dot: boolean) => {
	const name = `${state}${dot ? '-dot' : ''}`;
	return { 16: `/icons/${name}-16.png`, 32: `/icons/${name}-32.png` };
};

export async function setGlobalIcon(status: Status): Promise<void> {
	await chrome.action.setIcon({ path: path('active', needsAttention(status)) });
	await chrome.action.setBadgeBackgroundColor({ color: '#1F4E8C' });
	await chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
}

export async function setTabIcon(tabId: number, paused: boolean, status: Status, count: number | null): Promise<void> {
	try {
		await chrome.action.setIcon({ tabId, path: path(paused ? 'paused' : 'active', needsAttention(status)) });
		if (count !== null) await chrome.action.setBadgeText({ tabId, text: paused || count === 0 ? '' : count > 999 ? '999+' : String(count) });
		await chrome.action.setTitle({
			tabId,
			title: paused ? 'Colander: paused' : count ? `Colander: ${count} hidden on this page` : 'Colander'
		});
	} catch {
		// The tab closed while we were updating it.
	}
}
