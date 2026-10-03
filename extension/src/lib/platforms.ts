// Site access per platform: the optional host permissions in the manifest, the content script
// registrations, and where the welcome page sends people when they finish.
import type { Platform } from '@colander/shared/verdicts';
import defaults from '../adapters/default-config.json';
import type { AdapterConfig, PlatformConfig } from '../adapters/schema';

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

/** A platform's rules: from a verified remote config newer than the bundled one, else the bundled. */
export function platformConfig(stored: AdapterConfig | undefined, p: Platform): PlatformConfig {
	const bundled = defaults as AdapterConfig;
	const remote = stored && stored.version > bundled.version ? stored.platforms[p] : undefined;
	return remote ?? bundled.platforms[p]!;
}

/** Early access platforms (Plus) are offered, and run, only with an active Plus entitlement. */
export function offered(p: Platform, stored: AdapterConfig | undefined, plus: boolean): boolean {
	return plus || !platformConfig(stored, p).early_access;
}
