// Seed lists beyond the import (src/seeds.ts, src/store/seeds.ts, src/store/calibration.ts): the
// list formats, revocation, the daily seeds job, and the calibration sampling and export commands.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import type { SeedEntry } from '@colander/shared/seeds';
import { nextSeeds, seedsJob } from '../src/jobs';
import { storeOps } from '../src/ops';
import { CALIBRATION_PREFIX, parseSeed, SEED_PREFIX } from '../src/seeds';
import { addCalibrationItems, addLabel, CALIBRATION_RETENTION, pruneCalibration } from '../src/store/calibration';
import { SeedRegistry } from '../src/store/seeds';
import { ensureSource, findSource, sourceRefs } from '../src/store/sources';
import { saveTags } from '../src/store/tags';
import type { Store } from '../src/store/store';
import { clearedEntry, listSeed } from './seed-fixtures';

const T = Date.UTC(2026, 9, 5, 12);
const S = T / 1000;
const DAY = 86_400;
let n = 0;

/** A fresh Store with this registry and clock. */
const withStore = <R>(entries: SeedEntry[], fn: (store: Store, state: DurableObjectState) => R | Promise<R>) =>
	runInDurableObject(env.STORE.getByName(`seeds-${++n}`), (store: Store, state) => {
		store.now = () => T;
		store.engine.seeds = new SeedRegistry(entries);
		return fn(store, state);
	});

const op = (store: Store, state: DurableObjectState, command: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> =>
	storeOps(store, state, env, command, args);

describe('list formats', () => {
	it("reads lines as Go's import-seed did, ignoring comments and notes after the ID", () => {
		const e = clearedEntry();
		// A byte order mark stays, so that line is skipped; U+0085 and wide spaces are trimmed.
		const parsed = parseSeed(e, '﻿@BomFirst\n@NelChannel\u0085\n @Spaced　\n# a comment\n! another\nUCzzzzzzzzzzzzzzzzzzzzz1 seen in a report\n@Espa%C3%B1ol\nnot a channel\n');
		expect(parsed).toEqual({
			aliases: [
				{ platform: 'yt', alias: '@nelchannel' },
				{ platform: 'yt', alias: '@spaced' },
				{ platform: 'yt', alias: 'UCzzzzzzzzzzzzzzzzzzzzz1' },
				{ platform: 'yt', alias: '@español' }
			],
			skipped: 2,
			excluded: 0
		});
		expect(parseSeed({ ...e, platforms: ['tt'] }, '@Some.Creator\n').aliases).toEqual([{ platform: 'tt', alias: '@some.creator' }]);
	});

	it('reads uBlock Origin rules: every channel ID and /@handle in a rule', () => {
		const e = clearedEntry({ format: 'ubo' });
		const file = [
			'! Title: An AI music blocklist',
			'www.youtube.com##ytd-rich-item-renderer:has(a[href="/@SynthMoods"])',
			'www.youtube.com##ytd-rich-item-renderer:has(a[href="/channel/UCzzzzzzzzzzzzzzzzzzzzz2"])',
			"youtube.com##ytd-video-renderer:has(a[href='/@lofi.ai.beats/videos'])",
			'www.youtube.com##.ytd-ad-slot-renderer'
		].join('\n');
		expect(parseSeed(e, file)).toEqual({
			aliases: [
				{ platform: 'yt', alias: '@synthmoods' },
				{ platform: 'yt', alias: 'UCzzzzzzzzzzzzzzzzzzzzz2' },
				{ platform: 'yt', alias: '@lofi.ai.beats' }
			],
			skipped: 1,
			excluded: 0
		});
	});

	// Seed list review 8: only artists whose own disclosure says fully AI-generated, never the
	// AI-assisted, the anonymous-only or the removed, and only the platforms the entry lists.
	it("reads Soul Over AI's artist JSON, fully AI-generated artists only", () => {
		const e = clearedEntry({ format: 'soul-over-ai', platforms: ['yt'] });
		const artist = (over: Record<string, unknown>) => ({ removed: false, disclosure: 'full', youtube: null, tiktok: null, instagram: null, markers: [], ...over });
		const file = JSON.stringify([
			artist({ youtube: 'UCzzzzzzzzzzzzzzzzzzzzz3', tiktok: '@fullai' }),
			artist({ disclosure: 'partial', youtube: 'UCzzzzzzzzzzzzzzzzzzzzz4' }),
			artist({ disclosure: 'none', markers: ['anonymous'], youtube: 'UCzzzzzzzzzzzzzzzzzzzzz5' }),
			artist({ removed: true, youtube: 'UCzzzzzzzzzzzzzzzzzzzzz6' }),
			artist({ instagram: 'only.instagram' }),
			'not an artist'
		]);
		expect(parseSeed(e, file)).toEqual({ aliases: [{ platform: 'yt', alias: 'UCzzzzzzzzzzzzzzzzzzzzz3' }], skipped: 2, excluded: 3 });
		expect(parseSeed({ ...e, platforms: ['yt', 'tt', 'ig'] }, file).aliases.map((a) => a.alias)).toEqual(['UCzzzzzzzzzzzzzzzzzzzzz3', '@fullai', 'only.instagram']);
		expect(() => parseSeed(e, '{"artists": []}')).toThrow('the file is not a JSON array of artists');
	});
});

describe('revoke-seed', () => {
	it('deletes every entry of a seed at once, keeps the batches marked, and leaves sources with their own evidence', () =>
		withStore([clearedEntry()], async (store, state) => {
			listSeed(store.db, clearedEntry(), ['@onlylisted', '@tagged'], S);
			saveTags(store.db, 'h1', [{ clientId: 'c', platform: 'yt', targetType: 'source', targetId: '@tagged', sourceId: '@tagged', verdict: 'slop', slopType: '', tests: 0, platformLabel: false, createdAt: S, extVersion: '1' }], S);
			expect((await op(store, state, 'revoke-seed', { seed: 'secret-list', reason: 'License withdrawn' })).body.error.code).toBe('confirmation_required');
			expect((await op(store, state, 'revoke-seed', { seed: 'secret-list', reason: '', confirm: 'secret-list' })).body.error.code).toBe('invalid_reason');
			const res = await op(store, state, 'revoke-seed', { seed: 'secret-list', reason: 'License withdrawn', confirm: 'secret-list' });
			expect(res).toEqual({ status: 200, body: { seed: 'secret-list', entries: 2, sources: 2, message: 'Deleted 2 entries of secret-list. Their review leads close at the next scoring pass.' } });
			expect(store.db.all('SELECT * FROM seed_entries')).toEqual([]);
			expect(store.db.all('SELECT revoked_at, revoke_reason FROM seed_imports')).toEqual([{ revoked_at: S, revoke_reason: 'License withdrawn' }]);
			expect(findSource(store.db, 'yt', '@onlylisted'), 'a source only the list made').toBeUndefined();
			expect(findSource(store.db, 'yt', '@tagged')).toBeDefined();
		}));
});

describe('the daily seeds job', () => {
	it('runs at 04:00 UTC', () => {
		expect(nextSeeds(Date.UTC(2026, 9, 5, 3, 59))).toBe(Date.UTC(2026, 9, 5, 4));
		expect(nextSeeds(Date.UTC(2026, 9, 5, 4))).toBe(Date.UTC(2026, 9, 6, 4));
	});

	// Expired entries, entries of a list the registry no longer clears and the sources that existed
	// only for them go; calibration rows go 24 months after their last label.
	it('deletes entries that are no review lead any more, and the sources only they made', () => {
		const live = clearedEntry({ id: 'live-list', expires_after_days: 30 });
		const gone = clearedEntry({ id: 'gone-list' });
		return withStore([live, { ...gone, clearance: { status: 'revoked', by: 'slantview', at: '2026-10-01' } }], async (store) => {
			listSeed(store.db, live, ['@fresh'], S, S - 10 * DAY);
			listSeed(store.db, live, ['@fresh', '@stale'], S, S - 31 * DAY);
			listSeed(store.db, gone, ['@revoked', '@sampled'], S);
			// The calibration set keeps @sampled, so its source stays.
			addCalibrationItems(store.db, [findSource(store.db, 'yt', '@sampled')!], 'seed:gone-list', S);
			listSeed(store.db, live, ['@fresh'], S, S - 10 * DAY);
			const old = ensureSource(store.db, 'yt', '@oldlabel', '', S);
			addCalibrationItems(store.db, [old], 'community', S - CALIBRATION_RETENTION - 2 * DAY);
			const acct = store.db.get<{ id: string }>("INSERT INTO accounts (id, email, created_at) VALUES ('acc_l', 'l@example.test', 1) RETURNING id")!.id;
			addLabel(store.db, old, acct, false, { label: 'slop', tests: 0, evidence: 0, note: '' }, S - CALIBRATION_RETENTION - DAY);

			expect(seedsJob(store.db, store.engine.seeds, store.jobs, T)).toBe(nextSeeds(T));
			expect(store.db.all('SELECT seed, alias FROM seed_entries ORDER BY alias')).toEqual([{ seed: 'live-list', alias: '@fresh' }]);
			expect(['@fresh', '@stale', '@revoked', '@sampled', '@oldlabel'].map((a) => findSource(store.db, 'yt', a) !== undefined)).toEqual([true, false, false, true, false]);
			expect(store.db.all('SELECT frame FROM calibration_items')).toEqual([{ frame: 'seed:gone-list' }]);
			expect(pruneCalibration(store.db, S)).toBe(0);
		});
	});
});

describe('calibration sampling and export', () => {
	const frame = clearedEntry({ id: 'random-frame', name: 'Random Frame', use: 'frame', license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Random Frame, CC BY 4.0' });
	const frameFile = Array.from({ length: 10 }, (_, i) => `UCzzzzzzzzzzzzzzzzzzzz${String(i).padStart(2, '0')}`).join('\n');
	const seeded = clearedEntry();

	it('samples from a lead list, the community and a cleared frame, never twice and never a suppressed source', () => {
		const f = { ...frame, sha256: hex(sha256(utf8(frameFile))) };
		return withStore([seeded, f], async (store, state) => {
			listSeed(store.db, seeded, ['@a', '@b', '@c'], S);
			store.db.run('UPDATE sources SET seed_suppressed_at = 1 WHERE canonical_id = ?', '@c');
			saveTags(store.db, 'h1', [{ clientId: 'c', platform: 'yt', targetType: 'source', targetId: '@tagged', sourceId: '@tagged', verdict: 'slop', slopType: '', tests: 0, platformLabel: false, createdAt: S, extVersion: '1' }], S);

			expect(await op(store, state, 'calibration-sample', { frame: 'seed:secret-list', n: 5 })).toEqual({ status: 200, body: { frame: 'seed:secret-list', sampled: 2, available: 2 } });
			expect((await op(store, state, 'calibration-sample', { frame: 'seed:secret-list', n: 5 })).body).toEqual({ frame: 'seed:secret-list', sampled: 0, available: 0 });
			expect((await op(store, state, 'calibration-sample', { frame: 'community', n: 1 })).body).toEqual({ frame: 'community', sampled: 1, available: 1 });

			expect((await op(store, state, 'calibration-sample', { frame: 'random:random-frame', n: 4 })).body.error.code).toBe('no_seed_object');
			await env.BACKUPS.put(`${SEED_PREFIX}random-frame.json`, JSON.stringify({ file: frameFile, records: { dpia: 'D', lia: 'L' } }));
			expect((await op(store, state, 'calibration-sample', { frame: 'random:random-frame', n: 4 })).body).toEqual({ frame: 'random:random-frame', sampled: 4, available: 10 });
			expect((await op(store, state, 'calibration-sample', { frame: 'random:random-frame', n: 100 })).body).toEqual({ frame: 'random:random-frame', sampled: 6, available: 6 });
			expect(store.db.all('SELECT frame, count(*) AS n FROM calibration_items GROUP BY frame ORDER BY frame')).toEqual([
				{ frame: 'community', n: 1 },
				{ frame: 'random:random-frame', n: 10 },
				{ frame: 'seed:secret-list', n: 2 }
			]);
			// A frame is never imported as leads, and a lead list is no frame.
			expect((await op(store, state, 'calibration-sample', { frame: 'random:secret-list', n: 1 })).body.error.code).toBe('seed_not_cleared');
			for (const args of [{ frame: 'everything', n: 1 }, { frame: 'community', n: 0 }, { frame: 'community' }, { frame: 'community', n: 1, extra: 1 }]) {
				const res = await op(store, state, 'calibration-sample', args);
				expect(res.status, JSON.stringify(args)).toBe(400);
			}
		});
	});

	it('exports to the private bucket and answers only where and how many', () =>
		withStore([seeded], async (store, state) => {
			listSeed(store.db, seeded, ['@a'], S);
			const ref = findSource(store.db, 'yt', '@a')!;
			addCalibrationItems(store.db, [ref], 'seed:secret-list', S);
			store.db.run("INSERT INTO accounts (id, email, created_at) VALUES ('acc_x', 'x@example.test', 1)");
			addLabel(store.db, ref, 'acc_x', false, { label: 'ai_not_slop', tests: 0, evidence: 1, note: 'Says so in the bio' }, S);
			const res = await op(store, state, 'calibration-export', {});
			const key = `${CALIBRATION_PREFIX}${new Date(T).toISOString()}.json`;
			expect(res).toEqual({ status: 200, body: { key, items: 1, labels: 1 } });
			const saved = await (await env.BACKUPS.get(key))!.json();
			expect(saved).toEqual({
				exported_at: new Date(T).toISOString(),
				items: [
					{
						source_id: ref,
						platform: 'yt',
						id: '@a',
						frame: 'seed:secret-list',
						sampled_at: S,
						large: false,
						verdict: null,
						computed: null,
						seeds: ['secret-list'],
						labels: [{ labeler: 'acc_x', label: 'ai_not_slop', tests: 0, evidence: 1, labeled_at: S }]
					}
				]
			});
			expect((await op(store, state, 'calibration-export', { all: true })).body.error.code).toBe('invalid_args');
			expect(sourceRefs(store.db)).toEqual([ref]);
		}));
});
