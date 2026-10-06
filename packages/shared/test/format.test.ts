import { describe, expect, it } from 'vitest';
import { PLATFORM_SURFACES } from '../src/copy';
import { demoCounts, demoHiddenCount } from '../src/inpage/demo';
import { fmtAgo, fmtDate, fmtDateTime, fmtDay, fmtList, fmtShortDate, fmtTime, middleTruncate } from '../src/utils/format';

const t = '2026-10-02T14:02:00Z';

describe('formats', () => {
	it('write en-GB dates and UTC times', () => {
		expect(fmtShortDate(t)).toBe('2 Oct 2026');
		expect(fmtDate(t)).toBe('2 October 2026');
		expect(fmtDay(t)).toBe('Fri 2 Oct 2026');
		expect(fmtTime(t)).toBe('14:02 UTC');
		expect(fmtDateTime(t)).toBe('2 Oct 2026, 14:02 UTC');
		expect(fmtShortDate('2026-09-03T00:00:00Z')).toBe('3 Sep 2026');
	});

	it('join lists with "and" and no comma before it', () => {
		expect(fmtList(['YouTube'])).toBe('YouTube');
		expect(fmtList(['YouTube', 'TikTok'])).toBe('YouTube and TikTok');
		expect(fmtList(['Chrome', 'Edge', 'Brave', 'Opera'])).toBe('Chrome, Edge, Brave and Opera');
	});

	it('say how long ago, then the date after a day', () => {
		const now = Date.parse(t);
		expect(fmtAgo(now - 20_000, now)).toBe('just now');
		expect(fmtAgo(now - 3 * 60_000, now)).toBe('3 min ago');
		expect(fmtAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
		expect(fmtAgo(now - 25 * 3_600_000, now)).toBe('1 Oct 2026');
	});

	it('keep both ends of a long ID', () => {
		expect(middleTruncate('UCx7Kq0000000000000009fQ2w', 13)).toBe('UCx7Kq…09fQ2w');
		expect(middleTruncate('@short')).toBe('@short');
	});
});

describe('shared copy and demo', () => {
	it('list each platform surface in words', () => {
		expect(PLATFORM_SURFACES.yt).toBe('Home, Subscriptions, Search, Up next, Shorts, Channel pages');
		expect(PLATFORM_SURFACES.fb).toBe('Feed, Reels');
	});

	it('count the demo badge by level: hidden items, as the extension counts them', () => {
		expect([demoHiddenCount('label'), demoHiddenCount('standard'), demoHiddenCount('no_ai')]).toEqual([0, 3, 4]);
		expect(demoHiddenCount('no_ai', true)).toBe(0);
		expect(demoCounts('standard')).toBe('3 hidden, 2 labeled');
	});
});
