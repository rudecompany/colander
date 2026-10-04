// Build configuration (docs/contracts.md section 11). Values are fixed at build time.

/** The development public key, the same bytes as testdata/dev-signing.pub. */
export const DEV_PUBLIC_KEY = '/M2DK/bv47lip44F239fPlUbehIkyv3xaF6OJlkkZPY=';

const trim = (s: string) => s.replace(/\/+$/, '');

export const API = trim(import.meta.env.WXT_COLANDER_API || 'http://localhost:8787');
export const SITE = trim(import.meta.env.WXT_COLANDER_SITE || API);
export const PUBLIC_KEYS = (import.meta.env.WXT_COLANDER_PUBLIC_KEYS || DEV_PUBLIC_KEY)
	.split(',')
	.map((k: string) => k.trim())
	.filter(Boolean);
