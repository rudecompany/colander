// The server's checks of canonical IDs (contracts 2.2; Go's internal/api/ids.go). Lowercasing is
// applied where the contract asks for it; anything else malformed is rejected, so adapter bugs
// surface instead of silently not matching. The extension's halves, which read IDs off pages, are
// canonicalSource and canonicalItem in @colander/shared/ids; both sides pass the contract vectors.
import { lowerSimple } from '@colander/shared/ids';
import { PLATFORMS, type Platform } from '@colander/shared/verdicts';
import { trimSpace } from './respond';

const ytChannel = /^UC[A-Za-z0-9_-]{22}$/;
const ytHandle = /^@[\p{L}\p{M}\p{N}._·-]{1,100}$/u;
const ytVideo = /^[A-Za-z0-9_-]{11}$/;
const ttUser = /^@[a-z0-9._]{1,64}$/;
const numeric = /^[0-9]{1,30}$/;
const igUser = /^[a-z0-9._]{1,30}$/;
const igCode = /^[A-Za-z0-9_-]{4,64}$/;
const fbVanity = /^[a-z0-9._-]{1,100}$/;
const fbPost = /^[A-Za-z0-9_-]{1,100}$/;

export const validPlatform = (p: string): p is Platform => (PLATFORMS as string[]).includes(p);

/** What a source is called on each platform, in emails (Go's sourceNoun). */
export const sourceNoun: Record<Platform, string> = { yt: 'channel', tt: 'profile', ig: 'profile', fb: 'page' };

/** Go's url.PathUnescape, keeping the input when it does not decode. */
function pathUnescape(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * The contract 2.2 steps shared by every platform, in the same order as the extension: trim,
 * percent-decode (seed lists and page links carry encoded handles), then NFC. Lowercasing happens
 * per platform with lowerSimple, Go's per-code-point strings.ToLower.
 */
function normalizeToken(id: string): string {
	return pathUnescape(trimSpace(id)).normalize('NFC');
}

/** The canonical source ID, or undefined when id is not one (Go's CanonicalSource). */
export function canonicalSource(platform: string, id: string): string | undefined {
	id = normalizeToken(id);
	switch (platform) {
		case 'yt':
			if (ytChannel.test(id)) return id;
			id = lowerSimple(id);
			return ytHandle.test(id) ? id : undefined;
		case 'tt':
			id = lowerSimple(id);
			return ttUser.test(id) ? id : undefined;
		case 'ig':
			id = lowerSimple(id);
			return igUser.test(id) ? id : undefined;
		case 'fb':
			id = lowerSimple(id);
			return numeric.test(id) || fbVanity.test(id) ? id : undefined;
	}
	return undefined;
}

/** The canonical item ID, or undefined when id is not one (Go's CanonicalItem). */
export function canonicalItem(platform: string, id: string): string | undefined {
	const re = { yt: ytVideo, tt: numeric, ig: igCode, fb: fbPost }[platform];
	return re?.test(id) ? id : undefined;
}
