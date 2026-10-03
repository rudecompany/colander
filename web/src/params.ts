// Loaded by Node during the build, so import the dependency-free verdicts module directly.
import { defineParams } from '@sveltejs/kit/params';
import { PLATFORMS, type Platform } from '@colander/shared/verdicts';

export const params = defineParams({
	platform: (param: string): Platform | undefined => ((PLATFORMS as string[]).includes(param) ? (param as Platform) : undefined)
});
