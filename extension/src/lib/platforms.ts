// Site access per platform: the optional host permissions in the manifest, the content script
// registrations, and where the welcome page sends people when they finish.
import type { Platform } from '@colander/shared/verdicts';

export const ORIGINS: Record<Platform, string[]> = {
	yt: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
	tt: ['*://www.tiktok.com/*', '*://m.tiktok.com/*'],
	ig: ['*://www.instagram.com/*', '*://m.instagram.com/*'],
	fb: ['*://www.facebook.com/*', '*://m.facebook.com/*', '*://web.facebook.com/*']
};

export const HOME: Record<Platform, string> = {
	yt: 'https://www.youtube.com/',
	tt: 'https://www.tiktok.com/foryou',
	ig: 'https://www.instagram.com/',
	fb: 'https://www.facebook.com/'
};

export const ALL_ORIGINS = Object.values(ORIGINS).flat();
