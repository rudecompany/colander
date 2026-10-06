// The scoring engine (Go's scoring/engine.go): runs the rules against the Store. Every verdict
// change goes through it, so every change writes a decision log entry and asks for a list
// publication. Go's Engine.Run loop became two jobs (src/jobs.ts): the full pass, in chunks of
// sources across alarm turns, and the debounced rescore of touched sources. Each source is scored
// in one transaction, so a crash never leaves half its targets written.
import { FLAG_LARGE, FLAG_STAFF_REVIEWED } from '@colander/shared/list';
import type { Jobs, PassScorer } from '../jobs';
import { expireAppeals } from '../store/appeals';
import type { Db } from '../store/db';
import { seedLeads, SeedRegistry } from '../store/seeds';
import { setFrozen, sourceRefs, type Item, type Source, type State } from '../store/sources';
import {
	applyUpdate,
	loadSourceData,
	reputation,
	syncEscalations,
	type Decision as StoreDecision,
	type LogEntry,
	type Rep,
	type SourceData,
	type Update,
	type Vote as StoreVote
} from '../store/verdicts';
import { ENRICH_PER_PASS, type YouTube } from '../youtube';
import { communityReason, escalationSummary } from './reason';
import { Default, newInput, SlopTypes, slopTypeCode, sumVotes, type Decision, type Input, type Result, type Thresholds, type Vote } from './rules';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Unix seconds of a unix millisecond time (Go's Time.Unix). */
export const unix = (ms: number): number => Math.floor(ms / 1000);
/** Whole seconds of a duration in milliseconds (Go's int64(d.Seconds())). */
const seconds = (ms: number): number => Math.trunc(ms / 1000);

/** Attributes a change to a reviewer or an appeal instead of the scoring pass. */
export interface Cause {
	/** the target the cause is about, 0 (the default) for the source */
	itemRef?: number;
	actor: string;
	actorName?: string;
	/** the reviewer's account, kept internally so deleting the account can remove the name */
	accountId?: string;
	reason: string;
	/** log the target even when its verdict does not change */
	always?: boolean;
}

/** The scoring outcome for one source and its items, without writing anything. */
export interface Evaluation {
	data: SourceData;
	input: Input;
	result: Result;
	items: ItemEvaluation[];
	burst: boolean;
	lapsing: boolean;
}

/** The scoring outcome for one item. */
export interface ItemEvaluation {
	item: Item;
	input: Input;
	result: Result;
	lapsing: boolean;
}

/** The community evidence on a source, for its public page. */
export interface Evidence {
	taggers: number;
	slop: number;
	aiFine: number;
	notSlop: number;
	itemsSeen: number;
	/** valid when itemsSeen > 0 */
	aiItemShare: number;
}

/** The source's public evidence summary (Go's Evaluation.Evidence). */
export function evidence(ev: Evaluation): Evidence {
	const out: Evidence = {
		taggers: ev.input.votes.length,
		slop: 0,
		aiFine: 0,
		notSlop: 0,
		itemsSeen: ev.input.itemsSeen,
		aiItemShare: 0
	};
	for (const v of ev.input.votes) {
		if (v.verdict === 'slop') out.slop++;
		else if (v.verdict === 'ai_fine') out.aiFine++;
		else if (v.verdict === 'not_slop') out.notSlop++;
	}
	if (out.itemsSeen > 0) out.aiItemShare = ev.input.aiItems / out.itemsSeen;
	return out;
}

function toDecision(d: StoreDecision | undefined): Decision | undefined {
	return d && { verdict: d.verdict, signals: d.signals, slopType: SlopTypes[d.detail & 3]!, tests: d.detail & ~3 };
}

function isLapsing(st: State, now: number): boolean {
	return st.verdict !== '' && st.rescoreAt > 0 && now >= st.rescoreAt;
}

const sameState = (a: State, b: State): boolean =>
	a.verdict === b.verdict &&
	a.signals === b.signals &&
	a.detail === b.detail &&
	a.flags === b.flags &&
	a.changedAt === b.changedAt &&
	a.rescoreAt === b.rescoreAt &&
	a.lapseHold === b.lapseHold &&
	a.computed === b.computed &&
	a.mixed === b.mixed;

export class Engine implements PassScorer {
	th: Thresholds = Default;
	/** Set when YOUTUBE_API_KEY is: each pass starts by refreshing stale YouTube sources. */
	youtube?: YouTube;
	/**
	 * YOUTUBE_DERIVED_USE: YouTube approved Colander's derived metrics, so subscriber counts and
	 * uploads per day are fetched and feed scoring. Off, a source's size is known only when staff
	 * recorded it, and nothing derived from YouTube Data API data reaches a verdict.
	 */
	derived = false;
	/**
	 * The seed registry: which lists' entries are review leads now. The Store builds it with dev
	 * mode; tests replace it with their own entries.
	 */
	seeds = new SeedRegistry();
	/** The full pass's reputation, loaded at its start and kept across its chunks. A restart mid-pass reloads it. */
	private passReps?: Map<string, Rep>;

	constructor(
		readonly db: Db,
		/** for publication requests; a Store that runs no jobs ignores them */
		readonly jobs: Jobs,
		/** the clock in unix milliseconds */
		readonly now: () => number
	) {}

	/**
	 * The start of a full pass (Go's FullPass before its loop): expires stale appeals, looks up to
	 * ENRICH_PER_PASS stale YouTube sources up again and loads the reputation every source of the
	 * pass is scored with.
	 */
	async startPass(now: number): Promise<void> {
		expireAppeals(this.db, unix(now - this.th.appealExpiry), unix(now));
		if (this.youtube) {
			// Network calls happen outside any transaction. A failure only delays enrichment.
			try {
				await this.youtube.enrichStale(this.db, now, ENRICH_PER_PASS, this.derived);
			} catch (err) {
				console.warn(JSON.stringify({ message: 'youtube enrichment failed', error: String(err) }));
			}
		}
		this.passReps = reputation(this.db, 0);
	}

	/**
	 * Scores one source of the full pass and returns the number of targets changed.
	 * ponytail: every pass rescores every source, which reads every tag. Ship the incremental
	 * planner (dirty, due or reputation-affected sources plus an hourly full reconcile) when the
	 * rows-read alert (THRESHOLDS.rowsPerPass in src/scheduled.ts) fires.
	 */
	scoreSource(ref: number, now: number): number {
		this.passReps ??= reputation(this.db, 0);
		return this.score(ref, this.passReps, undefined, now);
	}

	/**
	 * Go's FullPass in one call, for tools that score everything at once (seeding, imports). It
	 * returns the number of sources and items whose stored state changed. The scheduled pass runs
	 * the same steps in chunks (src/jobs.ts).
	 */
	async fullPass(now: number): Promise<number> {
		const started = Date.now();
		await this.startPass(now);
		const refs = sourceRefs(this.db);
		let changed = 0;
		for (const ref of refs) changed += this.scoreSource(ref, now);
		console.log(JSON.stringify({ message: 'scoring pass', sources: refs.length, changes: changed, ms: Date.now() - started }));
		// Always ask: the publisher only writes a sequence when the list really differs.
		this.jobs.requestPublish(now);
		return changed;
	}

	/** Scores one source and its items now, and asks for a publication when something changed. cause attributes the change in the log. */
	rescore(ref: number, cause?: Cause): void {
		const now = this.now();
		if (this.score(ref, undefined, cause, now) > 0) this.jobs.requestPublish(now);
	}

	/** Evaluates a source with fresh reputation data and returns the outcome without writing; undefined for an unknown source. */
	explain(ref: number): Evaluation | undefined {
		const reps = reputation(this.db, ref);
		const d = loadSourceData(this.db, ref, unix(this.now()));
		return d && this.evaluate(d, reps, this.now());
	}

	/**
	 * A source's size for rule 6 and the curator limits: what staff recorded, and the YouTube
	 * subscriber count only with derived use.
	 */
	audience(src: Source): { large: boolean; known: boolean } {
		const subscribers = this.derived ? src.subscribers : null;
		return {
			large: src.largeStaff || (subscribers !== null && subscribers >= this.th.largeSubscribers),
			known: src.sizeReviewedAt > 0 || subscribers !== null
		};
	}

	private weights(reps: Map<string, Rep>, now: number): (install: string) => number {
		return (install) => {
			const r = reps.get(install);
			if (!r) return this.th.weight(now, now, 0, 0);
			return this.th.weight(r.firstTagAt * 1000, now, r.agree, r.decided);
		};
	}

	/** Scores a source and its items from loaded data, without writing. now is unix milliseconds. */
	evaluate(d: SourceData, reps: Map<string, Rep>, now: number): Evaluation {
		const th = this.th;
		const weight = this.weights(reps, now);
		const nowS = unix(now);
		const src = d.source;
		// The source with an empty ID holds items tagged without their source: each is scored on its
		// own, and nothing rolls up to it or freezes it.
		const unattributed = src.canonicalId === '';

		// Tag sums are per target (9.2): the source's sums come from tags on the source itself, one per
		// install even when it tagged two aliases. Item evidence reaches the source only through platform
		// labels and the 80% rule (9.3).
		const perInstall = new Map<string, StoreVote>();
		const labelInstalls = new Set<string>();
		let rollupLabels = new Set<string>();
		const byItem = new Map<number, StoreVote[]>();
		let burst = 0;
		for (const v of d.votes) {
			if (v.platformLabel) {
				rollupLabels.add(v.install);
				if (v.itemRef === 0) labelInstalls.add(v.install);
			}
			if (v.itemRef !== 0) {
				const list = byItem.get(v.itemRef);
				if (list) list.push(v);
				else byItem.set(v.itemRef, [v]);
			} else {
				const cur = perInstall.get(v.install);
				if (!cur || v.createdAt > cur.createdAt) perInstall.set(v.install, v);
			}
			if (v.verdict === 'slop' && nowS - v.receivedAt < seconds(th.burstWindow) && nowS - v.installCreatedAt < seconds(th.burstInstallAge)) {
				burst++;
			}
		}
		const toVote = (v: StoreVote): Vote => ({
			weight: weight(v.install),
			verdict: v.verdict,
			slopType: v.slopType,
			tests: v.tests,
			platformLabel: v.platformLabel
		});

		let frozen = src.frozenUntil > nowS;
		let isBurst = false;
		if (!frozen && !unattributed && burst > th.burstTags) [isBurst, frozen] = [true, true];

		// Items first: their AI evidence feeds the source's 80% rule. Only independent evidence makes an
		// item count as AI-made there: platform labels from enough installs or a reviewer decision, never
		// tags agreeing it is AI, so tags alone cannot make a source look mass-produced (9.3).
		let aiItems = 0,
			seen = 0;
		const items: Omit<ItemEvaluation, 'result'>[] = [];
		for (const it of d.items) {
			const input = newInput({
				item: true,
				decision: toDecision(d.decisions.get(it.ref)),
				appealOpen: d.appealOpen,
				frozen,
				lapseHold: it.state.lapseHold || isLapsing(it.state, nowS),
				uploadsPerDay: -1
			});
			for (const v of byItem.get(it.ref) ?? []) {
				input.votes.push(toVote(v));
				if (v.platformLabel) input.labelInstalls++;
			}
			const sums = sumVotes(input.votes);
			const dec = input.decision;
			if (dec && (dec.verdict === 'slop' || dec.verdict === 'likely_slop' || dec.verdict === 'ai_made')) {
				aiItems++;
				seen++;
			} else if (dec && dec.verdict === 'clear') {
				seen++;
			} else if (input.labelInstalls >= th.labelInstalls) {
				aiItems++;
				seen++;
			} else if (sums.n > 0 && sums.n > sums.s + sums.a) {
				seen++;
			}
			items.push({ item: it, input, lapsing: isLapsing(it.state, nowS) });
		}

		if (unattributed) [aiItems, seen, rollupLabels] = [0, 0, new Set()];
		const audience = this.audience(src);
		const input = newInput({
			decision: toDecision(d.decisions.get(0)),
			appealOpen: d.appealOpen,
			frozen,
			large: audience.large,
			audienceKnown: audience.known,
			uploadsPerDay: this.derived ? (src.uploadsPerDay ?? -1) : -1,
			itemsSeen: seen,
			aiItems,
			labelInstalls: labelInstalls.size,
			rollupLabelInstalls: rollupLabels.size
		});
		const lapsing = isLapsing(src.state, nowS);
		input.lapseHold = src.state.lapseHold || lapsing;
		for (const v of perInstall.values()) input.votes.push(toVote(v));
		const result = th.score(input);

		return {
			data: d,
			input,
			result,
			burst: isBurst,
			lapsing,
			items: items.map((it) => {
				it.input.sourceBehavior = result.behavior;
				it.input.sourceVerdict = result.verdict;
				it.input.sourceMixed = result.mixed;
				return { ...it, result: th.score(it.input) };
			})
		};
	}

	/** Turns a result into the stored state, keeping timestamps when the verdict is unchanged. now is unix seconds. */
	private nextState(old: State, r: Result, input: Input, dec: StoreDecision | undefined, lapsing: boolean, now: number): State {
		const st: State = {
			verdict: r.verdict,
			signals: r.signals,
			detail: slopTypeCode(r.slopType) | r.tests,
			flags: 0,
			changedAt: old.changedAt,
			rescoreAt: old.rescoreAt,
			lapseHold: false,
			computed: r.computed,
			mixed: false
		};
		if (!input.item) {
			st.mixed = r.mixed;
			// Flag bit 5 stays 0: seed lists put nothing on the list (contracts 3).
			if (input.large) st.flags |= FLAG_LARGE;
		}
		if (r.rule === 2 && r.verdict !== '') st.flags |= FLAG_STAFF_REVIEWED;
		const changed = old.verdict !== r.verdict;
		if (changed) st.changedAt = now;
		if (r.verdict === '') st.rescoreAt = 0;
		else if (r.rule === 2) st.rescoreAt = dec!.expiresAt;
		else if (changed || lapsing || old.rescoreAt === 0) st.rescoreAt = now + seconds(this.th.rescore);
		st.lapseHold = (old.lapseHold || (lapsing && r.rule === 6)) && r.rule !== 2;
		return st;
	}

	/**
	 * Go's scoreSource: evaluates one source and writes what changed, in one transaction. reps is
	 * the pass's reputation, or undefined to load it for this source. Returns the number of targets
	 * changed; an unknown source changes nothing.
	 */
	private score(ref: number, reps: Map<string, Rep> | undefined, cause: Cause | undefined, now: number): number {
		return this.db.tx(() => {
			const db = this.db;
			const th = this.th;
			const nowS = unix(now);
			const d = loadSourceData(db, ref, nowS);
			if (!d) return 0;
			reps ??= reputation(db, ref);
			const ev = this.evaluate(d, reps, now);
			const src = d.source;
			if (ev.burst) {
				setFrozen(db, ref, unix(now + th.burstFreeze));
				const want = { burst: `Burst of slop tags from new installs: consensus frozen for ${Math.trunc(th.burstFreeze / HOUR)} hours` };
				syncEscalations(db, ref, 0, [], want, nowS);
			}

			let changed = 0;
			const apply = (itemRef: number, targetId: string, old: State, r: Result, input: Input, lapsing: boolean): void => {
				const dec = d.decisions.get(itemRef);
				const st = this.nextState(old, r, input, dec, lapsing, nowS);
				const caused = cause !== undefined && (cause.itemRef ?? 0) === itemRef;
				const forced = caused && cause.always === true;
				if (sameState(st, old) && !forced) return;
				const u: Update = { sourceRef: ref, itemRef, expect: old.verdict, state: st };
				if (old.verdict !== st.verdict || forced) {
					const log: LogEntry = {
						id: 0,
						at: nowS,
						platform: src.platform,
						targetType: itemRef !== 0 ? 'item' : 'source',
						targetId,
						sourceRef: ref,
						sourceKey: src.canonicalId,
						sourceName: src.name,
						from: old.verdict,
						to: st.verdict,
						reason: '',
						signals: st.signals,
						actor: 'community',
						actorName: '',
						accountId: ''
					};
					if (caused) [log.actor, log.actorName, log.accountId, log.reason] = [cause.actor, cause.actorName ?? '', cause.accountId ?? '', cause.reason];
					else if (r.rule === 2 && dec) [log.actor, log.actorName, log.accountId, log.reason] = [dec.actor, dec.actorName, dec.accountId, dec.reason];
					else if (r.rule === 1) [log.actor, log.reason] = ['appeal', communityReason(r)];
					else log.reason = communityReason(r);
					u.log = log;
				}
				if (applyUpdate(db, u)) changed++;
			};

			for (const it of ev.items) {
				apply(it.item.ref, it.item.itemId, it.item.state, it.result, it.input, it.lapsing);
				const want: Record<string, string> = {};
				if (it.result.rule === 6 && it.result.cappedBy === 'lapsed' && it.result.verdict !== '') {
					want.lapsed = `Item ${it.item.itemId}: ${escalationSummary('lapsed')}`;
				}
				syncEscalations(db, ref, it.item.ref, ['lapsed'], want, nowS);
			}
			apply(0, src.canonicalId, src.state, ev.result, ev.input, ev.lapsing);
			const want: Record<string, string> = {};
			const r = ev.result;
			if (r.rule === 6 && r.cappedBy === 'lapsed') want.lapsed = escalationSummary('lapsed');
			else if (r.rule === 6 && r.cappedBy !== '') want.capped = escalationSummary(r.cappedBy);
			// A new list verdict closes the open reports (6.3), so they no longer count.
			let openReports = d.openReports;
			if (r.verdict !== '' && r.verdict !== src.state.verdict) openReports = 0;
			if (openReports >= th.reportEscalation) want.reports = `${th.reportEscalation} or more open reports`;
			// An appeal whose code staff must check by hand is kept, not expired: the creator did their part.
			// Once it has waited as long as an unverified appeal may, it is escalated so it cannot sit forever.
			if (d.pendingManualSince > 0 && nowS - d.pendingManualSince >= seconds(th.appealExpiry)) {
				want.appeal = `Appeal filed more than ${Math.trunc(th.appealExpiry / DAY)} days ago still waits for staff to check its code`;
			}
			// A seed list entry is a review lead and never evidence (9.3): until a reviewer decides the
			// source, it only puts the source in the queue. The summary names no list: curators see it.
			if (src.reviewedAt === 0 && src.seedSuppressedAt === 0 && seedLeads(db, this.seeds, ref, nowS).length > 0) {
				want.seed = 'Seed lead, not evidence';
			}
			syncEscalations(db, ref, 0, ['capped', 'lapsed', 'reports', 'appeal', 'seed'], want, nowS);
			return changed;
		});
	}
}
