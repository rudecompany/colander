// Dev-only routes and the parity harness's clock. The edge forwards /__dev/* to the Store only
// when COLANDER_DEV=1, and the routes check it again here.
//
// - POST /__dev/seed fills an empty Store with fictional demo data (Go's `colander seed-dev`).
// - POST /__dev/settle does what the Go server does when it starts: publish, run a full scoring
//   pass, publish again. With a frozen clock no job runs on its own, so the harness settles here.
// - GET /__dev/dump answers the SQL dump the backups write, uncompressed.
//
// COLANDER_TEST_NOW (RFC 3339, honored only with COLANDER_DEV=1) freezes the Store's clock, as
// the same variable freezes the Go server's, so e2e/parity can diff both byte for byte.
import { b64url, hex, utf8 } from '@colander/shared/bytes';
import { sha256 } from '@colander/shared/sha256';
import { dumpLines } from './backup';
import { json, jsonError, notFound } from './http';
import { decide as engineDecide, resolveAppeal, verifyAppeal, type DecisionInput } from './scoring/actions';
import { Sig, TestBit } from './scoring/rules';
import { grantRole, setDisplayName, type Account } from './store/accounts';
import { AppealAwaiting, AppealPendingManual, createAppeal, transitionAppeal, type Appeal } from './store/appeals';
import { latestSequence } from './store/list';
import { verdictCounts } from './store/misc';
import { ensureSource, findItem, findSource, importSeed, setYouTube, sourceRefs } from './store/sources';
import { createReport, dismissReport, saveTags, type TagInput } from './store/tags';
import type { Store } from './store/store';

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

/** The frozen clock in unix ms, or undefined outside the parity harness. A malformed value fails the start. */
export function testNow(env: Env): number | undefined {
	const v = (env as Env & { COLANDER_TEST_NOW?: string }).COLANDER_TEST_NOW;
	if (env.COLANDER_DEV !== '1' || !v) return undefined;
	const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN;
	if (Number.isNaN(t)) throw new Error('COLANDER_TEST_NOW must be an RFC 3339 time');
	return t;
}

/** The dev routes as [method, pattern, handler], for the Store's router. */
export function devRoutes(store: Store, ctx: DurableObjectState, env: Env): [string, string, Handler][] {
	const dev =
		(h: Handler): Handler =>
		(request, url) =>
			env.COLANDER_DEV === '1' ? h(request, url) : notFound();
	return [
		[
			'POST',
			'/__dev/seed',
			dev(async () => {
				if (sourceRefs(store.db).length > 0) return jsonError(409, 'already_seeded', 'The Store already has data; seed a fresh one.');
				return json(200, await ctx.blockConcurrencyWhile(() => seedDev(store)));
			})
		],
		['POST', '/__dev/settle', dev(() => ctx.blockConcurrencyWhile(() => settle(store)).then((body) => json(200, body)))],
		[
			'GET',
			'/__dev/dump',
			dev(() => {
				const lines = [...dumpLines(ctx.storage.sql, store.db, store.now())];
				return new Response(lines.join('\n') + '\n', { headers: { 'Content-Type': 'application/sql; charset=utf-8' } });
			})
		]
	];
}

/** The Go server's start: publish what changed, score everything, publish again. */
async function settle(store: Store): Promise<{ changed: number; head_seq: number }> {
	const now = store.now();
	await store.publisher.publish(now);
	const changed = await store.engine.fullPass(now);
	const head = await store.publisher.publish(now);
	return { changed, head_seq: head.seq };
}

/** Go's newInstall: the stored hash of a random install ID. */
const newInstall = (): string => hex(sha256(utf8('colander-install:' + b64url(crypto.getRandomValues(new Uint8Array(16))))));

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** One batch of identical tags from several installs (Go's tagOpt). */
interface TagOpt {
	verdict: string;
	slopType?: string;
	tests?: number;
	label?: boolean;
}

const low = TestBit.low_effort;
const mass = TestBit.mass_produced;
const hollow = TestBit.hollow;

const pick = (list: string[], from: number, n: number): string[] => list.slice(from, from + n);

/**
 * Go's seeder: fictional demo data made through the real code paths. Tags and reports go through
 * the store, scoring passes, reviewer decisions and appeals through the engine, each at a
 * simulated time between 120 days ago and now. It runs inside blockConcurrencyWhile, so nothing
 * else sees the simulated clock.
 */
class Seeder {
	/** the time the seed ends at, whole seconds (unix ms) */
	readonly end: number;
	/** the simulated time (unix ms) */
	clock: number;
	mature: string[] = [];
	fresh: string[] = [];
	next = 0;
	staff!: Account;
	curator!: Account;
	awaitingLink = '';
	err: unknown;

	constructor(readonly store: Store) {
		this.end = Math.floor(store.now() / 1000) * 1000;
		this.clock = this.end;
	}

	get db() {
		return this.store.db;
	}
	get unix(): number {
		return Math.floor(this.clock / 1000);
	}
	days(d: number): number {
		return this.end - Math.trunc(d * 24 * 3_600_000);
	}
	at(t: number): void {
		this.clock = t;
	}
	fail(err: unknown): void {
		if (err !== undefined && this.err === undefined) this.err = err;
	}
	attempt<T>(fn: () => T): T | undefined {
		try {
			return fn();
		} catch (err) {
			this.fail(err);
			return undefined;
		}
	}

	/** Each install tags the target. For items, source is the item's source. */
	tag(installs: string[], platform: string, targetType: string, target: string, source: string, o: TagOpt): void {
		if (source === '') source = target;
		for (const h of installs) {
			this.next++;
			const t: TagInput = {
				clientId: `seed-${pad(this.next, 6)}`,
				platform,
				targetType,
				targetId: target,
				sourceId: source,
				verdict: o.verdict,
				slopType: '',
				tests: 0,
				platformLabel: o.label ?? false,
				createdAt: this.unix,
				extVersion: '1.0.0'
			};
			if (o.verdict === 'slop') [t.slopType, t.tests] = [o.slopType ?? '', o.tests ?? 0];
			this.attempt(() => saveTags(this.db, h, [t], this.unix));
		}
	}

	ref(platform: string, alias: string): number {
		const ref = findSource(this.db, platform, alias);
		if (ref === undefined) this.fail(new Error(`seed: no source ${platform}:${alias}`));
		return ref ?? 0;
	}

	source(platform: string, alias: string, name: string): number {
		return this.attempt(() => ensureSource(this.db, platform, alias, name, this.unix)) ?? 0;
	}

	/** What the YouTube Data API would report, through the same store call enrichment uses. */
	youtube(alias: string, channelId: string, handle: string, title: string, subscribers: number, uploadsPerDay: number): void {
		const ref = this.source('yt', alias, title);
		this.attempt(() => setYouTube(this.db, ref, { channelId, handle, title, subscribers, uploadsPerDay }, this.unix));
	}

	/** Scores until nothing changes, since reputation feeds on the verdicts of the pass before. */
	async pass(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			if (this.err !== undefined) return;
			try {
				if ((await this.store.engine.fullPass(this.clock)) === 0) return;
			} catch (err) {
				this.fail(err);
			}
		}
	}

	decide(acct: Account, platform: string, alias: string, itemId: string, verdict: string, reason: string, signals: number, slopType: string, tests: number, large?: boolean): void {
		if (this.err !== undefined) return;
		const input: DecisionInput = {
			sourceRef: this.ref(platform, alias),
			verdict,
			reason,
			signals,
			slopType,
			tests,
			large,
			actor: acct.role,
			accountId: acct.id,
			actorName: acct.displayName
		};
		if (itemId !== '') {
			const it = findItem(this.db, platform, itemId);
			if (!it) return this.fail(new Error(`seed: no item ${platform}:${itemId}`));
			input.itemRef = it.ref;
		}
		this.attempt(() => engineDecide(this.store.engine, input));
	}

	report(install: string, platform: string, source: string, name: string, reason: string, slopType: string, tests: number, ...examples: string[]): string {
		this.next++;
		const r = this.attempt(() =>
			createReport(
				this.db,
				{
					installHash: install,
					clientId: `seed-report-${pad(this.next, 4)}`,
					platform,
					sourceId: source,
					sourceName: name,
					examples: [...examples],
					reason,
					slopType,
					tests,
					extVersion: '1.0.0'
				},
				this.unix
			)
		);
		return r?.report.id ?? '';
	}

	appeal(platform: string, alias: string, email: string, statement: string): Appeal | undefined {
		if (this.err !== undefined) return undefined;
		const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
		const sourceRef = this.ref(platform, alias);
		const code = 'colander-DEMO' + pad(this.next, 4);
		this.next++;
		if (sourceRef === 0) return undefined;
		const a = this.attempt(() => createAppeal(this.db, { platform, sourceRef, email, statement, code, secretHash: hex(sha256(utf8(raw))), createdAt: this.unix }));
		if (a?.status === AppealAwaiting && this.awaitingLink === '') {
			this.awaitingLink = `/appeal/status/${a.id}?secret=${raw}`; // the website page, not the API route
		}
		return a;
	}

	verify(a: Appeal | undefined): void {
		if (a) this.attempt(() => verifyAppeal(this.store.engine, a));
	}

	resolve(a: Appeal | undefined, outcome: string, reasoning: string): void {
		if (a) this.attempt(() => resolveAppeal(this.store.engine, a, outcome, reasoning, this.staff));
	}

	toPendingManual(a: Appeal | undefined): void {
		if (a) this.attempt(() => transitionAppeal(this.db, a.id, [AppealAwaiting], AppealPendingManual, {}));
	}

	async publish(): Promise<void> {
		if (this.err !== undefined) return;
		try {
			await this.store.publisher.publish(this.clock);
		} catch (err) {
			this.fail(err);
		}
	}

	async run(): Promise<void> {
		const db = this.db;
		for (let i = 0; i < 70; i++) this.mature.push(newInstall());
		for (let i = 0; i < 30; i++) this.fresh.push(newInstall());
		const m = this.mature;
		const f = this.fresh;

		// Reviewers.
		this.at(this.days(120));
		this.staff = grantRole(db, 'rae@colander.test', 'staff', this.unix);
		this.curator = grantRole(db, 'sam@colander.test', 'curator', this.unix);
		this.attempt(() => setDisplayName(db, this.staff.id, 'Rae'));
		this.attempt(() => setDisplayName(db, this.curator.id, 'Sam'));
		[this.staff.displayName, this.curator.displayName] = ['Rae', 'Sam'];

		// An old staff decision that lapses: Quantum Recipes was confirmed as Slop 95 days ago.
		this.at(this.days(100));
		this.youtube('@quantumrecipesai', 'UCdemo000000000000000014', '@quantumrecipesai', 'Quantum Recipes AI', 8_200, 16);
		this.tag(pick(m, 0, 8), 'yt', 'source', '@quantumrecipesai', '', { verdict: 'slop', slopType: 'filler', tests: low | mass, label: true });
		this.at(this.days(95));
		this.decide(this.staff, 'yt', '@quantumrecipesai', '', 'slop', 'Staff review confirmed a narration template over stock footage, posted many times a day.', Sig.templated, 'filler', low | mass);

		// Seed lists, imported through the same call the import-seed command uses. The names are fictional.
		this.at(this.days(45));
		for (const alias of ['@catrescuetales', '@dailymotivationmachine']) {
			this.attempt(() => importSeed(db, 'yt', alias, 'blocklist', 'Demo list', 'CC0 (fictional demo)', this.unix));
		}
		this.attempt(() => importSeed(db, 'yt', '@biblestoriesanimated', 'warnlist', 'Demo list', 'CC0 (fictional demo)', this.unix));

		// The bulk of community tagging happens a month ago, by installs that are mature at the end.
		this.at(this.days(40));
		this.youtube('@aihistorydaily', 'UCaaaaaaaaaaaaaaaaaaaaaa', '@aihistorydaily', 'AI History Daily', 48_000, 22);
		this.youtube('@ancientwondersdaily', 'UCdemo000000000000000001', '@ancientwondersdaily', 'Ancient Wonders Daily AI', 61_000, 31);
		this.youtube('@lostcivsexplained', 'UCdemo000000000000000002', '@lostcivsexplained', 'Lost Civilizations Explained', 23_000, 2.5);
		this.youtube('@gossipnarrated', 'UCdemo000000000000000003', '@gossipnarrated', 'Celebrity Gossip Narrated', 1_240_000, 19);
		this.youtube('@galaxyfacts4k', 'UCdemo000000000000000004', '@galaxyfacts4k', 'Galaxy Facts 4K', 87_000, 3);
		this.youtube('@grandpasworkshop', 'UCdemo000000000000000005', '@grandpasworkshop', "Grandpa's Workshop", 132_000, 0.3);
		this.youtube('@priyaraohistory', 'UCdemo000000000000000006', '@priyaraohistory', 'Priya Rao History', 9_400, 0.4);
		this.youtube('@oceanmysteriesunveiled', 'UCdemo000000000000000007', '@oceanmysteriesunveiled', 'Ocean Mysteries Unveiled', 15_000, 12);
		this.youtube('@spacekidssongs', 'UCdemo000000000000000008', '@spacekidssongs', 'Space Kids Songs', 77_000, 25);
		this.youtube('@forestsoundsrelax', 'UCdemo000000000000000009', '@forestsoundsrelax', 'Forest Sounds Relax', 4_100, 1);
		this.youtube('@catrescuetales', 'UCdemo000000000000000010', '@catrescuetales', 'Kitty Rescue Stories', 39_000, 9);

		const slop = (tests: number, kind: string, label: boolean): TagOpt => ({ verdict: 'slop', slopType: kind, tests, label });
		const notSlop: TagOpt = { verdict: 'not_slop' };
		const aiFine: TagOpt = { verdict: 'ai_fine', label: true };

		// YouTube.
		this.tag(pick(m, 0, 12), 'yt', 'source', '@aihistorydaily', '', slop(low | mass, 'filler', true));
		this.tag(pick(m, 10, 11), 'yt', 'source', '@ancientwondersdaily', '', slop(low | mass | hollow, 'filler', true));
		for (let i = 0; i < 6; i++) {
			this.tag(pick(m, 20 + i, 3), 'yt', 'item', `demoAW${pad(i, 5)}`, '@ancientwondersdaily', slop(low | hollow, 'filler', true));
		}
		this.tag(pick(m, 25, 4), 'yt', 'source', '@lostcivsexplained', '', slop(low | hollow, 'filler', true));
		this.tag(pick(m, 30, 9), 'yt', 'source', '@gossipnarrated', '', slop(low | hollow | mass, 'deceptive', true));
		for (let i = 0; i < 3; i++) this.tag(pick(m, 40 + i, 2), 'yt', 'item', `demoGF${pad(i, 5)}`, '@galaxyfacts4k', aiFine);
		for (let i = 3; i < 7; i++) this.tag(pick(m, 40 + i, 2), 'yt', 'item', `demoGF${pad(i, 5)}`, '@galaxyfacts4k', notSlop);
		this.tag(pick(m, 44, 7), 'yt', 'source', '@galaxyfacts4k', '', slop(hollow, 'filler', true));
		this.tag(pick(m, 0, 6), 'yt', 'source', '@catrescuetales', '', slop(mass | hollow, 'deceptive', false));
		this.tag(pick(m, 50, 8), 'yt', 'source', '@grandpasworkshop', '', notSlop);
		this.tag(pick(m, 55, 3), 'yt', 'source', '@priyaraohistory', '', slop(low, 'filler', false));
		this.tag(pick(m, 58, 2), 'yt', 'source', '@priyaraohistory', '', { verdict: 'slop', label: true });
		this.tag(pick(m, 0, 9), 'yt', 'source', '@oceanmysteriesunveiled', '', slop(low | mass, 'filler', true));
		this.tag(pick(m, 12, 10), 'yt', 'source', '@spacekidssongs', '', slop(low | hollow | mass, 'filler', true));
		this.tag(pick(m, 22, 3), 'yt', 'source', '@forestsoundsrelax', '', slop(low, 'filler', true));
		this.tag(pick(m, 25, 3), 'yt', 'source', '@forestsoundsrelax', '', notSlop);
		this.tag(pick(m, 60, 3), 'yt', 'source', '@biblestoriesanimated', '', aiFine);

		// TikTok.
		this.tag(pick(m, 30, 5), 'tt', 'source', '@sloppyfacts', '', { verdict: 'ai_fine', label: true });
		this.tag(pick(m, 35, 8), 'tt', 'source', '@petpalsai', '', slop(low | mass, 'filler', false));
		for (let i = 0; i < 6; i++) this.tag(pick(m, 45 + i, 2), 'tt', 'item', `74000000000000${pad(i, 5)}`, '@petpalsai', slop(low, 'filler', true));
		this.tag(pick(m, 0, 4), 'tt', 'source', '@miraclecuresdaily', '', slop(hollow | low, 'bait', true));
		this.tag(pick(m, 5, 5), 'tt', 'source', '@historyinshorts', '', slop(low | hollow, 'filler', true));
		this.tag(pick(m, 10, 9), 'tt', 'source', '@chefmarta', '', notSlop);
		this.tag(pick(m, 20, 6), 'tt', 'source', '@dancewithjules', '', notSlop);
		this.tag(pick(m, 26, 6), 'tt', 'source', '@aiartgallery', '', aiFine);
		this.tag(pick(m, 33, 4), 'tt', 'source', '@newsflash24ai', '', slop(hollow, 'deceptive', true));
		this.tag(pick(m, 40, 3), 'tt', 'item', '7412345678901234567', '@trendrecaps', slop(low | hollow, 'filler', true));

		// Instagram.
		this.tag(pick(m, 0, 8), 'ig', 'source', 'handmadepottery', '', notSlop);
		this.tag(pick(m, 8, 9), 'ig', 'source', 'dreamy.landscapes.ai', '', slop(low | mass, 'filler', true));
		for (let i = 0; i < 5; i++) this.tag(pick(m, 18 + i, 2), 'ig', 'item', `Cdemo${pad(i, 5)}`, 'dreamy.landscapes.ai', slop(low, 'filler', true));
		this.tag(pick(m, 24, 4), 'ig', 'source', 'cute.animals.daily', '', slop(low | hollow, 'filler', true));
		this.tag(pick(m, 28, 3), 'ig', 'source', 'fitness.tips.ai', '', slop(hollow | low, 'bait', true));
		this.tag(pick(m, 31, 7), 'ig', 'source', 'marco.photo.walks', '', notSlop);
		this.tag(pick(m, 38, 4), 'ig', 'source', 'astro.wonders.ai', '', aiFine);
		this.tag(pick(m, 42, 9), 'ig', 'source', 'luxury.life.ai', '', slop(low | mass | hollow, 'bait', true));
		for (let i = 0; i < 5; i++) this.tag(pick(m, 51 + i, 2), 'ig', 'item', `Cluxe${pad(i, 5)}`, 'luxury.life.ai', slop(low, 'bait', true));
		this.tag(pick(m, 56, 3), 'ig', 'source', 'garden.with.ana', '', slop(low | hollow, 'filler', true));

		// Facebook.
		this.tag(pick(m, 0, 4), 'fb', 'source', 'amazingworldpics', '', aiFine);
		this.tag(pick(m, 0, 4), 'fb', 'item', 'pfbid02abcDEF', 'amazingworldpics', slop(hollow | low, 'bait', true));
		this.tag(pick(m, 9, 8), 'fb', 'source', 'grandmasrecipesofficial', '', slop(low | hollow, 'bait', true));
		this.tag(pick(m, 17, 10), 'fb', 'source', '100087654321098', '', slop(low | mass, 'filler', true));
		for (let i = 0; i < 5; i++) this.tag(pick(m, 27 + i, 2), 'fb', 'item', `pfbiddemo${pad(i, 4)}`, '100087654321098', slop(low, 'filler', true));
		this.tag(pick(m, 32, 4), 'fb', 'source', 'veterans.tribute.page', '', slop(hollow | low, 'deceptive', true));
		this.tag(pick(m, 36, 8), 'fb', 'source', 'springfield.bakery', '', notSlop);
		for (let i = 0; i < 2; i++) this.tag(pick(m, 44 + i, 2), 'fb', 'item', `pfbidwood${pad(i, 4)}`, 'woodworking.hub.daily', aiFine);
		for (let i = 2; i < 6; i++) this.tag(pick(m, 44 + i, 2), 'fb', 'item', `pfbidwood${pad(i, 4)}`, 'woodworking.hub.daily', notSlop);
		this.tag(pick(m, 50, 4), 'fb', 'source', 'woodworking.hub.daily', '', { verdict: 'ai_fine', label: true });
		this.tag(pick(m, 54, 5), 'fb', 'source', 'heartwarming.moments.ai', '', slop(hollow, 'deceptive', true));
		this.tag(pick(m, 59, 5), 'fb', 'source', 'kindness.stories.daily', '', slop(hollow | low, 'filler', true));

		// Names for sources that only appear through tags.
		for (const [platform, alias, name] of [
			['tt', '@sloppyfacts', 'Sloppy Facts'],
			['tt', '@petpalsai', 'Pet Pals AI'],
			['tt', '@miraclecuresdaily', 'Miracle Cures Daily'],
			['tt', '@historyinshorts', 'History in Shorts'],
			['tt', '@chefmarta', 'Chef Marta'],
			['tt', '@dancewithjules', 'Dance with Jules'],
			['tt', '@aiartgallery', 'AI Art Gallery'],
			['tt', '@newsflash24ai', 'Newsflash 24 AI'],
			['tt', '@trendrecaps', 'Trend Recaps'],
			['ig', 'handmadepottery', 'Handmade Pottery'],
			['ig', 'dreamy.landscapes.ai', 'Dreamy Landscapes AI'],
			['ig', 'cute.animals.daily', 'Cute Animals Daily'],
			['ig', 'fitness.tips.ai', 'Fitness Tips AI'],
			['ig', 'marco.photo.walks', "Marco's Photo Walks"],
			['ig', 'astro.wonders.ai', 'Astro Wonders AI'],
			['ig', 'luxury.life.ai', 'Luxury Life AI'],
			['ig', 'garden.with.ana', 'Garden with Ana'],
			['fb', 'amazingworldpics', 'Amazing World Pics'],
			['fb', 'grandmasrecipesofficial', "Grandma's Recipes Official"],
			['fb', '100087654321098', 'Divine Ocean Art'],
			['fb', 'veterans.tribute.page', 'Veterans Tribute Page'],
			['fb', 'springfield.bakery', 'Springfield Bakery'],
			['fb', 'woodworking.hub.daily', 'Woodworking Hub Daily'],
			['fb', 'heartwarming.moments.ai', 'Heartwarming Moments AI'],
			['fb', 'kindness.stories.daily', 'Kindness Stories Daily'],
			['yt', '@dailymotivationmachine', 'Daily Motivation Machine'],
			['yt', '@biblestoriesanimated', 'Bible Stories AI Animated']
		] as const) {
			this.source(platform, alias, name);
		}

		// First scoring pass a month ago: community verdicts land.
		this.at(this.days(30));
		await this.pass();

		// Reports from viewers.
		this.at(this.days(28));
		this.report(m[1]!, 'yt', '@ancientwondersdaily', 'Ancient Wonders Daily AI', 'Posts 30 AI history videos a day with the same voice and stock clips.', 'filler', mass | low, 'demoAW00001', 'demoAW00002');
		this.report(m[2]!, 'yt', '@ancientwondersdaily', 'Ancient Wonders Daily AI', 'Same narration template on every video.', 'filler', mass);
		this.report(m[3]!, 'yt', '@galaxyfacts4k', 'Galaxy Facts 4K', 'Some of these space videos look generated.', '', 0, 'demoGF00001');
		const rptGrandpa = this.report(m[4]!, 'yt', '@grandpasworkshop', "Grandpa's Workshop", 'Looks too polished to be real.', '', 0);
		for (let i = 0; i < 3; i++) {
			this.report(m[60 + i]!, 'tt', '@newsflash24ai', 'Newsflash 24 AI', 'Invented news events with a synthetic anchor voice.', 'deceptive', hollow);
		}
		this.report(m[64]!, 'fb', 'veterans.tribute.page', 'Veterans Tribute Page', 'Generated photos of veterans presented as real, with a donation link.', 'deceptive', hollow | low);

		// Reviewer decisions over the following weeks.
		this.at(this.days(26));
		this.decide(this.staff, 'yt', '@aihistorydaily', '', 'slop', 'Staff review confirmed mass-produced narration over stock footage.', 0, 'filler', low | mass);
		this.at(this.days(25));
		this.decide(this.staff, 'yt', '@ancientwondersdaily', '', 'slop', 'Staff review confirmed a single narration template across hundreds of uploads.', Sig.templated, 'filler', low | mass);
		this.at(this.days(24));
		this.decide(this.curator, 'fb', 'grandmasrecipesofficial', '', 'slop', 'Every post routes to the same recipe-card site full of ads.', Sig.link_funnel, 'bait', hollow | low);
		this.decide(this.curator, 'tt', '@miraclecuresdaily', '', 'slop', 'Synthetic testimonials that push a supplement link in every caption.', Sig.link_funnel | Sig.creator_statement, 'bait', hollow | low);
		this.at(this.days(22));
		this.decide(this.curator, 'fb', 'amazingworldpics', 'pfbid02abcDEF', 'slop', 'Generated image with an affiliate link in the first comment.', Sig.creator_statement | Sig.link_funnel, 'bait', hollow | low);
		this.decide(this.staff, 'yt', '@spacekidssongs', '', 'slop', 'Staff review confirmed generated songs and visuals uploaded around the clock for children.', 0, 'filler', low | mass | hollow);
		this.at(this.days(21));
		if (rptGrandpa !== '') this.attempt(() => dismissReport(db, rptGrandpa, 'Original workshop footage with the creator on camera.', this.unix));
		this.decide(this.staff, 'yt', '@grandpasworkshop', '', 'clear', "Original footage and the creator's own narration.", 0, '', 0);
		this.at(this.days(20));
		this.decide(this.staff, 'tt', '@sloppyfacts', '', 'likely_slop', 'Generated facts videos with frequent errors; large audience, so held at Likely slop.', Sig.platform_label, 'filler', hollow, true);
		// TikTok reports no audience size, so community scoring holds Pet Pals at Likely slop until staff look.
		this.decide(this.staff, 'tt', '@petpalsai', '', 'slop', 'Staff review confirmed generated pet clips posted around the clock to a small audience.', 0, 'filler', low | mass, false);
		this.decide(this.staff, 'ig', 'luxury.life.ai', '', 'slop', 'Generated lifestyle images that funnel to a course sales page.', Sig.link_funnel, 'bait', hollow | low);

		// Appeals in every state, in the order they happened.
		this.at(this.days(20));
		this.appeal('fb', 'heartwarming.moments.ai', 'page@heartwarming.example.test', 'Our stories are submitted by readers.');
		this.at(this.days(19));
		const priya = this.appeal('yt', '@priyaraohistory', 'priya@example.test', 'I research and narrate every episode myself. I use AI only for captions and translation.');
		this.at(this.days(18.5));
		this.verify(priya);
		this.at(this.days(17));
		const luxury = this.appeal('ig', 'luxury.life.ai', 'owner@luxurylife.example.test', 'These are art pieces, not slop.');
		if (luxury) {
			this.toPendingManual(luxury);
			this.at(this.days(16));
			this.verify(luxury);
		}
		// An appeal staff have left waiting for a manual code check: it is kept and escalated.
		this.toPendingManual(this.appeal('fb', 'kindness.stories.daily', 'admin@kindness.example.test', 'A small team writes these stories; we use AI only for the images.'));
		this.at(this.days(15));
		this.resolve(priya, 'upheld', 'The creator narrates on camera and cites sources. AI is used for captions only, which is not slop.');
		this.at(this.days(12));
		this.resolve(luxury, 'denied', 'Every post funnels to the same paid course, and the images carry generator artifacts.');
		this.at(this.days(6));
		const ocean = this.appeal('yt', '@oceanmysteriesunveiled', 'studio@oceanmysteries.example.test', 'We film our own dives. Only the intro uses generated footage.');
		if (ocean) {
			this.at(this.days(5.5));
			this.verify(ocean);
		}
		this.at(this.days(4));
		const sloppy = this.appeal('tt', '@sloppyfacts', 'team@sloppyfacts.example.test', 'We fact-check every script before posting.');
		if (sloppy) {
			this.at(this.days(3.8));
			this.verify(sloppy);
		}
		this.at(this.days(2));
		this.appeal('ig', 'garden.with.ana', 'ana@garden.example.test', 'I photograph my own garden every morning.');

		// Yesterday's pass and publication.
		this.at(this.days(2));
		this.tag(pick(m, 0, 3), 'tt', 'source', '@viralpetfails', '', { verdict: 'ai_fine', label: true });
		this.source('tt', '@viralpetfails', 'Viral Pet Fails');
		this.at(this.days(1));
		await this.pass();
		await this.publish();

		// A report filed after the last verdict change stays open for a reviewer. Reports filed earlier on a
		// source whose verdict has since changed already show that verdict.
		this.at(this.end - 3 * 3_600_000);
		this.report(m[63]!, 'ig', 'fitness.tips.ai', 'Fitness Tips AI', 'Every post pushes the same supplement link.', 'bait', hollow);

		// Two hours ago, a burst of slop tags from brand-new installs: consensus freezes and staff are asked to look.
		this.at(this.end - 2 * 3_600_000);
		this.tag(f.slice(0, 25), 'tt', 'source', '@viralpetfails', '', slop(low, 'filler', true));

		// Today's pass and publication, so a delta from yesterday's sequence has something in it.
		this.at(this.end);
		await this.pass();
		await this.publish();
	}
}

/** Go's seedDev: the seed, then what it printed, as JSON. */
async function seedDev(store: Store): Promise<Record<string, unknown>> {
	const s = new Seeder(store);
	const realClock = store.now;
	store.now = () => s.clock;
	try {
		await s.run();
	} finally {
		store.now = realClock;
	}
	if (s.err !== undefined) throw new Error(`seed-dev stopped: ${String(s.err)}`);
	const { counts, items } = verdictCounts(store.db);
	return {
		sources: counts,
		items,
		sequence: latestSequence(store.db).seq,
		reviewers: [
			{ email: 'rae@colander.test', role: 'staff' },
			{ email: 'sam@colander.test', role: 'curator' }
		],
		awaiting_link: s.awaitingLink || null
	};
}
