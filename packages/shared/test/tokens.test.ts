import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PATHS, declarations, generate, rules, tokenBlocks } from '../scripts/gen-inpage-tokens.ts';
import { SHEET, SHEET_AUTO } from '../src/inpage/styles';

const css = readFileSync(PATHS.tokens, 'utf8');

describe('in-page tokens', () => {
	it('match colander.css and parts.css exactly', () => {
		expect(readFileSync(PATHS.out, 'utf8')).toBe(generate(css, readFileSync(PATHS.parts, 'utf8')));
	});

	it('give the band the dark values', () => {
		const dark = new Map(tokenBlocks(css).dark);
		const band = rules(css).find((r) => r.prelude === '.cl-band')!;
		const hex = declarations(band.body).filter(([, v]) => v.startsWith('#'));
		expect(hex.length).toBeGreaterThan(15);
		for (const [k, v] of hex) expect([k, v]).toEqual([k, dark.get(k)]);
	});

	it('keep SHEET within 14 KB', () => {
		expect(SHEET.length).toBeLessThanOrEqual(14 * 1024);
		expect(SHEET_AUTO.length).toBeLessThanOrEqual(15 * 1024);
	});

	it('keep hex values out of parts.css', () => {
		expect(readFileSync(PATHS.parts, 'utf8')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});
});
