// Toolbar icon, badge and tooltip: active (the filled mark and a count), paused (the outlined
// mark, no count), and the attention dot for a report verdict or a list that could not update.
// Colors come from the shared TOOLBAR palette; the tooltip names the state in words.
import { TOOLBAR } from '@colander/shared/glyphs';
import { needsAttention, type Status } from '../lib/settings';
import { browser } from 'wxt/browser';

type State = 'active' | 'paused';
export type PauseScope = 'site' | 'tab' | null;

const path = (state: State, dot: boolean) => {
	const name = `${state}${dot ? '-dot' : ''}`;
	return { 16: `/icons/${name}-16.png`, 32: `/icons/${name}-32.png` };
};

/** Why the attention dot shows, in words for the tooltip. */
function attention(status: Status): string | null {
	if (!needsAttention(status)) return null;
	return status.reportsUpdated ? 'a report you sent has a verdict' : 'the list could not update';
}

export async function setGlobalIcon(status: Status): Promise<void> {
	await browser.action.setIcon({ path: path('active', needsAttention(status)) });
	await browser.action.setBadgeBackgroundColor({ color: TOOLBAR.badge });
	await browser.action.setBadgeTextColor?.({ color: TOOLBAR.badgeText });
	const why = attention(status);
	await browser.action.setTitle({ title: why ? `Colander, ${why}` : 'Colander' });
}

export async function setTabIcon(tabId: number, paused: PauseScope, status: Status, count: number | null): Promise<void> {
	try {
		await browser.action.setIcon({ tabId, path: path(paused ? 'paused' : 'active', needsAttention(status)) });
		if (count !== null) await browser.action.setBadgeText({ tabId, text: paused || count === 0 ? '' : count > 999 ? '999+' : String(count) });
		const why = attention(status);
		const title = paused ? `Colander, paused on this ${paused}` : why ? `Colander, ${why}` : count ? `Colander, ${count} hidden on this page` : 'Colander';
		await browser.action.setTitle({ tabId, title });
	} catch {
		// The tab closed while we were updating it.
	}
}
