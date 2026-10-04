import { parseHTML } from 'linkedom';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_FEED } from '../src/copy';
import { chip, DEMO_ORDER, demoFeed, evidence, evidencePopover, inpageContext, keepTogether, popoverRows, prerender, setServerDocument, SHEET, toast } from '../src/inpage';

const doc = () => parseHTML('<!doctype html><html><body></body></html>').document as unknown as Document;
const ctx = inpageContext(doc(), 'https://colander.app');
const noop = () => {};

describe('in-page builders in Node', () => {

	it('render a chip like the Svelte VerdictChip', () => {
		const el = chip(ctx, { verdict: 'likely_slop' });
		expect(el.tagName).toBe('SPAN');
		expect(el.className).toBe('cl-chip cl-chip-md cl-chip-tint');
		expect(el.getAttribute('data-v')).toBe('likely_slop');
		expect(el.querySelector('svg')!.getAttribute('class')).toBe('cl-glyph');
		expect(el.textContent).toBe('Likely slop');
	});

	it('leave hidden items out of the demo feed, with no placeholder, and skip them in swipe feeds', () => {
		const handlers = { why: noop, allow: noop, notSlop: noop };
		const grid = DEMO_ORDER.grid!.map((id) => DEMO_FEED.find((i) => i.id === id)!);
		const ids = (level: 'label' | 'standard' | 'no_ai', revealed: number[] = []) =>
			[...demoFeed(ctx, { layout: 'grid', level, revealed, items: grid }, handlers).children].map((c) => Number(c.getAttribute('data-k')!.slice(5)));
		const rest = [10, 11, 12, 13, 14, 15, 16];
		expect(ids('label')).toEqual([1, 8, 3, 2, 6, 5, 7, 4, 9, ...rest]);
		expect(ids('standard')).toEqual([1, 8, 3, 5, 7, 9, ...rest]);
		expect(ids('no_ai')).toEqual([1, 8, 5, 7, 9, ...rest]);
		// Every level keeps at least 4 full rows of 3, so the hero's frame never ends on a short row.
		for (const level of ['label', 'standard', 'no_ai'] as const) expect(ids(level).length).toBeGreaterThanOrEqual(12);
		// Show brings a hidden item back, labeled, in its own slot.
		expect(ids('standard', [6])).toEqual([1, 8, 3, 6, 5, 7, 9, ...rest]);
		const swipe = (level: 'label' | 'standard' | 'no_ai') =>
			demoFeed(ctx, { layout: 'swipe', level, items: DEMO_ORDER.swipe!.map((id) => DEMO_FEED.find((i) => i.id === id)!) }, handlers).querySelector('.card')!.getAttribute('data-k');
		expect([swipe('label'), swipe('standard'), swipe('no_ai')]).toEqual(['card-6', 'card-3', 'card-1']);
	});

	it('build the demo evidence card', () => {
		const item = DEMO_FEED.find((i) => i.id === 6)!;
		const ev = evidence({ verdict: item.verdict, hidden: true, rows: item.evidence, listDate: '2026-10-02T10:00:00Z' });
		expect(popoverRows(ev).map((r) => `${r.label}: ${r.texts[0]}`)).toEqual([
			'AI evidence: The platform labels it AI-generated.',
			'Source behavior: One title template, numbered part after part.',
			'Community: Tags are still coming in.'
		]);
		const el = evidencePopover(ctx, ev, { show: noop, allow: noop, notSlop: noop });
		expect(el.textContent).toContain('Why this is hidden');
		expect(el.textContent).toContain('Core list, updated 2 Oct 2026');
	});

	it('keep hyphenated AI terms on one line', () => {
		expect(keepTogether('The platform labels it AI-generated.')).toEqual(['The platform labels it ', 'AI-generated.', '']);
		const ev = evidence({ verdict: 'likely_slop', hidden: true, rows: [{ layer: 'provenance', text: 'The platform labels it AI-generated.', agreed: true }] });
		expect(evidencePopover(ctx, ev).querySelector('.cl-nw')!.textContent).toBe('AI-generated.');
	});

	it('wire the demo popover to its anchor, with inert links and keyed actions', () => {
		const item = DEMO_FEED.find((i) => i.id === 3)!;
		const handlers = { why: noop, allow: noop, notSlop: noop };
		const feed = demoFeed(ctx, { layout: 'grid', level: 'standard', items: [item], open: 3, focus: ['pop-allow-3'] }, handlers);
		const why = feed.querySelector('[data-k="why-3"]')!;
		expect(why.getAttribute('aria-expanded')).toBe('true');
		expect(why.getAttribute('aria-controls')).toBe('cl-pop-3');
		const pop = feed.querySelector('#cl-pop-3')!;
		expect(pop.classList.contains('pop-in')).toBe(false);
		expect(pop.textContent).toContain('Why this is labeled');
		expect(pop.querySelector('[data-k="pop-allow-3"]')).not.toBeNull();
		// The demo's invented sources have no pages: their links are plain words, nothing to click.
		expect(pop.querySelectorAll('a, .cl-link')).toHaveLength(0);
		expect([...pop.querySelectorAll('.cl-link-inert')].map((a) => a.textContent)).toEqual(['Source page', 'Is this your channel? Appeal this verdict.']);
		expect(feed.getAttribute('data-focus')).toBe('pop-allow-3');
		const opened = demoFeed(ctx, { layout: 'grid', level: 'standard', items: [item], open: 3, opened: 3 }, handlers);
		expect(opened.querySelector('#cl-pop-3')!.classList.contains('pop-in')).toBe(true);
	});

	it('build evidence from signals, agreed layers first', () => {
		const ev = evidence({ verdict: 'slop', hidden: true, signals: ['community_consensus', 'platform_label'], platform: 'yt', sourceId: '@x', appealable: true, site: 'https://colander.app' });
		expect(popoverRows(ev).map((r) => r.agreed)).toEqual([true, true, false]);
		expect(ev.appealUrl).toBe('https://colander.app/appeal/yt/@x');
		expect(ev.appealText).toBe('Is this your channel? Appeal this verdict.');
	});

	it('render the toast with a 4-dot countdown and Close', () => {
		const el = toast(ctx, { text: 'Skipped 1 slop video.', verdict: 'slop', actions: [{ label: 'Undo', onClick: noop }], paused: true });
		expect(el.getAttribute('role')).toBe('status');
		expect(el.querySelectorAll('.cl-count > i').length).toBe(4);
		expect(el.querySelector('[aria-label="Close"]')).not.toBeNull();
	});

	it('prerender Declarative Shadow DOM with a registered document', () => {
		expect(prerender((c) => chip(c, { verdict: 'slop' }))).toBeNull();
		setServerDocument(doc);
		const out = prerender((c) => chip(c, { verdict: 'slop' }), 'auto');
		expect(out).toMatch(/^<template shadowrootmode="open"><style>:host\{/);
		expect(out).toContain('data-v="slop"');
	});

	afterAll(() => setServerDocument(null));
});
