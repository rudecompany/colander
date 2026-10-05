// The data layer (src/store/*.ts): the port of server/internal/store/store_test.go plus the
// behavior of each ported file, run against the real Store SQLite inside workerd.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as accounts from '../src/store/accounts';
import * as appeals from '../src/store/appeals';
import * as billing from '../src/store/billing';
import { ConflictError, newId, NotFoundError, type Db } from '../src/store/db';
import * as list from '../src/store/list';
import * as misc from '../src/store/misc';
import * as sources from '../src/store/sources';
import * as tags from '../src/store/tags';
import { clearedEntry, listSeed } from './seed-fixtures';
import * as verdicts from '../src/store/verdicts';
import type { Store } from '../src/store/store';

/** Runs fn against the database of a fresh Store object (one name per test keeps them apart). */
let n = 0;
const withDb = <T>(fn: (db: Db) => T): Promise<T> => runInDurableObject(env.STORE.getByName(`data-${++n}`), (store: Store) => fn(store.db));

const tag = (over: Partial<tags.TagInput>): tags.TagInput => ({
	clientId: 'c1',
	platform: 'yt',
	targetType: 'source',
	targetId: '@chan',
	sourceId: '@chan',
	verdict: 'slop',
	slopType: '',
	tests: 0,
	platformLabel: false,
	createdAt: 1,
	extVersion: '1.0.0',
	...over
});

const state = (over: Partial<sources.State> = {}): sources.State => ({
	verdict: 'slop',
	signals: 0,
	detail: 0,
	flags: 0,
	changedAt: 10,
	rescoreAt: 0,
	lapseHold: false,
	computed: '',
	mixed: false,
	...over
});

const logEntry = (over: Partial<verdicts.LogEntry> = {}): verdicts.LogEntry => ({
	id: 0,
	at: 10,
	platform: 'yt',
	targetType: 'source',
	targetId: '@chan',
	sourceRef: 0,
	sourceKey: '@chan',
	sourceName: '',
	from: '',
	to: 'slop',
	reason: 'Community consensus.',
	signals: 0,
	actor: 'community',
	actorName: '',
	...over
});

describe('store.go', () => {
	it('makes IDs of the prefix and 16 characters from the Go alphabet', () => {
		const ids = new Set(Array.from({ length: 200 }, () => newId('rpt')));
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id).toMatch(/^rpt_[a-km-np-z2-9]{16}$/);
	});
});

describe('sources.go', () => {
	// Go's TestMigrateAndMerge (the reopen half is in store.test.ts): a YouTube lookup that links a
	// handle to a channel ID folds the two sources into the older one.
	it('merges a handle and a channel ID into the older source', async () => {
		await withDb((db) => {
			const byHandle = sources.ensureSource(db, 'yt', '@ancientwondersdaily', 'Ancient Wonders Daily AI', 1);
			const channel = 'UCzzzzzzzzzzzzzzzzzzzzz1';
			const byId = sources.ensureSource(db, 'yt', channel, '', 1);
			tags.saveTags(db, 'h1', [tag({ targetId: channel, sourceId: channel })], 1);
			const keep = sources.setYouTube(db, byId, { channelId: channel, handle: '@AncientWondersDaily', subscribers: null, uploadsPerDay: null }, 2);
			expect(keep).toBe(byHandle);
			const src = sources.getSource(db, keep)!;
			expect(src.aliases).toEqual([channel, '@ancientwondersdaily']);
			expect(src.name).toBe('Ancient Wonders Daily AI');
			expect(src.youtubeCheckedAt).toBe(2);
			expect(verdicts.loadSourceData(db, keep, 2)!.votes).toHaveLength(1);
			expect(sources.getSource(db, byId)).toBeUndefined();
		});
	});

	it('fills a missing name but never replaces one, and finds sources by alias', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'tt', '@pets', '', 1);
			expect(sources.ensureSource(db, 'tt', '@pets', 'Pets', 2)).toBe(ref);
			sources.ensureSource(db, 'tt', '@pets', 'Other', 3);
			expect(sources.getSource(db, ref)!.name).toBe('Pets');
			expect(sources.findSource(db, 'tt', '@pets')).toBe(ref);
			expect(sources.findSource(db, 'yt', '@pets')).toBeUndefined();
			expect(sources.sourceRefs(db)).toEqual([ref]);
		});
	});

	it('keeps an item on its first source unless it was first seen without one', async () => {
		await withDb((db) => {
			const a = sources.ensureSource(db, 'ig', 'alpha', '', 1);
			const b = sources.ensureSource(db, 'ig', 'beta', '', 1);
			const none = sources.ensureSource(db, 'ig', '', '', 1);
			const item = sources.ensureItem(db, 'ig', 'Cabc123', a, 1);
			expect(sources.ensureItem(db, 'ig', 'Cabc123', b, 2)).toBe(item);
			expect(sources.findItem(db, 'ig', 'Cabc123')!.sourceRef).toBe(a);
			// Tagged where the card shows no source, then by a tag that names one.
			tags.saveTags(db, 'h1', [tag({ platform: 'ig', targetType: 'item', targetId: 'Cxyz789', sourceId: '' })], 1);
			expect(sources.findItem(db, 'ig', 'Cxyz789')!.sourceRef).toBe(none);
			tags.saveTags(db, 'h2', [tag({ platform: 'ig', targetType: 'item', targetId: 'Cxyz789', sourceId: 'beta', clientId: 'c2' })], 2);
			expect(sources.findItem(db, 'ig', 'Cxyz789')!.sourceRef).toBe(b);
			expect(verdicts.loadSourceData(db, b, 2)!.votes.map((v) => v.install).sort()).toEqual(['h1', 'h2']);
			expect(sources.itemsBySource(db, b).map((i) => i.itemId)).toEqual(['Cxyz789']);
		});
	});

	it('lists seed entries per list, moves them with a merge, and lists stale YouTube sources oldest first', async () => {
		await withDb((db) => {
			const a = clearedEntry({ id: 'list-a', name: 'List A' });
			const b = clearedEntry({ id: 'list-b', name: 'List B', license: 'MIT', license_url: 'https://opensource.org/license/mit', attribution: 'Credit' });
			listSeed(db, a, ['@seeded'], 5, 5);
			listSeed(db, b, ['@seeded'], 6, 6);
			const ref = sources.findSource(db, 'yt', '@seeded')!;
			expect(db.all('SELECT seed, alias, source_id, listed_at FROM seed_entries ORDER BY seed')).toEqual([
				{ seed: 'list-a', alias: '@seeded', source_id: ref, listed_at: 5 },
				{ seed: 'list-b', alias: '@seeded', source_id: ref, listed_at: 6 }
			]);
			expect(db.all('SELECT seed, source_name, license, attribution, list, entries FROM seed_imports ORDER BY id')).toEqual([
				{ seed: 'list-a', source_name: 'List A', license: 'CC0-1.0', attribution: null, list: 'lead', entries: 1 },
				{ seed: 'list-b', source_name: 'List B', license: 'MIT', attribution: 'Credit', list: 'lead', entries: 1 }
			]);
			// A lookup that finds the channel ID of another source folds the newer one in, entries too.
			const byId = sources.ensureSource(db, 'yt', 'UCzzzzzzzzzzzzzzzzzzzzz7', '', 7);
			db.run('UPDATE sources SET seed_suppressed_at = 9, seed_suppress_reason = ? WHERE id = ?', 'Objection', byId);
			expect(sources.setYouTube(db, byId, { channelId: 'UCzzzzzzzzzzzzzzzzzzzzz7', handle: '@seeded', subscribers: null, uploadsPerDay: null }, 8)).toBe(ref);
			expect(sources.getSource(db, ref)).toMatchObject({ seedSuppressedAt: 9, seedSuppressReason: 'Objection' });
			expect(db.all('SELECT seed FROM seed_entries'), 'a suppression on either half holds for the channel').toEqual([]);
			const other = sources.ensureSource(db, 'yt', '@other', '', 1);
			sources.markYouTubeChecked(db, other, 50);
			sources.ensureSource(db, 'yt', '', '', 1); // the unattributed holder is never looked up
			expect(sources.youTubeStale(db, 100, 10).map((s) => s.ref)).toEqual([ref, other]);
			expect(sources.youTubeStale(db, 40, 10).map((s) => s.ref)).toEqual([ref]);
			sources.setFrozen(db, ref, 99);
			expect(sources.getSource(db, ref)!.frozenUntil).toBe(99);
			expect(sources.sourceRefsAfter(db, ref, 1)).toEqual([other]);
		});
	});
});

describe('tags.go', () => {
	it('keeps the latest tag per install and target, and ignores replays and older tags', async () => {
		await withDb((db) => {
			const refs = tags.saveTags(db, 'h1', [tag({ clientId: 'c1', verdict: 'slop', createdAt: 10 })], 100);
			expect(refs).toHaveLength(1);
			const verdict = () => verdicts.loadSourceData(db, refs[0]!, 0)!.votes.map((v) => [v.verdict, v.receivedAt]);
			tags.saveTags(db, 'h1', [tag({ clientId: 'c1', verdict: 'not_slop', createdAt: 20 })], 101);
			expect(verdict()).toEqual([['slop', 100]]);
			tags.saveTags(db, 'h1', [tag({ clientId: 'c0', verdict: 'not_slop', createdAt: 5 })], 102);
			expect(verdict()).toEqual([['slop', 100]]);
			tags.saveTags(db, 'h1', [tag({ clientId: 'c2', verdict: 'ai_fine', createdAt: 30, platformLabel: true })], 103);
			expect(verdict()).toEqual([['ai_fine', 103]]);
			expect(db.get('SELECT first_tag_at FROM installs WHERE hash = ?', 'h1')).toEqual({ first_tag_at: 100 });
		});
	});

	it('creates a report once per client id and lists them newest first', async () => {
		await withDb((db) => {
			const input: tags.ReportInput = {
				installHash: 'h1',
				clientId: 'r1',
				platform: 'yt',
				sourceId: '@spam',
				sourceName: 'Spam',
				examples: ['dQw4w9WgXcQ'],
				reason: 'Forty AI videos a day.',
				slopType: 'filler',
				tests: 8,
				extVersion: '1.0.0'
			};
			const first = tags.createReport(db, input, 10);
			expect(first.created).toBe(true);
			expect(first.report).toMatchObject({ reportedId: '@spam', sourceName: 'Spam', examples: ['dQw4w9WgXcQ'], status: 'open', tests: 8 });
			const again = tags.createReport(db, { ...input, reason: 'changed' }, 11);
			expect(again).toEqual({ report: first.report, created: false });
			const second = tags.createReport(db, { ...input, clientId: 'r2', examples: null }, 12).report;
			expect(second.examples).toBeNull();
			expect(tags.reportsByInstall(db, 'h1').map((r) => r.id)).toEqual([second.id, first.report.id]);
			expect(tags.openReports(db).map((r) => r.id)).toEqual([first.report.id, second.id]);
			tags.dismissReport(db, first.report.id, 'Not slop.', 20);
			expect(tags.getReport(db, first.report.id)).toMatchObject({ status: 'dismissed', closeReason: 'Not slop.', updatedAt: 20 });
			expect(() => tags.dismissReport(db, first.report.id, 'again', 21)).toThrow(ConflictError);
			expect(() => tags.dismissReport(db, 'rpt_missing', 'x', 21)).toThrow(NotFoundError);
			expect(tags.reportsBySource(db, first.report.sourceRef).map((r) => r.id)).toEqual([second.id, first.report.id]);
		});
	});
});

describe('verdicts.go', () => {
	it('applies an update only from the expected verdict, logs it and closes the reports', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'yt', '@chan', 'Chan', 1);
			tags.createReport(db, { installHash: 'h1', clientId: 'r', platform: 'yt', sourceId: '@chan', sourceName: '', examples: [], reason: 'x', slopType: '', tests: 0, extVersion: '' }, 1);
			const u = { sourceRef: ref, itemRef: 0, expect: 'ai_made', state: state({ mixed: true }), log: logEntry({ sourceRef: ref }) };
			expect(verdicts.applyUpdate(db, u)).toBe(false);
			expect(verdicts.applyUpdate(db, { ...u, expect: '' })).toBe(true);
			const src = sources.getSource(db, ref)!;
			expect(src.state).toEqual(state({ mixed: true }));
			expect(tags.reportsBySource(db, ref)[0]).toMatchObject({ status: 'decided', verdict: 'slop', closeReason: 'Community consensus.' });
			expect(verdicts.log(db, { limit: 10 })).toMatchObject([{ to: 'slop', from: '', sourceRef: ref, actor: 'community' }]);
			expect(verdicts.applyUpdate(db, { ...u, sourceRef: 999, expect: '' })).toBe(false);
		});
	});

	it('pages the decision log newest first and filters it', async () => {
		await withDb((db) => {
			for (let i = 1; i <= 5; i++) {
				verdicts.applyUpdate(db, {
					sourceRef: sources.ensureSource(db, i % 2 ? 'yt' : 'tt', `@c${i}`, '', 1),
					itemRef: 0,
					expect: '',
					state: state({ verdict: i === 5 ? 'clear' : 'slop' }),
					log: logEntry({ platform: i % 2 ? 'yt' : 'tt', at: i, to: i === 5 ? 'clear' : 'slop' })
				});
			}
			const page = verdicts.log(db, { limit: 2 });
			expect(page.map((e) => e.at)).toEqual([5, 4]);
			expect(verdicts.log(db, { before: page[1]!.id, limit: 50 }).map((e) => e.at)).toEqual([3, 2, 1]);
			expect(verdicts.log(db, { platform: 'tt', limit: 50 }).map((e) => e.at)).toEqual([4, 2]);
			expect(verdicts.log(db, { verdict: 'clear', limit: 0 }).map((e) => e.at)).toEqual([5]);
			expect(misc.logCountSince(db, 3)).toBe(3);
		});
	});

	it('records decisions: reviewed, size, reports and escalations closed, curator decisions voided', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'yt', '@chan', '', 1);
			const item = sources.ensureItem(db, 'yt', 'dQw4w9WgXcQ', ref, 1);
			verdicts.syncEscalations(db, ref, 0, [], { capped: 'Capped', reports: '3 reports' }, 5);
			verdicts.syncEscalations(db, ref, item, [], { lapsed: 'Lapsed' }, 5);
			tags.createReport(db, { installHash: 'h', clientId: 'r', platform: 'yt', sourceId: '@chan', sourceName: '', examples: [], reason: 'x', slopType: '', tests: 0, extVersion: '' }, 1);
			const base = { sourceRef: ref, itemRef: 0, verdict: 'none', reason: 'Fine.', signals: 0, detail: 0, actor: 'curator', accountId: '', actorName: 'Cur', createdAt: 10, expiresAt: 1000 };
			verdicts.addDecision(db, base, true);
			const src = sources.getSource(db, ref)!;
			expect([src.reviewedAt, src.largeStaff, src.sizeReviewedAt]).toEqual([10, true, 10]);
			expect(tags.reportsBySource(db, ref)[0]).toMatchObject({ status: 'dismissed', verdict: '' });
			expect(verdicts.openEscalations(db).map((e) => e.kind)).toEqual(['lapsed']);
			verdicts.addDecision(db, { ...base, itemRef: item, verdict: 'slop', createdAt: 11 });
			expect(verdicts.openEscalations(db)).toEqual([]);
			expect(verdicts.latestDecisions(db, ref).map((d) => [d.itemRef, d.verdict])).toEqual([[0, 'none'], [item, 'slop']]);
			expect([...verdicts.loadSourceData(db, ref, 20)!.decisions.keys()].sort()).toEqual([0, item]);
			// A later curator decision is voided; reviewed_at falls back to the one still standing.
			verdicts.addDecision(db, { ...base, verdict: 'slop', createdAt: 30, actor: 'staff' });
			verdicts.addDecision(db, { ...base, verdict: 'clear', createdAt: 40 });
			verdicts.voidCuratorDecisions(db, ref, 35, 50);
			expect(sources.getSource(db, ref)!.reviewedAt).toBe(30);
			expect(verdicts.loadSourceData(db, ref, 50)!.decisions.get(0)!.verdict).toBe('slop');
		});
	});

	it('syncs only the managed escalation kinds of one target', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'yt', '@chan', '', 1);
			verdicts.syncEscalations(db, ref, 0, ['capped'], { capped: 'Capped', burst: 'Burst' }, 1);
			verdicts.syncEscalations(db, ref, 0, ['capped'], {}, 2);
			expect(verdicts.openEscalations(db).map((e) => e.kind)).toEqual(['burst']);
			verdicts.syncEscalations(db, ref, 0, ['capped', 'burst'], { burst: 'Burst again' }, 3);
			expect(verdicts.openEscalations(db)).toMatchObject([{ kind: 'burst', summary: 'Burst', createdAt: 1 }]);
		});
	});

	it('counts reputation from decided targets, where an item without a verdict holds its source', async () => {
		await withDb((db) => {
			const staff = sources.ensureSource(db, 'yt', '@staff', '', 1);
			const consensus = sources.ensureSource(db, 'yt', '@consensus', '', 1);
			const aiMade = sources.ensureSource(db, 'yt', '@aimade', '', 1);
			sources.ensureSource(db, 'yt', '@other', '', 1);
			tags.saveTags(db, 'a', [tag({ targetId: '@staff', sourceId: '@staff', clientId: 'a1' }), tag({ targetType: 'item', targetId: 'item0000001', sourceId: '@consensus', clientId: 'a2' })], 5);
			tags.saveTags(db, 'b', [tag({ targetId: '@aimade', sourceId: '@aimade', clientId: 'b1', verdict: 'not_slop' }), tag({ targetId: '@other', sourceId: '@other', clientId: 'b2' })], 6);
			verdicts.applyUpdate(db, { sourceRef: staff, itemRef: 0, expect: '', state: state({ verdict: 'clear', flags: 64 }) });
			verdicts.applyUpdate(db, { sourceRef: consensus, itemRef: 0, expect: '', state: state({ verdict: 'likely_slop', signals: 4096 }) });
			verdicts.applyUpdate(db, { sourceRef: aiMade, itemRef: 0, expect: '', state: state({ verdict: 'ai_made', signals: 4096 }) });
			const reps = verdicts.reputation(db, 0);
			expect(reps.get('a')).toEqual({ firstTagAt: 5, decided: 2, agree: 1 });
			expect(reps.get('b')).toEqual({ firstTagAt: 6, decided: 0, agree: 0 });
			expect([...verdicts.reputation(db, aiMade).keys()]).toEqual(['b']);
		});
	});
});

describe('appeals.go', () => {
	it('transitions only from the given statuses, expires unverified ones and reports the median', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'yt', '@chan', 'Chan', 1);
			const make = (createdAt: number) =>
				appeals.createAppeal(db, { platform: 'yt', sourceRef: ref, email: 'c@example.com', statement: 'Human-made.', code: 'colander-AAAA', secretHash: 'h', createdAt });
			const a = make(0);
			expect(a).toMatchObject({ status: 'awaiting_verification', sourceId: '@chan', sourceName: 'Chan', verifiedAt: 0 });
			appeals.transitionAppeal(db, a.id, [appeals.AppealAwaiting], appeals.AppealUnderReview, { verifiedAt: 5 });
			expect(() => appeals.transitionAppeal(db, a.id, [appeals.AppealAwaiting], appeals.AppealUnderReview, {})).toThrow(ConflictError);
			expect(() => appeals.transitionAppeal(db, 'apl_none', [appeals.AppealAwaiting], appeals.AppealUnderReview, {})).toThrow(NotFoundError);
			appeals.transitionAppeal(db, a.id, [appeals.AppealUnderReview], appeals.AppealUpheld, { resolvedAt: 86400, outcome: 'upheld', reasoning: 'Ok.' });
			expect(appeals.getAppeal(db, a.id)).toMatchObject({ status: 'upheld', verifiedAt: 5, resolvedAt: 86400, outcome: 'upheld' });
			const b = make(100);
			appeals.transitionAppeal(db, b.id, [appeals.AppealAwaiting], appeals.AppealDenied, { resolvedAt: 100 + 3 * 86400 });
			expect(appeals.appealStats(db)).toEqual({ open: 0, medianDays: 2 });
			const c = make(200);
			make(10_000);
			expect(appeals.expireAppeals(db, 1000, 2000)).toEqual([ref]);
			expect(appeals.getAppeal(db, c.id)).toMatchObject({ status: 'expired', resolvedAt: 2000 });
			expect(appeals.appealsWithStatus(db, appeals.AppealAwaiting).map((x) => x.createdAt)).toEqual([10_000]);
			expect(appeals.appealsBySource(db, ref).map((x) => x.createdAt)).toEqual([10_000, 200, 100, 0]);
			expect(appeals.appealStats(db).open).toBe(1);
		});
	});

	it('has no median before an appeal is decided', async () => {
		expect(await withDb((db) => appeals.appealStats(db))).toEqual({ open: 0, medianDays: null });
	});
});

describe('accounts.go', () => {
	it('signs in once per magic link, creating the account, and keeps sessions until they expire', async () => {
		await withDb((db) => {
			accounts.createMagicLink(db, 'tok', 'sam@example.com', '/account', 100, 200);
			accounts.createMagicLink(db, 'old', 'sam@example.com', '/', 50, 99);
			const acct = accounts.useMagicLink(db, 'tok', 150)!;
			expect(acct).toMatchObject({ email: 'sam@example.com', role: 'member', displayName: '', createdAt: 150 });
			expect(accounts.useMagicLink(db, 'tok', 151)).toBeUndefined();
			expect(accounts.useMagicLink(db, 'old', 151)).toBeUndefined();
			// Signing in dropped the expired link.
			expect(db.all('SELECT token_hash FROM magic_links')).toEqual([{ token_hash: 'tok' }]);
			accounts.createMagicLink(db, 'late', 'sam@example.com', '/', 300, 400);
			expect(accounts.useMagicLink(db, 'late', 400)).toBeUndefined();

			accounts.createSession(db, 's1', acct.id, 150, 300);
			expect(accounts.sessionAccount(db, 's1', 299)!.id).toBe(acct.id);
			expect(accounts.sessionAccount(db, 's1', 300)).toBeUndefined();
			accounts.createSession(db, 's2', acct.id, 300, 600);
			expect(db.all('SELECT token_hash FROM sessions')).toEqual([{ token_hash: 's2' }]);
			accounts.deleteSession(db, 's2');
			expect(accounts.sessionAccount(db, 's2', 301)).toBeUndefined();
		});
	});

	it('grants roles, names accounts and replaces reviewer tokens', async () => {
		await withDb((db) => {
			const staff = accounts.grantRole(db, 'rae@example.com', 'staff', 5);
			expect(staff).toMatchObject({ email: 'rae@example.com', role: 'staff', createdAt: 5 });
			expect(accounts.grantRole(db, 'rae@example.com', 'curator', 6)).toMatchObject({ id: staff.id, role: 'curator', createdAt: 5 });
			accounts.setDisplayName(db, staff.id, 'Rae');
			expect(accounts.getAccount(db, staff.id)!.displayName).toBe('Rae');
			accounts.setDisplayName(db, staff.id, '');
			expect(db.get('SELECT display_name FROM accounts')).toEqual({ display_name: null });
			accounts.setReviewerToken(db, staff.id, 'r1', 1);
			accounts.setReviewerToken(db, staff.id, 'r2', 2);
			expect(accounts.reviewerAccount(db, 'r1')).toBeUndefined();
			expect(accounts.reviewerAccount(db, 'r2')!.email).toBe('rae@example.com');
			expect(accounts.accountByEmail(db, 'nobody@example.com')).toBeUndefined();
		});
	});
});

describe('misc.go', () => {
	it('serves the newest adapter config, one trial per install and compare-and-set sync', async () => {
		await withDb((db) => {
			expect(misc.latestAdapterConfig(db)).toBeUndefined();
			misc.saveAdapterConfig(db, 7, '{"v":7}', 1);
			misc.saveAdapterConfig(db, 8, '{"v":8}', 2);
			expect(misc.latestAdapterConfig(db)).toBe('{"v":8}');

			misc.startTrial(db, 'h1', 'trial_1', 10, 20);
			expect(() => misc.startTrial(db, 'h1', 'trial_2', 11, 21)).toThrow(ConflictError);

			expect(misc.getSync(db, 'acc_1')).toEqual({ version: 0, data: '', updatedAt: 0 });
			expect(misc.putSync(db, 'acc_1', 0, '{"a":1}', 5)).toEqual({ blob: { version: 1, data: '{"a":1}', updatedAt: 5 }, conflict: false });
			expect(misc.putSync(db, 'acc_1', 0, '{"a":2}', 6)).toEqual({ blob: { version: 1, data: '{"a":1}', updatedAt: 5 }, conflict: true });
			expect(misc.putSync(db, 'acc_1', 1, '{"a":3}', 7).blob.version).toBe(2);
		});
	});

	it('counts rated sources and items', async () => {
		await withDb((db) => {
			const ref = sources.ensureSource(db, 'yt', '@a', '', 1);
			sources.ensureSource(db, 'yt', '@b', '', 1);
			verdicts.applyUpdate(db, { sourceRef: ref, itemRef: 0, expect: '', state: state({ verdict: 'disputed' }) });
			const item = sources.ensureItem(db, 'yt', 'dQw4w9WgXcQ', ref, 1);
			verdicts.applyUpdate(db, { sourceRef: ref, itemRef: item, expect: '', state: state() });
			expect(misc.verdictCounts(db)).toEqual({ counts: { slop: 0, likely_slop: 0, ai_made: 0, disputed: 1, clear: 0 }, items: 1 });
		});
	});
});

describe('list.go', () => {
	it('adds, sets and sums list requests per hour, pruning week-old buckets', async () => {
		await withDb((db) => {
			list.addListRequests(db, 1000, 5);
			list.addListRequests(db, 1000, 7);
			expect(list.listRequestsSince(db, 1000)).toBe(12);
			list.setListRequests(db, 1000, 3);
			list.setListRequests(db, 1001, 4);
			expect(list.listRequestsSince(db, 1000)).toBe(7);
			list.addListRequests(db, 1000 + 24 * 7 + 1, 1);
			expect(db.all('SELECT hour FROM list_requests ORDER BY hour')).toEqual([{ hour: 1001 }, { hour: 1169 }]);
		});
	});
});

describe('billing tables', () => {
	it('picks the live subscription, stores payments and refunds, and lists credited donors once', async () => {
		await withDb((db) => {
			const acct = accounts.grantRole(db, 'pay@example.com', 'member', 1);
			const sub = { accountId: acct.id, customerId: 'cus_1', status: 'canceled', interval: 'month', periodStart: 0, periodEnd: 100, ending: false, startDate: 0 };
			expect(billing.saveSubscription(db, { ...sub, id: 'sub_old' }, 1)).toBe(true);
			expect(billing.saveSubscription(db, { ...sub, id: 'sub_x', accountId: 'acc_missing' }, 1)).toBe(false);
			expect(billing.current(db, acct.id)!.id).toBe('sub_old');
			billing.saveSubscription(db, { ...sub, id: 'sub_new', status: 'active', periodStart: 100, periodEnd: 50, ending: true }, 2);
			expect(billing.current(db, acct.id)).toMatchObject({ id: 'sub_new', cancelAtPeriodEnd: true, latestPayment: '' });
			billing.recordPayment(db, 'sub_new', 'pi_2', 20);
			billing.recordPayment(db, 'sub_new', 'pi_1', 10);
			expect(billing.current(db, acct.id)).toMatchObject({ latestPayment: 'pi_2', latestPaidAt: 20 });

			const don = { amountCents: 500, currency: 'usd', recurring: false, payment: '', subscriptionId: '', createdAt: 0 };
			billing.saveDonation(db, { ...don, id: 'cs_1', creditName: 'Ada', payment: 'pi_d1', createdAt: 10 });
			billing.saveDonation(db, { ...don, id: 'cs_2', creditName: 'Ada', createdAt: 20 });
			billing.saveDonation(db, { ...don, id: 'cs_3', creditName: 'Bo', createdAt: 30 });
			billing.saveDonation(db, { ...don, id: 'cs_4', creditName: '', createdAt: 40 });
			billing.saveDonation(db, { ...don, id: 'cs_3', creditName: 'Changed', createdAt: 50 });
			expect(billing.supporters(db)).toEqual([{ name: 'Bo', since: 30 }, { name: 'Ada', since: 10 }]);
			billing.markRefunded(db, 'pi_2', 'pi_d1', 60);
			expect(billing.current(db, acct.id)!.refundedAt).toBe(60);
			expect(billing.supporters(db)).toEqual([{ name: 'Bo', since: 30 }, { name: 'Ada', since: 20 }]);

			expect(billing.billingEventSeen(db, 'evt_1')).toBe(false);
			billing.recordBillingEvent(db, 'evt_1', 'invoice.paid', 1);
			billing.recordBillingEvent(db, 'evt_1', 'invoice.paid', 2);
			expect(billing.billingEventSeen(db, 'evt_1')).toBe(true);
		});
	});
});
