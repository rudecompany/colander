// Canonical ID normalization per docs/contracts.md 2.2, as a table of real-looking URLs.
import { describe, expect, it } from 'vitest';
import type { Platform } from '../src/verdicts';
import { canonicalItem, canonicalSource, itemFromUrl, parseTargetKey, sourceFromUrl, targetKey } from '../src/ids';

const sources: [Platform, string, string | null][] = [
	['yt', 'https://www.youtube.com/@MrBeast', '@mrbeast'],
	['yt', '/@MrBeast/videos', '@mrbeast'],
	['yt', '/@PhillipsBrothers1/shorts', '@phillipsbrothers1'],
	['yt', 'https://m.youtube.com/@NASA', '@nasa'],
	['yt', '/@caf%C3%A9-Cr%C3%A8me', '@café-crème'],
	['yt', '/channel/UCX6OQ3DkcsbYNE6H8uQQuVA', 'UCX6OQ3DkcsbYNE6H8uQQuVA'],
	['yt', '/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/featured', 'UCX6OQ3DkcsbYNE6H8uQQuVA'],
	['yt', '/c/LegacyName', null],
	['yt', '/watch?v=dQw4w9WgXcQ', null],
	['yt', 'https://example.com/@mrbeast', null],
	['tt', 'https://www.tiktok.com/@TikTok', '@tiktok'],
	['tt', '/@jul.spamz.fr', '@jul.spamz.fr'],
	['tt', 'https://www.tiktok.com/@Some_User/video/7412345678901234567', '@some_user'],
	['tt', '/tag/fyp', null],
	['tt', '/music/original-sound-7656197519139031840', null],
	['ig', 'https://www.instagram.com/NatGeo/', 'natgeo'],
	['ig', '/natgeo/reels/', 'natgeo'],
	['ig', '/natgeo/p/C9xYz12AbCd/', 'natgeo'],
	['ig', '/p/C9xYz12AbCd/', null],
	['ig', '/reel/C9xYz12AbCd/', null],
	['ig', '/explore/', null],
	['ig', '/stories/natgeo/123/', null],
	['fb', 'https://www.facebook.com/profile.php?id=100064582345678', '100064582345678'],
	['fb', '/people/Jane-Doe/100089123456789/', '100089123456789'],
	['fb', 'https://www.facebook.com/NatGeo', 'natgeo'],
	['fb', '/natgeo/posts/pfbid02abcDEF1234567', 'natgeo'],
	['fb', '/permalink.php?story_fbid=pfbid0xyzABC12345&id=100064582345678', '100064582345678'],
	['fb', '/watch/?v=123456789012345', null],
	['fb', '/reel/987654321098765', null],
	['fb', '/groups/123456/', null],
	['fb', '/photo/?fbid=123456789&set=a.987', null]
];

const items: [Platform, string, string | null][] = [
	['yt', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['yt', '/watch?v=riWwRRrdsoM&pp=ygUTaGlzdG9yeSBkb2N1bWVudGFyeQ%3D%3D', 'riWwRRrdsoM'],
	['yt', '/watch?v=riWwRRrdsoM&t=420s', 'riWwRRrdsoM'],
	['yt', '/shorts/JEk-AYHbkmQ', 'JEk-AYHbkmQ'],
	['yt', 'https://www.youtube.com/shorts/qnDQz1YJKlc', 'qnDQz1YJKlc'],
	['yt', 'https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
	['yt', '/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
	['yt', '/@HISTORY', null],
	['yt', '/watch?v=short', null],
	['tt', 'https://www.tiktok.com/@tiktok/video/7692114317151423775', '7692114317151423775'],
	['tt', '/@someone/photo/7412345678901234567', '7412345678901234567'],
	['tt', '/@someone', null],
	['ig', '/p/C9xYz12AbCd/', 'C9xYz12AbCd'],
	['ig', 'https://www.instagram.com/reel/DAbC_12-xYz/', 'DAbC_12-xYz'],
	['ig', '/reels/DAbC_12-xYz/', 'DAbC_12-xYz'],
	['ig', '/natgeo/p/C9xYz12AbCd/', 'C9xYz12AbCd'],
	['ig', '/natgeo/', null],
	['fb', '/natgeo/posts/pfbid02abcDEF1234567', 'pfbid02abcDEF1234567'],
	['fb', '/permalink.php?story_fbid=pfbid0xyzABC12345&id=100064582345678', 'pfbid0xyzABC12345'],
	['fb', '/story.php?story_fbid=1234567890&id=100064582345678', '1234567890'],
	['fb', '/reel/987654321098765', '987654321098765'],
	['fb', '/natgeo/videos/1234567890123/', '1234567890123'],
	['fb', '/natgeo/videos/a-title-slug/1234567890123/', '1234567890123'],
	['fb', '/watch/?v=123456789012345', '123456789012345'],
	['fb', '/photo/?fbid=123456789&set=a.987', '123456789'],
	['fb', '/natgeo', null]
];

describe('source IDs from URLs', () => {
	it.each(sources)('%s %s -> %s', (p, url, want) => expect(sourceFromUrl(p, url)).toBe(want));
});

describe('item IDs from URLs', () => {
	it.each(items)('%s %s -> %s', (p, url, want) => expect(itemFromUrl(p, url)).toBe(want));
});

describe('raw IDs', () => {
	it('canonicalizes per platform', () => {
		expect(canonicalSource('yt', '@SomeChannel')).toBe('@somechannel');
		expect(canonicalSource('yt', 'UCaaaaaaaaaaaaaaaaaaaaaa')).toBe('UCaaaaaaaaaaaaaaaaaaaaaa');
		expect(canonicalSource('yt', 'ucaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
		expect(canonicalSource('tt', 'TikTok')).toBe('@tiktok');
		expect(canonicalSource('ig', '@NatGeo')).toBe('natgeo');
		expect(canonicalSource('fb', 'NatGeo')).toBe('natgeo');
		expect(canonicalItem('tt', '7608248907960814879')).toBe('7608248907960814879');
		expect(canonicalItem('fb', 'pfbid02abcDEF')).toBe('pfbid02abcDEF');
		expect(canonicalItem('yt', 'dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('builds and parses target keys', () => {
		expect(targetKey('yt', 'source', '@mrbeast')).toBe('yt:s:@mrbeast');
		expect(targetKey('yt', 'item', 'dQw4w9WgXcQ')).toBe('yt:i:dQw4w9WgXcQ');
		expect(parseTargetKey('fb:i:pfbid02abcDEF')).toEqual({ platform: 'fb', type: 'item', id: 'pfbid02abcDEF' });
		expect(parseTargetKey('xx:s:a')).toBeNull();
	});
});
