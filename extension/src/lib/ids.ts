// Canonical IDs, target keys and list hashes (docs/contracts.md sections 2.2 and 2.3).
// Adapters must normalize exactly as the contract says, or list matching fails silently,
// so every platform rule lives here and nowhere else.
import type { Platform } from '@colander/shared/verdicts';
import { sha256 } from './sha256';
import { utf8 } from './bytes';

export type TargetType = 'source' | 'item';

export function targetKey(platform: Platform, type: TargetType, id: string): string {
	return `${platform}:${type === 'source' ? 's' : 'i'}:${id}`;
}

export function parseTargetKey(key: string): { platform: Platform; type: TargetType; id: string } | null {
	const m = /^(yt|tt|ig|fb):([si]):(.+)$/.exec(key);
	return m ? { platform: m[1] as Platform, type: m[2] === 's' ? 'source' : 'item', id: m[3]! } : null;
}

/** First 8 bytes of SHA-256 over the UTF-8 target key. */
export function keyHash(key: string): Uint8Array {
	return sha256(utf8(key)).subarray(0, 8);
}

function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

// Path segments that are platform pages, never account names.
const IG_RESERVED = new Set(
	'p reel reels tv explore stories accounts direct about legal developer web challenge emails session privacy terms api graphql oauth static press blog jobs help topics locations tags hashtag audio ar nametag lite create'.split(' ')
);
const FB_RESERVED = new Set(
	'watch reel reels groups events marketplace gaming photo photo.php photos story.php permalink.php share sharer sharer.php hashtag help login logout privacy policies settings notifications messages friends bookmarks saved ads business stories live search videos l.php home.php profile.php people pages pg media plugins dialog checkpoint recover r.php composer feeds memories fundraisers jobs news weather games apps'.split(' ')
);

/** Canonicalizes a raw source token that was read off a page (an ID, handle or username). */
export function canonicalSource(platform: Platform, raw: string | null | undefined): string | null {
	if (!raw) return null;
	const v = decode(raw.trim());
	switch (platform) {
		case 'yt': {
			if (/^UC[\w-]{22}$/.test(v)) return v;
			// Handles: 3 to 30 characters of letters (any script), digits, "_", "-" and ".".
			const m = /^@([\p{L}\p{N}_.\-·]{3,30})$/u.exec(v);
			return m ? '@' + m[1]!.toLowerCase() : null;
		}
		case 'tt': {
			const m = /^@?([A-Za-z0-9_.]{1,24})$/.exec(v);
			return m ? '@' + m[1]!.toLowerCase() : null;
		}
		case 'ig': {
			const m = /^@?([A-Za-z0-9_.]{1,30})$/.exec(v);
			if (!m) return null;
			const u = m[1]!.toLowerCase();
			return IG_RESERVED.has(u) ? null : u;
		}
		case 'fb': {
			if (/^\d{5,20}$/.test(v)) return v;
			const m = /^([A-Za-z0-9.]{5,50})$/.exec(v);
			if (!m) return null;
			const u = m[1]!.toLowerCase();
			return FB_RESERVED.has(u) || u.endsWith('.php') ? null : u;
		}
	}
}

/** Canonicalizes a raw item ID. Item IDs keep their case on every platform. */
export function canonicalItem(platform: Platform, raw: string | null | undefined): string | null {
	if (!raw) return null;
	const v = raw.trim();
	switch (platform) {
		case 'yt':
			return /^[\w-]{11}$/.test(v) ? v : null;
		case 'tt':
			return /^\d{5,25}$/.test(v) ? v : null;
		case 'ig':
			return /^[A-Za-z0-9_-]{5,64}$/.test(v) ? v : null;
		case 'fb':
			return /^(?:pfbid[A-Za-z0-9]{8,}|\d{5,25})$/.test(v) ? v : null;
	}
}

const ORIGIN: Record<Platform, string> = {
	yt: 'https://www.youtube.com',
	tt: 'https://www.tiktok.com',
	ig: 'https://www.instagram.com',
	fb: 'https://www.facebook.com'
};

function toUrl(platform: Platform, href: string): URL | null {
	try {
		return new URL(href, ORIGIN[platform]);
	} catch {
		return null;
	}
}

function segments(url: URL): string[] {
	return url.pathname.split('/').filter(Boolean).map(decode);
}

/** Reads the source (channel, profile or page) a link points at, or null. */
export function sourceFromUrl(platform: Platform, href: string | null | undefined): string | null {
	if (!href) return null;
	const url = toUrl(platform, href);
	if (!url) return null;
	const seg = segments(url);
	switch (platform) {
		case 'yt':
			if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
			if (seg[0] === 'channel') return canonicalSource('yt', seg[1]);
			return seg[0]?.startsWith('@') ? canonicalSource('yt', seg[0]) : null;
		case 'tt':
			if (!/(^|\.)tiktok\.com$/.test(url.hostname)) return null;
			return seg[0]?.startsWith('@') ? canonicalSource('tt', seg[0]) : null;
		case 'ig':
			if (!/(^|\.)instagram\.com$/.test(url.hostname) || !seg[0]) return null;
			return canonicalSource('ig', seg[0]);
		case 'fb': {
			if (!/(^|\.)facebook\.com$/.test(url.hostname) || !seg[0]) return null;
			const id = url.searchParams.get('id');
			if (seg[0] === 'profile.php' || seg[0] === 'permalink.php') return canonicalSource('fb', id);
			if (seg[0] === 'people' && seg[2]) return canonicalSource('fb', seg[2]);
			if (seg[0] === 'pages' && seg[2]) return canonicalSource('fb', seg[2]);
			if (seg[0] === 'story.php') return canonicalSource('fb', id);
			return canonicalSource('fb', seg[0]);
		}
	}
}

/** Reads the item (video, Short, Reel or post) a link points at, or null. */
export function itemFromUrl(platform: Platform, href: string | null | undefined): string | null {
	if (!href) return null;
	const url = toUrl(platform, href);
	if (!url) return null;
	const seg = segments(url);
	switch (platform) {
		case 'yt': {
			if (url.hostname === 'youtu.be') return canonicalItem('yt', seg[0]);
			if (!/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) return null;
			if (seg[0] === 'watch') return canonicalItem('yt', url.searchParams.get('v'));
			if (seg[0] && ['shorts', 'embed', 'live', 'v'].includes(seg[0])) return canonicalItem('yt', seg[1]);
			return null;
		}
		case 'tt': {
			if (!/(^|\.)tiktok\.com$/.test(url.hostname)) return null;
			const i = seg.findIndex((s) => s === 'video' || s === 'photo');
			return i >= 0 ? canonicalItem('tt', seg[i + 1]) : null;
		}
		case 'ig': {
			if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
			// /p/{code}/, /reel/{code}/, /reels/{code}/, /tv/{code}/, also prefixed by a username.
			const i = seg.findIndex((s) => s === 'p' || s === 'reel' || s === 'reels' || s === 'tv');
			return i >= 0 && i <= 1 ? canonicalItem('ig', seg[i + 1]) : null;
		}
		case 'fb': {
			if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
			const story = url.searchParams.get('story_fbid');
			if (story) return canonicalItem('fb', story);
			for (const marker of ['posts', 'reel', 'videos']) {
				const i = seg.indexOf(marker);
				if (i < 0) continue;
				// /videos/{slug}/{id}/ is an older form: take the first segment that is an ID.
				for (const s of seg.slice(i + 1)) {
					const id = canonicalItem('fb', s);
					if (id) return id;
				}
			}
			if (seg[0] === 'watch') return canonicalItem('fb', url.searchParams.get('v'));
			return canonicalItem('fb', url.searchParams.get('fbid'));
		}
	}
}
