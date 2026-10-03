// Every date, time, number and price format, for the website, the extension pages and the
// in-page UI. en-GB everywhere: "2 Oct 2026" in rows, chips and the popup, "2 October 2026"
// in prose, "14:02 UTC" for times. The only file allowed to use Intl.DateTimeFormat.
import type { LogEntry, Source } from '../api';
import { PLATFORMS, type Platform } from '../verdicts';

export type DateInput = string | number | Date;

const utc = { timeZone: 'UTC' } as const;
const longFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', ...utc });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...utc });
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...utc });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...utc });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', ...utc });
const monthShortFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', ...utc });
const numFmt = new Intl.NumberFormat('en-US');
const centsFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const d = (t: DateInput) => (t instanceof Date ? t : new Date(t));
/** en-GB short months are "Sept" in some engines; the spec spells it "Sep". */
const sep = (s: string) => s.replace('Sept', 'Sep');

/** "2 October 2026", for prose. */
export const fmtDate = (t: DateInput) => longFmt.format(d(t));
/** "2 Oct 2026", for rows, chips, the popup and in-page UI. */
export const fmtShortDate = (t: DateInput) => sep(shortFmt.format(d(t)));
/** "Thu 2 Oct 2026", for day headers. */
export const fmtDay = (t: DateInput) => sep(dayFmt.format(d(t)).replace(',', ''));
/** "14:02 UTC" */
export const fmtTime = (t: DateInput) => `${timeFmt.format(d(t))} UTC`;
/** "2 Oct 2026, 14:02 UTC" */
export const fmtDateTime = (t: DateInput) => `${fmtShortDate(t)}, ${fmtTime(t)}`;
/** "October 2026" */
export const fmtMonth = (t: DateInput) => monthFmt.format(d(t));
/** "Oct 2026", as in "Since Oct 2026". */
export const fmtMonthShort = (t: DateInput) => sep(monthShortFmt.format(d(t)));

/** "just now", "3 min ago", "2 h ago", then the short date after 24 hours. */
export function fmtAgo(t: DateInput, now: DateInput = Date.now()): string {
	const s = Math.round((d(now).getTime() - d(t).getTime()) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return fmtShortDate(t);
}

export const fmtNum = (n: number) => numFmt.format(n);
export const fmtPct = (share: number) => `${Math.round(share * 100)}%`;
/** "$5", "$12.50", "$1,000" */
export const fmtMoney = (cents: number) => `$${(cents % 100 === 0 ? numFmt : centsFmt).format(cents / 100)}`;
/** "1 source", "2,400 sources" */
export const plural = (n: number, one: string, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** "v.412", the list version as people see it. */
export const fmtListVersion = (sequence: number) => `v.${sequence}`;

/** Keeps both ends of a long raw ID: "UCx7Kq…9fQ2w". */
export function middleTruncate(s: string, max = 20): string {
	if (s.length <= max) return s;
	const keep = max - 1;
	return `${s.slice(0, Math.ceil(keep / 2))}…${s.slice(s.length - Math.floor(keep / 2))}`;
}

export const isPlatform = (p: string): p is Platform => (PLATFORMS as string[]).includes(p);

/** Path to the public source page. Keeps a leading @ readable. */
export const sourcePath = (platform: Platform, id: string) =>
	`/s/${platform}/${encodeURIComponent(id).replace(/^%40/, '@')}`;
export const appealPath = (platform: Platform, id: string) =>
	`/appeal/${platform}/${encodeURIComponent(id).replace(/^%40/, '@')}`;

/** A source can be appealed when it has a verdict other than Clear and no appeal is open yet. */
export const canAppeal = (s: Pick<Source, 'verdict' | 'appeal_open'> | null): boolean =>
	!!s?.verdict && s.verdict !== 'clear' && !s.appeal_open;

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

/**
 * "Decided by staff member Sam", "Decided by community scoring", "Appeal decided by Sam".
 * An appeal entry without a reviewer is the automatic change to Disputed when the appeal is verified.
 */
export function actorText(entry: Pick<LogEntry, 'actor' | 'actor_name' | 'to'>): string {
	switch (entry.actor) {
		case 'community':
			return 'Decided by community scoring';
		case 'appeal':
			if (entry.actor_name) return `Appeal decided by ${entry.actor_name}`;
			return entry.to === 'disputed' ? 'Changed by a verified appeal' : 'Appeal decided by staff';
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
