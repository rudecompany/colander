import { parseHTML } from 'linkedom';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_FEED } from '../src/copy';
import { bar, chip, demoFeed, evidence, evidencePopover, gridStub, inpageContext, keepTogether, popoverRows, prerender, setServerDocument, SHEET, toast } from '../src/inpage';
import { barReason } from '../src/verdicts';

const doc = () => parseHTML('<!doctype html><html><body></body></html>').document as unknown as Document;
const ctx = inpageContext(doc(), 'https://colander.app');
const noop = () => {};

describe('in-page builders in Node', () => {

	it('render a chip like the Svelte VerdictChip', () => {
		const el = chip(ctx, { verdict: 'likely_slop', reason: '' });
		expect(el.tagName).toBe('SPAN');
		expect(el.className).toBe('cl-chip cl-chip-md cl-chip-tint');
		expect(el.getAttribute('data-v')).toBe('likely_slop');
		expect(el.querySelector('svg')!.getAttribute('class')).toBe('cl-glyph');
		expect(el.textContent).toBe('Likely slop');
	});

	it('name the collapsed bar for screen readers', () => {
		const item = DEMO_FEED.find((i) => i.id === 6)!;
		const reason = barReason(item.signals, item.verdict);
		expect(reason).toBe('Mass-produced, AI-made');
		const el = bar(ctx, { verdict: item.verdict, reason, hidden: true }, { onShow: noop, onWhy: noop });
		expect(el.getAttribute('aria-label')).toBe('Hidden for you: Likely slop. Mass-produced, AI-made.');
		expect(gridStub(ctx, { verdict: 'slop', reason }, { onShow: noop, onWhy: noop }).className).toBe('stub');
	});

	it('build the demo evidence card', () => {
		const item = DEMO_FEED.find((i) => i.id === 6)!;
		const ev = evidence({ verdict: item.verdict, hidden: true, rows: item.evidence, listDate: '2026-10-02T10:00:00Z' });
		expect(popoverRows(ev).map((r) => `${r.label}: ${r.texts[0]}`)).toEqual([
			'AI evidence: The platform labels it AI-generated.',
			'Source behavior: About 30 uploads a day, one title template.',
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
		const item = DEMO_FEED.find((i) => i.id === 6)!;
		const handlers = { show: noop, why: noop, allow: noop, notSlop: noop, skip: noop };
		const feed = demoFeed(ctx, { layout: 'grid', level: 'standard', items: [item], open: 6, focus: ['pop-show-6'] }, handlers);
		const why = feed.querySelector('[data-k="why-6"]')!;
		expect(why.getAttribute('aria-expanded')).toBe('true');
		expect(why.getAttribute('aria-controls')).toBe('cl-pop-6');
		const pop = feed.querySelector('#cl-pop-6')!;
		expect(pop.classList.contains('pop-in')).toBe(false);
		expect(pop.querySelector('[data-k="pop-show-6"]')).not.toBeNull();
		expect([...pop.querySelectorAll('.cl-link')].map((a) => [a.textContent, a.hasAttribute('href')])).toEqual([
			['Source page', false],
			['Is this your channel? Appeal this verdict.', false]
		]);
		expect(feed.getAttribute('data-focus')).toBe('pop-show-6');
		const opened = demoFeed(ctx, { layout: 'grid', level: 'standard', items: [item], open: 6, opened: 6 }, handlers);
		expect(opened.querySelector('#cl-pop-6')!.classList.contains('pop-in')).toBe(true);
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
		expect(prerender((c) => chip(c, { verdict: 'slop', reason: '' }))).toBeNull();
		setServerDocument(doc);
		const out = prerender((c) => chip(c, { verdict: 'slop', reason: '' }), 'auto');
		expect(out).toMatch(/^<template shadowrootmode="open"><style>:host\{/);
		expect(out).toContain('data-v="slop"');
	});

	afterAll(() => setServerDocument(null));
});
