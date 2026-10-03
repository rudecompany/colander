import { PLATFORMS, type Platform } from '@colander/shared';
import type { LogEntry } from '@colander/shared/api';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const numFmt = new Intl.NumberFormat('en-US');

/** "3 October 2026" */
export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));
/** "3 Oct 2026, 14:05 UTC" */
export const fmtDateTime = (iso: string) => `${shortFmt.format(new Date(iso))}, ${timeFmt.format(new Date(iso))} UTC`;
/** "October 2026" */
export const fmtMonth = (iso: string) => monthFmt.format(new Date(iso));
export const fmtNum = (n: number) => numFmt.format(n);
export const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
export const fmtMoney = (cents: number) => `$${numFmt.format(cents / 100)}`;
export const plural = (n: number, one: string, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;

export const isPlatform = (p: string): p is Platform => (PLATFORMS as string[]).includes(p);

/** Path to the public source page. Keeps a leading @ readable. */
export const sourcePath = (platform: Platform, id: string) =>
	`/s/${platform}/${encodeURIComponent(id).replace(/^%40/, '@')}`;
export const appealPath = (platform: Platform, id: string) =>
	`/appeal/${platform}/${encodeURIComponent(id).replace(/^%40/, '@')}`;

/** The source's own page on its platform (canonical IDs per contracts section 2.2). */
export function platformSourceUrl(platform: Platform, id: string): string {
	const e = encodeURIComponent;
	switch (platform) {
		case 'yt':
			return id.startsWith('@') ? `https://www.youtube.com/${e(id).replace(/^%40/, '@')}` : `https://www.youtube.com/channel/${e(id)}`;
		case 'tt':
			return `https://www.tiktok.com/${id.startsWith('@') ? '@' + e(id.slice(1)) : '@' + e(id)}`;
		case 'ig':
			return `https://www.instagram.com/${e(id)}/`;
		case 'fb':
			return /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : `https://www.facebook.com/${e(id)}`;
	}
}

/** An item's page on its platform. TikTok needs the source to build the address. */
export function platformItemUrl(platform: Platform, itemId: string, sourceId: string): string {
	const e = encodeURIComponent;
	switch (platform) {
		case 'yt':
			return `https://www.youtube.com/watch?v=${e(itemId)}`;
		case 'tt':
			return `${platformSourceUrl('tt', sourceId)}/video/${e(itemId)}`;
		case 'ig':
			return `https://www.instagram.com/p/${e(itemId)}/`;
		case 'fb':
			return `https://www.facebook.com/${e(itemId)}`;
	}
}

/** "Decided by staff member Sam", "Decided by community scoring", "Changed by a verified appeal". */
export function actorText(entry: Pick<LogEntry, 'actor' | 'actor_name'>): string {
	switch (entry.actor) {
		case 'community':
			return 'Decided by community scoring';
		case 'appeal':
			return 'Changed by a verified appeal';
		case 'curator':
			return entry.actor_name ? `Decided by curator ${entry.actor_name}` : 'Decided by a curator';
		case 'staff':
			return entry.actor_name ? `Decided by staff member ${entry.actor_name}` : 'Decided by staff';
	}
}

/** Only same-origin paths are allowed as a post sign-in destination. */
export function safeNext(next: string | null | undefined, fallback = '/account'): string {
	return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : fallback;
}
