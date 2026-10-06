// The scoring engine (src/scoring/engine.ts and actions.ts): the port of
// server/internal/scoring/engine_test.go against the real Store SQLite inside workerd, the curator
// limits Go checked in its review route, and the engine's wiring into the Store's jobs: the
// chunked pass, the debounced rescore and a reviewer decision between two chunks of a pass.
import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { hex } from '@colander/shared/bytes';
import { keyHash, targetKey } from '@colander/shared/ids';
import { ENTRY, FLAG_STAFF_REVIEWED, verifyList } from '@colander/shared/list';
import { importKeys } from '@colander/shared/signing';
import { VERDICT_CODE } from '@colander/shared/verdicts';
import { DEBOUNCE, PASS_CHUNK, STATUS, type PassStatus } from '../src/jobs';
import { AIEvidenceRequiredError, decide, resolveAppeal, StaffRequiredError, verifyAppeal } from '../src/scoring/actions';
import { evidence, unix } from '../src/scoring/engine';
import { Default, Sig, TestBit } from '../src/scoring/rules';
import { grantRole } from '../src/store/accounts';
import { AppealExpired, AppealPendingManual, AppealAwaiting, AppealUnderReview, createAppeal, getAppeal, transitionAppeal } from '../src/store/appeals';
import { SNAPSHOT_KEY } from '../src/store/list';
import { putSync, startTrial } from '../src/store/misc';
import { SeedRegistry, setSeedSuppression } from '../src/store/seeds';
import { findItem, findSource, getSource, setYouTube, type Source } from '../src/store/sources';
import { createReport, getReport, saveTags } from '../src/store/tags';
import { applyUpdate, loadSourceData, log, openEscalations, reputation } from '../src/store/verdicts';
import type { Store } from '../src/store/store';
import { clearedEntry, listSeed } from './seed-fixtures';

const keys = await importKeys([inject('contract').devPublicKey]);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Go's test fixture: one Store's database, the engine and a clock the engine reads. */
class Fixture {
	n = 0;

	constructor(
		readonly store: Store,
		public clock = Date.UTC(2026, 5, 1)
	) {
		store.now = () => this.clock;
	}

	get db() {
		return this.store.db;
	}

	get eng() {
		return this.store.engine;
	}

	/** The clock in unix seconds. */
	get s() {
		return unix(this.clock);
	}

	/** n new installs tag a YouTube source; installs are created at the current clock. */
	tags(n: number, source: string, verdict: string, label: boolean): string[] {
		const installs = Array.from({ length: n }, (_, i) => `install-${pad(this.n + i + 1, 4)}`);
		this.tagAs(installs, 'yt', 'source', source, '', verdict, label);
		return installs;
	}

	/**
	 * Each install tags a target. source is an item's source, "" for source tags and for items
	 * tagged where the card does not show their source.
	 */
	tagAs(installs: string[], platform: string, targetType: string, target: string, source: string, verdict: string, label: boolean): void {
		if (targetType === 'source') source = target;
		for (const h of installs) {
			this.n++;
			const tests = verdict === 'slop' ? TestBit.low_effort | TestBit.mass_produced : 0;
			saveTags(
				this.db,
				h,
				[
					{
						clientId: `c${this.n}`,
						platform,
						targetType,
						targetId: target,
						sourceId: source,
						verdict,
						slopType: '',
						tests,
						platformLabel: label,
						createdAt: this.s,
						extVersion: ''
					}
				],
				this.s
			);
		}
	}

	source(alias: string): Source {
		return this.sourceOn('yt', alias);
	}

	sourceOn(platform: string, alias: string): Source {
		const ref = findSource(this.db, platform, alias);
		expect(ref, `${platform} ${alias}`).toBeDefined();
		return getSource(this.db, ref!)!;
	}

	pass(): Promise<number> {
		return this.eng.fullPass(this.clock);
	}

	escalations(): Set<string> {
		return new Set(openEscalations(this.db).map((e) => e.kind));
	}

	/** The open escalations on a source itself, kind to summary. */
	escalationsOf(ref: number): Record<string, string> {
		const out: Record<string, string> = {};
		for (const e of openEscalations(this.db)) if (e.sourceRef === ref && e.itemRef === 0) out[e.kind] = e.summary;
		return out;
	}

	/**
	 * Records YouTube data showing 20 uploads a day (the behavior layer) and 50,000 subscribers, with
	 * derived use on (YOUTUBE_DERIVED_USE), so the figures reach scoring.
	 */
	highVolume(alias: string, channelId = 'UCzzzzzzzzzzzzzzzzzzzzz1'): void {
		this.eng.derived = true;
		setYouTube(this.db, this.source(alias).ref, { channelId, handle: alias, subscribers: 50_000, uploadsPerDay: 20 }, this.s);
	}

	appeal(ref: number, code: string) {
		return createAppeal(this.db, { platform: 'yt', sourceRef: ref, email: 'x@example.test', statement: 'Not slop.', code, secretHash: 'h', createdAt: this.s });
	}
}

const installs = (from: number, n: number) => Array.from({ length: n }, (_, i) => `install-${pad(1000 + from + i, 4)}`);

/** Runs a test against a fresh Store (one name per test keeps them apart). Only "primary" runs jobs. */
let stores = 0;
const withFixture = (fn: (f: Fixture) => void | Promise<void>) =>
	runInDurableObject(env.STORE.getByName(`scoring-${++stores}`), (store: Store) => fn(new Fixture(store)));

beforeEach(() => {
	// Passes and publications log a line each.
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('engine', () => {
	// Six mature installs tagging a TikTok source and five of its items as slop never make it Slop.
	// Without platform labels, tags alone never count an item as AI-made for the 80% rule; with
	// labels, the source is still held at Likely slop because its audience size is unknown, until
	// staff decide. A YouTube source with API uploads a day and a known audience under 100,000 can
	// reach Slop.
	it('never makes Slop from tags alone', () =>
		withFixture(async (f) => {
			const six = installs(0, 6);
			for (const [k, src] of [
				{ alias: '@petfarm', label: false },
				{ alias: '@labelfarm', label: true }
			].entries()) {
				f.tagAs(six, 'tt', 'source', src.alias, '', 'slop', false);
				for (let i = 0; i < 5; i++) f.tagAs(six, 'tt', 'item', `74${pad(10 * k + i, 17)}`, src.alias, 'slop', src.label);
			}
			f.tagAs(six, 'yt', 'source', '@ytfarm', '', 'slop', true);
			f.highVolume('@ytfarm');
			f.clock += 40 * DAY;
			await f.pass();
			await f.pass();

			const pet = f.sourceOn('tt', '@petfarm');
			expect(pet.state.verdict, 'tag-only TikTok source').toBe('likely_slop');
			expect(pet.state.signals & Sig.mostly_ai).toBe(0);

			const label = f.sourceOn('tt', '@labelfarm');
			expect(label.state).toMatchObject({ verdict: 'likely_slop', computed: 'slop' });
			expect(label.state.signals & Sig.mostly_ai).not.toBe(0);
			expect(f.escalationsOf(label.ref).capped).toContain('audience size unknown');
			const entries = log(f.db, { sourceRef: label.ref, limit: 1 });
			expect(entries).toHaveLength(1);
			expect(entries[0]!.reason).toContain('Held at Likely slop until staff review it, because its audience size is unknown.');
			// Only a reviewer makes it Slop.
			decide(f.eng, { sourceRef: label.ref, verdict: 'slop', reason: 'Generated pet clips.', actor: 'staff', large: false });
			expect(f.sourceOn('tt', '@labelfarm').state.verdict).toBe('slop');

			const yt = f.source('@ytfarm');
			expect(yt.state.verdict).toBe('slop');
			expect(f.escalationsOf(yt.ref)).toEqual({});
		}));

	// A mixed source: platform labels on its items never count toward its own provenance, and its
	// items keep their own list entries even when they match its verdict.
	it("keeps a mixed source's items on the list", () =>
		withFixture(async (f) => {
			f.tagAs(installs(0, 3), 'yt', 'source', '@mixedchan', '', 'slop', false);
			for (let i = 0; i < 10; i++) {
				const item = `mixedItem${pad(i, 2)}`;
				if (i < 3) f.tagAs(installs(10 + 2 * i, 2), 'yt', 'item', item, '@mixedchan', 'ai_fine', true);
				else f.tagAs(installs(10 + 2 * i, 2), 'yt', 'item', item, '@mixedchan', 'not_slop', false);
			}
			f.highVolume('@mixedchan');
			f.clock += 40 * DAY;
			await f.pass();
			expect(f.source('@mixedchan').state, 'mixed source with labels only on items').toMatchObject({ verdict: '', mixed: true });

			// With AI evidence on the source itself it is AI-made, and its AI-made items stay listed.
			f.tagAs(installs(40, 2), 'yt', 'source', '@mixedchan', '', 'ai_fine', true);
			await f.pass();
			expect(f.source('@mixedchan').state.verdict).toBe('ai_made');
			await f.store.publisher.publish(f.clock);
			const snap = await f.store.publisher.currentSnapshot();
			await env.LISTS.delete(SNAPSHOT_KEY);
			const file = await verifyList(snap!.bytes, keys);
			const listed = new Map<string, number>();
			for (let i = 0; i < file.count; i++) listed.set(hex(file.entries.subarray(i * ENTRY, i * ENTRY + 8)), file.entries[i * ENTRY + 8]!);
			for (let i = 0; i < 3; i++) {
				const hash = hex(keyHash(targetKey('yt', 'item', `mixedItem${pad(i, 2)}`)));
				expect(listed.get(hash), `item ${i}`).toBe(VERDICT_CODE.ai_made);
			}
		}));

	// Items tagged where the card does not show their source are scored on their own: nothing rolls
	// up to the placeholder that holds them, and an item joins its source once a tag names it.
	it('scores items without a source on their own', () =>
		withFixture(async (f) => {
			for (let i = 0; i < 5; i++) f.tagAs(installs(0, 3), 'ig', 'item', `Cexplore${i}`, '', 'ai_fine', true);
			f.clock += 40 * DAY;
			await f.pass();
			const holder = f.sourceOn('ig', '');
			expect(holder.state, 'placeholder source').toMatchObject({ verdict: '', computed: '' });
			expect(findItem(f.db, 'ig', 'Cexplore0')!.state.verdict).toBe('ai_made');

			f.tagAs(installs(10, 1), 'ig', 'item', 'Cexplore0', 'dreamy.pics', 'slop', false);
			const it = findItem(f.db, 'ig', 'Cexplore0')!;
			expect(it.sourceRef).toBe(f.sourceOn('ig', 'dreamy.pics').ref);
			expect(loadSourceData(f.db, it.sourceRef, f.s)!.votes, 'tags moved with the item').toHaveLength(4);
		}));

	// A curator decision made while an appeal is open is never what a denied appeal restores.
	it('never restores a curator decision made during an appeal when it is denied', () =>
		withFixture(async (f) => {
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY;
			await f.pass();
			const ref = f.source('@farm').ref;
			const a = f.appeal(ref, 'colander-TEST0002');
			f.clock += HOUR;
			decide(f.eng, { sourceRef: ref, verdict: 'clear', reason: 'Looks fine to me.', actor: 'curator' });
			verifyAppeal(f.eng, a);
			const rae = grantRole(f.db, 'rae@colander.test', 'staff', f.s, { host: 'job' });
			resolveAppeal(f.eng, a, 'denied', 'Twenty generated uploads a day.', rae);
			expect(f.source('@farm').state.verdict, 'denied appeal restored').toBe('slop');
		}));

	// Slop and Likely slop decisions need AI evidence: the target's provenance layer, or a provenance signal.
	it('needs AI evidence for Slop and Likely slop decisions', () =>
		withFixture((f) => {
			f.tags(1, '@quiet', 'slop', false);
			const ref = f.source('@quiet').ref;
			for (const verdict of ['slop', 'likely_slop']) {
				expect(() => decide(f.eng, { sourceRef: ref, verdict, reason: 'Looks generated.', actor: 'staff' }), verdict).toThrow(AIEvidenceRequiredError);
			}
			expect(log(f.db, { sourceRef: ref, limit: 10 })).toEqual([]);
			decide(f.eng, { sourceRef: ref, verdict: 'slop', reason: 'The creator says so.', actor: 'staff', signals: Sig.creator_statement });
			// The recorded signal is not evidence for the next decision, which replaces it.
			expect(() => decide(f.eng, { sourceRef: ref, verdict: 'likely_slop', reason: 'Softer.', actor: 'staff' })).toThrow(AIEvidenceRequiredError);
			f.tagAs(installs(0, 2), 'yt', 'source', '@quiet', '', 'ai_fine', true);
			decide(f.eng, { sourceRef: ref, verdict: 'likely_slop', reason: 'Labelled.', actor: 'curator' });
			expect(f.source('@quiet').state.verdict).toBe('likely_slop');

			// The same holds for an item: its own provenance, not its source's.
			f.tagAs(installs(10, 1), 'yt', 'item', 'abcdefghijk', '@quiet', 'slop', false);
			const item = findItem(f.db, 'yt', 'abcdefghijk')!.ref;
			expect(() => decide(f.eng, { sourceRef: ref, itemRef: item, verdict: 'slop', reason: 'Looks generated.', actor: 'curator' })).toThrow(
				AIEvidenceRequiredError
			);
			decide(f.eng, { sourceRef: ref, itemRef: item, verdict: 'slop', reason: 'Watermark in frame.', actor: 'curator', signals: Sig.watermark });
			expect(findItem(f.db, 'yt', 'abcdefghijk')!.state.verdict).toBe('slop');
		}));

	// A new list verdict closes the reports filed before it, showing that verdict.
	it('closes reports with the community verdict', () =>
		withFixture(async (f) => {
			const { report } = createReport(
				f.db,
				{
					installHash: 'reporter',
					clientId: 'r',
					platform: 'yt',
					sourceId: '@farm',
					sourceName: '',
					reason: 'Generated narration.',
					examples: [],
					slopType: '',
					tests: 0,
					extVersion: ''
				},
				f.s
			);
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY;
			await f.pass();
			expect(getReport(f.db, report.id)).toMatchObject({ status: 'decided', verdict: 'slop' });
		}));

	// An appeal waiting for staff to check its code by hand is kept, and escalated once it has
	// waited as long as an unverified appeal may.
	it('escalates an appeal left waiting for a manual check', () =>
		withFixture(async (f) => {
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY;
			await f.pass();
			const ref = f.source('@farm').ref;
			const a = f.appeal(ref, 'colander-TEST0003');
			transitionAppeal(f.db, a.id, [AppealAwaiting], AppealPendingManual, {});
			f.clock += 13 * DAY;
			await f.pass();
			expect(f.escalationsOf(ref).appeal, 'escalated before the appeal waited 14 days').toBeUndefined();
			f.clock += 2 * DAY;
			await f.pass();
			expect(getAppeal(f.db, a.id)!.status).toBe(AppealPendingManual);
			expect(f.escalationsOf(ref).appeal).toBe('Appeal filed more than 14 days ago still waits for staff to check its code');
		}));

	// A staff Slop decision lapses after 90 days; scored again as Slop, the source holds at Likely
	// slop with an escalation until staff look again.
	it('holds a lapsed Slop at Likely slop until staff look again', () =>
		withFixture(async (f) => {
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY; // the taggers mature
			await f.pass();
			let src = f.source('@farm');
			expect(src.state.verdict, 'community verdict').toBe('slop');
			decide(f.eng, { sourceRef: src.ref, verdict: 'slop', reason: 'Confirmed.', actor: 'staff' });
			src = f.source('@farm');
			expect(src.state.flags & FLAG_STAFF_REVIEWED).not.toBe(0);
			expect(src.state.rescoreAt).toBe(unix(f.clock + 90 * DAY));
			// A decision is logged even when the verdict stays the same, and even when nothing changes.
			expect(log(f.db, { sourceRef: src.ref, limit: 1 })[0]).toMatchObject({ actor: 'staff', from: 'slop', to: 'slop', reason: 'Confirmed.' });
			decide(f.eng, { sourceRef: src.ref, verdict: 'slop', reason: 'Confirmed again.', actor: 'staff' });
			expect(f.source('@farm').state).toEqual(src.state);
			expect(log(f.db, { sourceRef: src.ref, limit: 1 })[0]).toMatchObject({ actor: 'staff', from: 'slop', to: 'slop', reason: 'Confirmed again.' });

			f.clock += 91 * DAY;
			await f.pass();
			src = f.source('@farm');
			expect(src.state).toMatchObject({ verdict: 'likely_slop', lapseHold: true });
			expect(src.state.flags & FLAG_STAFF_REVIEWED).toBe(0);
			expect(f.escalations().has('lapsed')).toBe(true);
			expect(log(f.db, { sourceRef: src.ref, limit: 1 })[0]!.reason).toContain(
				'Held at Likely slop until staff review it again, because the earlier verdict expired.'
			);
			// The hold stays through later passes, and a new decision lifts it.
			await f.pass();
			expect(f.source('@farm').state.verdict, 'hold did not last').toBe('likely_slop');
			decide(f.eng, { sourceRef: src.ref, verdict: 'slop', reason: 'Still slop.', actor: 'staff' });
			expect(f.source('@farm').state).toMatchObject({ verdict: 'slop', lapseHold: false });
			expect(f.escalations().has('lapsed')).toBe(false);
		}));

	// More than 20 slop tags in an hour from installs younger than 7 days freeze consensus for 72 hours.
	it('freezes consensus on a burst of slop tags from new installs', () =>
		withFixture(async (f) => {
			f.tags(3, '@target', 'ai_fine', true);
			f.highVolume('@target');
			f.clock += 40 * DAY;
			f.tags(25, '@target', 'slop', true);
			f.clock += 10 * MINUTE;
			await f.pass();
			const src = f.source('@target');
			expect(src.frozenUntil).toBe(unix(f.clock + 72 * HOUR));
			expect(f.escalationsOf(src.ref).burst).toBe('Burst of slop tags from new installs: consensus frozen for 72 hours');
			expect(src.state.verdict).not.toBe('slop');
			expect(src.state.signals & Sig.community_consensus).toBe(0);
		}));

	// A denied appeal restores the scored verdict and logs the outcome; the log shows the whole story.
	it('restores the scored verdict when an appeal is denied', () =>
		withFixture(async (f) => {
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY;
			await f.pass();
			const ref = f.source('@farm').ref;
			const a = f.appeal(ref, 'colander-TEST0001');
			verifyAppeal(f.eng, a);
			expect(f.source('@farm').state.verdict, 'verified appeal').toBe('disputed');
			const rae = grantRole(f.db, 'rae@colander.test', 'staff', f.s, { host: 'job' });
			resolveAppeal(f.eng, a, 'denied', 'Twenty generated uploads a day.', rae);
			expect(f.source('@farm').state.verdict, 'denied appeal').toBe('slop');
			const entries = log(f.db, { sourceRef: ref, limit: 10 });
			expect(entries.map((e) => [e.actor, e.from, e.to, e.reason])).toEqual([
				['appeal', 'disputed', 'slop', 'Appeal denied. Twenty generated uploads a day.'],
				['appeal', 'slop', 'disputed', 'The creator verified control of the account and appealed. Shown as Disputed while staff review it.'],
				['community', '', 'slop', expect.stringMatching(/^Slop\. /)]
			]);
		}));

	// An upheld appeal records a Clear decision by the appeal, even on a source curators may not decide.
	it('clears the source when an appeal is upheld', () =>
		withFixture(async (f) => {
			f.tags(8, '@farm', 'slop', true);
			f.highVolume('@farm');
			f.clock += 40 * DAY;
			await f.pass();
			const ref = f.source('@farm').ref;
			const a = f.appeal(ref, 'colander-TEST0004');
			verifyAppeal(f.eng, a);
			const rae = grantRole(f.db, 'rae@colander.test', 'staff', f.s, { host: 'job' });
			resolveAppeal(f.eng, a, 'upheld', 'Original narration on camera.', rae);
			expect(getAppeal(f.db, a.id)).toMatchObject({ status: 'upheld', outcome: 'upheld', reasoning: 'Original narration on camera.' });
			const src = f.source('@farm');
			expect(src.state.verdict).toBe('clear');
			expect(src.state.flags & FLAG_STAFF_REVIEWED).not.toBe(0);
			expect(log(f.db, { sourceRef: ref, limit: 1 })[0]).toMatchObject({
				actor: 'appeal',
				from: 'disputed',
				to: 'clear',
				reason: 'Appeal upheld. Original narration on camera.'
			});
			// A pass keeps the decision.
			await f.pass();
			expect(f.source('@farm').state.verdict).toBe('clear');
		}));

	// An unverified appeal expires after 14 days and never changes the verdict.
	it('expires an unverified appeal after 14 days', () =>
		withFixture(async (f) => {
			f.tags(1, '@x', 'slop', false);
			const ref = f.source('@x').ref;
			const a = f.appeal(ref, 'c');
			f.clock += 15 * DAY;
			await f.pass();
			expect(getAppeal(f.db, a.id)!.status).toBe(AppealExpired);
			expect(f.source('@x').state.verdict).toBe('');
		}));

	// Reputation reads tagging history only: an install with a trial and synced settings weighs
	// exactly what an identical install without them weighs.
	it('ignores plan state in reputation', () =>
		withFixture((f) => {
			const both = f.tags(2, '@farm', 'slop', true);
			startTrial(f.db, both[0]!, 'trl_test', f.s, unix(f.clock + 14 * DAY));
			putSync(f.db, 'trl_test', 0, '{"strictness":"strict"}', f.s);
			const reps = reputation(f.db, 0);
			const [a, b] = [reps.get(both[0]!)!, reps.get(both[1]!)!];
			expect(a, 'paying install').toEqual(b);
			const now = f.clock + 60 * DAY;
			expect(Default.weight(a.firstTagAt * 1000, now, a.agree, a.decided)).toBe(Default.weight(b.firstTagAt * 1000, now, b.agree, b.decided));
		}));

	it('explains a source without writing, with its public evidence', () =>
		withFixture((f) => {
			f.tags(3, '@farm', 'slop', true);
			f.tags(1, '@farm', 'not_slop', false);
			f.tagAs(installs(0, 2), 'yt', 'item', 'abcdefghijk', '@farm', 'ai_fine', true);
			const ref = f.source('@farm').ref;
			const ev = f.eng.explain(ref)!;
			expect(ev.result.provenance.met).toBe(true);
			expect(evidence(ev)).toEqual({ taggers: 4, slop: 3, aiFine: 0, notSlop: 1, itemsSeen: 1, aiItemShare: 1 });
			expect(f.source('@farm').state.computed).toBe('');
			expect(f.eng.explain(9999)).toBeUndefined();
		}));
});

describe('seed lists', () => {
	const entry = clearedEntry();
	const importAll = (f: Fixture, ...aliases: string[]) => {
		f.eng.seeds = new SeedRegistry([entry]);
		listSeed(f.db, entry, aliases, f.s);
	};

	// A seed entry is a review lead and never evidence: alone it gives no list entry, and next to
	// community evidence the verdict is exactly what that evidence gives without it.
	it('never gives a verdict or counts as evidence, and only puts the source in the review queue', () =>
		withFixture(async (f) => {
			importAll(f, '@seedonly', '@seedtagged');
			f.tagAs(installs(0, 6), 'yt', 'source', '@seedtagged', '', 'slop', false);
			f.tagAs(installs(0, 6), 'yt', 'source', '@plaintagged', '', 'slop', false);
			f.clock += 40 * DAY;
			await f.pass();

			const alone = f.source('@seedonly');
			expect(alone.state).toMatchObject({ verdict: '', flags: 0, computed: '' });
			expect(log(f.db, { sourceRef: alone.ref, limit: 10 })).toEqual([]);
			expect(f.escalationsOf(alone.ref), 'the summary names no list: curators see it').toEqual({ seed: 'Seed lead, not evidence' });

			const seeded = f.source('@seedtagged').state;
			const plain = f.source('@plaintagged').state;
			expect(seeded.verdict).toBe('likely_slop');
			expect({ ...seeded, changedAt: 0, rescoreAt: 0 }).toEqual({ ...plain, changedAt: 0, rescoreAt: 0 });
			expect(seeded.flags & (1 << 5), 'flag bit 5 stays 0').toBe(0);
			const reason = log(f.db, { sourceRef: f.source('@seedtagged').ref, limit: 1 })[0]!.reason;
			expect(reason).toBe(log(f.db, { sourceRef: f.source('@plaintagged').ref, limit: 1 })[0]!.reason);
			expect(reason).not.toMatch(/seed|Secret/i);

			// A reviewer's decision uses up the lead.
			decide(f.eng, { sourceRef: alone.ref, verdict: 'none', reason: 'Checked the channel: nothing to rate.', actor: 'staff' });
			await f.pass();
			expect(f.escalationsOf(alone.ref)).toEqual({});
		}));

	// A lead lasts only while its list is cleared in the registry, its entry has not expired and
	// staff have not suppressed seed lists on the source; a fictional dev list counts in dev only.
	it('closes a lead when its list is no longer cleared, its entry expires or staff suppress it', () =>
		withFixture(async (f) => {
			importAll(f, '@one', '@two', '@three');
			await f.pass();
			const refs = ['@one', '@two', '@three'].map((a) => f.source(a).ref);
			expect(refs.map((r) => f.escalationsOf(r))).toEqual(Array(3).fill({ seed: 'Seed lead, not evidence' }));

			setSeedSuppression(f.db, refs[0]!, true, 'Objection under Article 21', f.s);
			f.eng.seeds = new SeedRegistry([{ ...entry, clearance: { status: 'revoked', by: 'slantview', at: '2026-06-02' } }]);
			await f.pass();
			expect(refs.map((r) => f.escalationsOf(r))).toEqual([{}, {}, {}]);
			expect(f.db.all('SELECT alias FROM seed_entries ORDER BY alias'), 'suppression deletes the entries; revocation by deploy waits for the daily job').toEqual([
				{ alias: '@three' },
				{ alias: '@two' }
			]);

			f.eng.seeds = new SeedRegistry([entry]);
			await f.pass();
			expect(refs.map((r) => f.escalationsOf(r))).toEqual([{}, { seed: 'Seed lead, not evidence' }, { seed: 'Seed lead, not evidence' }]);
			f.clock += 365 * DAY;
			await f.pass();
			expect(refs.map((r) => f.escalationsOf(r)), 'listed 365 days ago, the entries expired').toEqual([{}, {}, {}]);

			const demo = { ...entry, id: 'demo', dev_only: true, license: 'LicenseRef-Colander-internal', license_url: null, clearance: { status: 'pending' as const, by: null, at: null } };
			listSeed(f.db, demo, ['@four'], f.s);
			f.eng.seeds = new SeedRegistry([demo], false);
			await f.pass();
			expect(f.escalationsOf(f.source('@four').ref), 'dev data outside dev mode').toEqual({});
			f.eng.seeds = new SeedRegistry([demo], true);
			await f.pass();
			expect(f.escalationsOf(f.source('@four').ref)).toEqual({ seed: 'Seed lead, not evidence' });
		}));

	// Entries the old rules put on the list because of a seed alone come off at the next pass, and
	// imports from before the license check or the registry raise no lead.
	it('takes off the list what a seed alone put there', () =>
		withFixture(async (f) => {
			f.tags(1, '@legacy', 'slop', false);
			const ref = f.source('@legacy').ref;
			f.db.run("UPDATE sources SET import_list = 'blocklist', import_source = 'Secret List', import_license = 'CC BY-NC 4.0', imported_at = 1 WHERE id = ?", ref);
			applyUpdate(f.db, { sourceRef: ref, itemRef: 0, expect: '', state: { ...f.source('@legacy').state, verdict: 'likely_slop', signals: Sig.mostly_ai, flags: 1 << 5, changedAt: 1, rescoreAt: f.s + 90 * 86_400, computed: 'likely_slop' } });
			await f.pass();
			expect(f.source('@legacy').state).toMatchObject({ verdict: '', flags: 0 });
			const [entry] = log(f.db, { sourceRef: ref, limit: 1 });
			expect(entry).toMatchObject({ from: 'likely_slop', to: '', actor: 'community', reason: 'Not rated any more. The remaining evidence does not meet any verdict rule.' });
			expect(f.escalationsOf(ref)).toEqual({});
		}));
});

describe('curator limits', () => {
	// Go's TestCuratorLimitsAndReviewerToken, the part the engine now enforces: curators may decide
	// items and sources that are not large; large sources, a source's size and sources whose appeal
	// the creator has acted on need staff.
	it('keep curators to sources that are not large and have no open appeal', () =>
		withFixture((f) => {
			const curator = (sourceRef: number, over: { itemRef?: number; large?: boolean; verdict?: string } = {}) =>
				decide(f.eng, { sourceRef, verdict: 'slop', reason: 'Generated gossip narration.', signals: Sig.watermark, actor: 'curator', ...over });
			f.tags(1, '@gossipnarrated', 'slop', false);
			const big = f.source('@gossipnarrated').ref;
			setYouTube(f.db, big, { channelId: 'UCzzzzzzzzzzzzzzzzzzzz43', handle: '@gossipnarrated', subscribers: 1_200_000, uploadsPerDay: null }, f.s);
			// Without derived use a subscriber count makes no source large; staff record the size.
			expect(f.eng.audience(f.source('@gossipnarrated'))).toEqual({ large: false, known: false });
			f.eng.derived = true;
			expect(() => curator(big)).toThrow(new StaffRequiredError('Large sources'));
			expect(() => curator(big)).toThrow('Large sources need staff review.');
			// Items of a large source are open to curators.
			f.tagAs(installs(0, 1), 'yt', 'item', 'abcdefghijk', '@gossipnarrated', 'slop', false);
			curator(big, { itemRef: findItem(f.db, 'yt', 'abcdefghijk')!.ref });
			decide(f.eng, { sourceRef: big, verdict: 'slop', reason: 'Generated gossip narration.', signals: Sig.watermark, actor: 'staff' });
			expect(f.source('@gossipnarrated').state.verdict).toBe('slop');

			f.tags(1, '@smallslopfarm', 'slop', false);
			const small = f.source('@smallslopfarm').ref;
			expect(() => curator(small, { large: false })).toThrow(new StaffRequiredError('Large sources'));
			curator(small);
			expect(f.source('@smallslopfarm').state.verdict).toBe('slop');

			// An appeal awaiting verification is unproven, so curators may still decide. Once the creator
			// has done their part (pending_manual, then under_review) only staff decide the source.
			const a = f.appeal(small, 'colander-TEST0005');
			curator(small);
			transitionAppeal(f.db, a.id, [AppealAwaiting], AppealPendingManual, {});
			const clear = { verdict: 'clear' };
			expect(() => curator(small, clear)).toThrow('Sources with an open appeal need staff review.');
			verifyAppeal(f.eng, getAppeal(f.db, a.id)!);
			expect(getAppeal(f.db, a.id)!.status).toBe(AppealUnderReview);
			expect(() => curator(small, clear)).toThrow(new StaffRequiredError('Sources with an open appeal'));
			const decisions = f.db.get<{ n: number }>('SELECT count(*) AS n FROM decisions WHERE source_id = ?', small)!.n;
			decide(f.eng, { sourceRef: small, verdict: 'clear', reason: 'Original work.', actor: 'staff' });
			expect(f.db.get<{ n: number }>('SELECT count(*) AS n FROM decisions WHERE source_id = ?', small)!.n).toBe(decisions + 1);
		}));
});

describe('jobs', () => {
	// The primary Store runs the jobs; its clock is set far ahead so no alarm fires on its own.
	const stub = env.STORE.getByName('primary');
	const T = 1_900_000_000_000;

	/** Runs fn in the primary Store with its clock at time. */
	const at = <R>(time: number, fn: (f: Fixture, state: DurableObjectState) => R | Promise<R>): Promise<R> =>
		runInDurableObject(stub, (store: Store, state) => fn(new Fixture(store, time), state));

	/** Runs the alarm with the clock at time. */
	async function alarm(time: number): Promise<void> {
		await at(time, () => {});
		await runDurableObjectAlarm(stub);
	}

	const jobNames = (f: Fixture) => f.db.all<{ name: string }>('SELECT name FROM jobs ORDER BY name').map((r) => r.name);

	afterEach(async () => {
		await runInDurableObject(stub, async (store: Store, state) => {
			store.db.run('DELETE FROM jobs');
			for (const key of Object.values(STATUS)) state.storage.kv.delete(key);
			await state.storage.deleteAlarm();
		});
		await evictDurableObject(stub);
		await env.LISTS.delete(SNAPSHOT_KEY);
	});

	// Go's TestRunRescoresTouchedSources: three open reports raise an escalation without waiting
	// for the next full pass.
	it('rescore touched sources after the debounce', async () => {
		const ref = await at(T, async (f) => {
			expect(f.store.jobs.kinds()).toEqual(['audit', 'dump', 'pass', 'prune', 'publish', 'requests', 'rescore', 'seeds']);
			let ref = 0;
			for (let i = 0; i < 3; i++) {
				const input = { installHash: `i${i}`, clientId: 'r', platform: 'yt', sourceId: '@reported', sourceName: '', examples: [] };
				ref = createReport(f.db, { ...input, reason: 'Generated narration.', slopType: '', tests: 0, extVersion: '' }, f.s).report.sourceRef;
				f.store.jobs.touch([ref], T);
			}
			await f.store.jobs.arm();
			return ref;
		});
		const reports = () => at(T, (f) => f.escalationsOf(ref).reports);
		await alarm(T + DEBOUNCE - 1);
		expect(await reports()).toBeUndefined();
		await alarm(T + DEBOUNCE);
		expect(await reports()).toBe('3 or more open reports');
		expect(await at(T, jobNames)).not.toContain(`rescore:${ref}`);
	});

	// A pass spans alarm turns, so a reviewer decision can land between two of its chunks. The
	// decision commits with its log entry and asks for a publication at once, and the rest of the
	// pass keeps it: no second log entry and no other verdict.
	it('take a reviewer decision between two chunks of a pass', async () => {
		const T0 = T - 40 * DAY;
		const { early, late } = await at(T0, async (f) => {
			f.tags(8, '@early', 'slop', true);
			f.highVolume('@early');
			f.db.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO sources (platform, canonical_id, created_at) SELECT 'tt', '@filler' || i, 1 FROM n`,
				PASS_CHUNK
			);
			f.tags(8, '@late', 'slop', true);
			f.highVolume('@late', 'UCzzzzzzzzzzzzzzzzzzzzz2');
			f.store.jobs.schedule('pass', T);
			await f.store.jobs.arm();
			return { early: f.source('@early').ref, late: f.source('@late').ref };
		});

		await alarm(T);
		await at(T, (f, state) => {
			expect(state.storage.kv.get(STATUS.passProgress), 'the pass is between chunks').toBeDefined();
			expect(getSource(f.db, early)!.state.verdict).toBe('slop');
			expect(getSource(f.db, late)!.state.verdict, 'not reached yet').toBe('');
			expect(jobNames(f)).toEqual(['pass']);
			decide(f.eng, { sourceRef: late, verdict: 'clear', reason: 'Original footage, checked by staff.', actor: 'staff', actorName: 'Rae' });
			expect(getSource(f.db, late)!.state.verdict).toBe('clear');
			expect(jobNames(f), 'the decision asks for a publication').toEqual(['pass', 'publish']);
		});

		await alarm(T + 1000);
		await at(T + 1000, (f, state) => {
			const status = state.storage.kv.get<PassStatus>(STATUS.pass)!;
			expect(status.sources).toBeGreaterThanOrEqual(PASS_CHUNK + 2);
			expect(state.storage.kv.get(STATUS.passProgress)).toBeUndefined();
			const lateSrc = getSource(f.db, late)!;
			expect(lateSrc.state.verdict).toBe('clear');
			expect(lateSrc.state.flags & FLAG_STAFF_REVIEWED).not.toBe(0);
			expect(log(f.db, { sourceRef: late, limit: 10 }).map((e) => [e.actor, e.actorName, e.from, e.to])).toEqual([['staff', 'Rae', '', 'clear']]);
			expect(log(f.db, { sourceRef: early, limit: 10 }).map((e) => [e.actor, e.from, e.to])).toEqual([['community', '', 'slop']]);
		});
	});
});
