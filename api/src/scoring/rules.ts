// Scoring turns tags, reports, appeals and reviewer decisions into verdicts (contracts section 9).
// rules.ts is the pure part (Go's scoring/rules.go): reputation, tag sums, the four layers and the
// verdict rules in order. engine.ts runs it against the Store and writes every change to the
// decision log.
import { SIGNALS, SLOP_TYPES, TEST_BIT, TESTS, type Signal, type Test } from '@colander/shared/verdicts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Signal masks by name (Go's lf.SigPlatformLabel and the rest), from the wire bit order. */
export const Sig = Object.fromEntries(SIGNALS.map((s, i) => [s, 1 << i])) as Record<Signal, number>;
/** The signals staff can record as AI evidence. */
export const ProvenanceSignals = Sig.platform_label | Sig.content_credentials | Sig.creator_statement | Sig.watermark;
/** The signals staff can record as source behavior. */
export const BehaviorSignals = Sig.high_volume | Sig.templated | Sig.near_duplicates | Sig.link_funnel | Sig.cross_posting;

/** Test bits in a list entry's detail byte by name (Go's lf.TestLowEffort and the rest). */
export const TestBit = Object.fromEntries(TESTS.map((t) => [t, 1 << TEST_BIT[t]])) as Record<Test, number>;
/** Tests and their detail bits, in display order (Go's lf.Tests). */
const Tests = TESTS.map((name) => ({ name, bit: TestBit[name] }));
/** Slop types in code order; code 0 is none (Go's lf.SlopTypes). */
export const SlopTypes = ['', ...SLOP_TYPES];
/** The slop type's code, 0 for none or unknown (Go's lf.SlopTypeCode). */
export const slopTypeCode = (t: string): number => Math.max(0, SlopTypes.indexOf(t));

/** Go's Duration.Hours(): whole hours plus the fraction, so weights match the Go server's bit for bit. */
const hours = (ms: number): number => Math.trunc(ms / HOUR) + (ms % HOUR) / HOUR;

/** One install's weighted tag. */
export interface Vote {
	weight: number;
	/** slop | ai_fine | not_slop */
	verdict: string;
	slopType: string;
	/** detail test bits */
	tests: number;
	platformLabel: boolean;
}

/** An active staff, curator or appeal decision. */
export interface Decision {
	/** a verdict or "none" */
	verdict: string;
	signals: number;
	slopType: string;
	tests: number;
}

/** One evidence layer's outcome. */
export interface Layer {
	met: boolean;
	signals: number;
}

/** Everything the rules read for one target. */
export interface Input {
	item: boolean;
	/** one per install */
	votes: Vote[];
	/** distinct installs that saw a platform AI label on the target itself */
	labelInstalls: number;
	decision: Decision | undefined;
	appealOpen: boolean;
	/** burst detection froze the consensus layer */
	frozen: boolean;

	// Sources only. A seed list entry is never an input: it is a review lead, not evidence (9.3).
	/** staff set it large, or (with YOUTUBE_DERIVED_USE) the YouTube Data API reported 100,000 subscribers */
	large: boolean;
	/** staff recorded the source's size, or (with YOUTUBE_DERIVED_USE) the YouTube Data API reported subscribers */
	audienceKnown: boolean;
	/** from the YouTube Data API with YOUTUBE_DERIVED_USE only; < 0 when unknown */
	uploadsPerDay: number;
	/** items with evidence either way */
	itemsSeen: number;
	/** of those, items with independent AI evidence (labels from 2 installs or a reviewer) */
	aiItems: number;
	/**
	 * Distinct installs that saw a platform AI label on the source or any of its items. Item labels
	 * count toward provenance only while the source is not mixed.
	 */
	rollupLabelInstalls: number;

	// Items only: the behavior layer, verdict and mixedness of the item's source.
	sourceBehavior: Layer;
	sourceVerdict: string;
	sourceMixed: boolean;

	/** keeps a lapsed Slop verdict at Likely slop until a reviewer looks again */
	lapseHold: boolean;
}

/** An Input with Go's zero values for every field not given (Go's Input{...} literal). */
export function newInput(fields: Partial<Input>): Input {
	return {
		item: false,
		votes: [],
		labelInstalls: 0,
		decision: undefined,
		appealOpen: false,
		frozen: false,
		large: false,
		audienceKnown: false,
		uploadsPerDay: 0,
		itemsSeen: 0,
		aiItems: 0,
		rollupLabelInstalls: 0,
		sourceBehavior: { met: false, signals: 0 },
		sourceVerdict: '',
		sourceMixed: false,
		lapseHold: false,
		...fields
	};
}

/** The weighted tag sums of 9.2. */
export interface Sums {
	s: number;
	a: number;
	n: number;
	t: number;
	installs: number;
}

/** The outcome of the rules for one target. */
export interface Result {
	/** "" when not rated */
	verdict: string;
	signals: number;
	slopType: string;
	tests: number;
	/** the 9.4 rule that matched, 0 when none did */
	rule: number;
	/**
	 * What rules 3 to 8 say, before a rule 6 cap and before appeals and decisions, so the review
	 * queue shows "scoring says Slop" for a source held at Likely slop.
	 */
	computed: string;
	provenance: Layer;
	behavior: Layer;
	rubric: Layer;
	consensus: Layer;
	notSlop: boolean;
	split: boolean;
	mixed: boolean;
	sums: Sums;
	/**
	 * Why rule 6 held Slop at Likely slop: "large", "audience" (size unknown) or "lapsed". It raises
	 * an escalation only while rule 6 decides (rule === 6).
	 */
	cappedBy: string;
}

const noLayer = (): Layer => ({ met: false, signals: 0 });

/** Computes S, A, N, T and n. */
export function sumVotes(votes: Vote[]): Sums {
	const s: Sums = { s: 0, a: 0, n: 0, t: 0, installs: 0 };
	for (const v of votes) {
		switch (v.verdict) {
			case 'slop':
				s.s += v.weight;
				break;
			case 'ai_fine':
				s.a += v.weight;
				break;
			case 'not_slop':
				s.n += v.weight;
				break;
		}
	}
	s.t = s.s + s.a + s.n;
	s.installs = votes.length;
	return s;
}

/** The weighted plurality among slop votes that named a type. */
function slopType(votes: Vote[]): string {
	let best = '',
		bestW = 0;
	for (const t of SlopTypes.slice(1)) {
		let w = 0;
		for (const v of votes) if (v.verdict === 'slop' && v.slopType === t) w += v.weight;
		if (w > bestW) [best, bestW] = [t, w];
	}
	return best;
}

/** Orders the evidence-based verdicts. */
const severity: Record<string, number> = { ai_made: 1, likely_slop: 2, slop: 3 };
const sev = (v: string): number => severity[v] ?? 0;

/**
 * Every tunable number from contracts section 9 in one place, holding the contract's starting
 * values. Durations are milliseconds.
 */
export class Thresholds {
	// Reputation (9.1).
	baseWeight = 0.1;
	minWeight = 0.05;
	maxWeight = 1.0;
	maturityDays = 30;

	// Provenance (9.3).
	labelInstalls = 2;
	aiConsensusSum = 3;
	aiConsensusInstalls = 3;
	aiConsensusRatio = 0.7;

	// Behavior (9.3).
	uploadsPerDay = 10;
	mostlyAIShare = 0.8;
	mostlyAIMinItems = 5;

	// Rubric (9.3).
	rubricShare = 0.5;

	// Consensus (9.3).
	slopSum = 3;
	slopInstalls = 3;
	slopRatio = 0.7;
	notSlopSum = 3;
	notSlopRatio = 0.7;
	splitSlop = 2;
	splitOther = 2;
	splitLow = 0.3;
	splitHigh = 0.7;

	// Size, expiry and brigading (9.5).
	largeSubscribers = 100_000;
	rescore = 90 * DAY;
	burstTags = 20;
	burstWindow = HOUR;
	burstInstallAge = 7 * DAY;
	burstFreeze = 72 * HOUR;
	reportEscalation = 3;

	// Scheduling and appeals.
	passInterval = 5 * MINUTE;
	debounce = 5_000;
	appealExpiry = 14 * DAY;

	/**
	 * An install's tag weight (9.1); firstTag and now are unix milliseconds. It reads only tagging
	 * history: plan, payment and donation state are never inputs.
	 */
	weight(firstTag: number, now: number, agree: number, decided: number): number {
		const maturity = Math.min(1, Math.max(0, hours(now - firstTag) / 24 / this.maturityDays));
		const accuracy = (agree + 1) / (decided + 2);
		const w = this.baseWeight + (1 - this.baseWeight) * maturity * accuracy;
		return Math.min(this.maxWeight, Math.max(this.minWeight, w));
	}

	provenance(input: Input, s: Sums, mixed: boolean): Layer {
		const l = noLayer();
		let labels = input.labelInstalls;
		if (!input.item && !mixed) labels = Math.max(labels, input.rollupLabelInstalls);
		if (labels >= this.labelInstalls) [l.met, l.signals] = [true, Sig.platform_label];
		if (input.decision && (input.decision.signals & ProvenanceSignals) !== 0) {
			[l.met, l.signals] = [true, l.signals | (input.decision.signals & ProvenanceSignals)];
		}
		if (s.s + s.a >= this.aiConsensusSum && s.installs >= this.aiConsensusInstalls && s.t > 0 && (s.s + s.a) / s.t >= this.aiConsensusRatio) {
			l.met = true;
		}
		return l;
	}

	behavior(input: Input): Layer {
		if (input.item) return input.sourceBehavior;
		const l = noLayer();
		if (input.uploadsPerDay >= this.uploadsPerDay) [l.met, l.signals] = [true, Sig.high_volume];
		if (input.itemsSeen >= this.mostlyAIMinItems && input.aiItems / input.itemsSeen >= this.mostlyAIShare) {
			[l.met, l.signals] = [true, l.signals | Sig.mostly_ai];
		}
		if (input.decision && (input.decision.signals & BehaviorSignals) !== 0) {
			[l.met, l.signals] = [true, l.signals | (input.decision.signals & BehaviorSignals)];
		}
		return l;
	}

	/**
	 * The tests chosen by a weighted share of slop votes at or above the rubric share, with
	 * mass_produced also passing when behavior is met.
	 */
	passingTests(votes: Vote[], s: Sums, behaviorMet: boolean): number {
		let bits = 0;
		if (s.s > 0) {
			for (const t of Tests) {
				let w = 0;
				for (const v of votes) if (v.verdict === 'slop' && (v.tests & t.bit) !== 0) w += v.weight;
				if (w / s.s >= this.rubricShare) bits |= t.bit;
			}
		}
		if (behaviorMet) bits |= TestBit.mass_produced;
		return bits;
	}

	rubric(tests: number, s: Sums): Layer {
		const l = noLayer();
		if (s.s < 1) return l;
		const n = Tests.filter((t) => (tests & t.bit) !== 0).length;
		if (n >= 2) {
			l.met = true;
			if ((tests & TestBit.low_effort) !== 0) l.signals |= Sig.rubric_low_effort;
			if ((tests & TestBit.hollow) !== 0) l.signals |= Sig.rubric_hollow;
		}
		return l;
	}

	/** Applies the layers and the verdict rules of 9.4, first match wins. */
	score(input: Input): Result {
		const s = sumVotes(input.votes);
		const r: Result = {
			verdict: '',
			signals: 0,
			slopType: '',
			tests: 0,
			rule: 0,
			computed: '',
			provenance: noLayer(),
			behavior: noLayer(),
			rubric: noLayer(),
			consensus: noLayer(),
			notSlop: false,
			split: false,
			mixed: false,
			sums: s,
			cappedBy: ''
		};
		r.mixed = !input.item && input.itemsSeen >= this.mostlyAIMinItems && input.aiItems / input.itemsSeen < this.mostlyAIShare;
		r.provenance = this.provenance(input, s, r.mixed);
		r.behavior = this.behavior(input);
		const tests = this.passingTests(input.votes, s, r.behavior.met);
		r.rubric = this.rubric(tests, s);
		if (!input.frozen && s.s >= this.slopSum && s.installs >= this.slopInstalls && s.s / s.t >= this.slopRatio) {
			r.consensus = { met: true, signals: Sig.community_consensus };
		}
		r.notSlop = s.n >= this.notSlopSum && s.t > 0 && s.n / s.t >= this.notSlopRatio;
		r.split = s.s >= this.splitSlop && s.n + s.a >= this.splitOther && s.t > 0 && s.s / s.t >= this.splitLow && s.s / s.t <= this.splitHigh;

		// Only met layers carry signals, so this is the union of the signals of the met layers.
		const evidence = r.provenance.signals | r.behavior.signals | r.rubric.signals | r.consensus.signals;

		// Rules 3 to 8 give the computed verdict, which the review queue shows next to the list verdict.
		if (r.notSlop) {
			[r.rule, r.computed, r.signals] = [3, 'clear', Sig.not_slop_consensus];
		} else if (!r.provenance.met) {
			r.rule = 4;
		} else if (r.split) {
			[r.rule, r.computed, r.signals] = [5, 'disputed', evidence];
		} else if (r.behavior.met && r.consensus.met && !r.mixed) {
			[r.rule, r.computed, r.signals] = [6, 'slop', evidence];
			// Only a reviewer makes a source Slop when it is large or of unknown size.
			if (!input.item && input.large) r.cappedBy = 'large';
			else if (!input.item && !input.audienceKnown) r.cappedBy = 'audience';
			else if (input.lapseHold) r.cappedBy = 'lapsed';
		} else if ((r.behavior.met || r.rubric.met) && s.s >= 1 && !r.mixed) {
			[r.rule, r.computed, r.signals] = [7, 'likely_slop', evidence];
		} else {
			[r.rule, r.computed, r.signals] = [8, 'ai_made', evidence];
		}
		r.verdict = r.computed;
		if (r.cappedBy !== '') r.verdict = 'likely_slop';
		if (r.verdict === 'slop' || r.verdict === 'likely_slop') [r.slopType, r.tests] = [slopType(input.votes), tests];

		// Rules 1 and 2 override the computed verdict.
		if (input.appealOpen) {
			[r.rule, r.verdict, r.slopType, r.tests] = [1, 'disputed', '', 0];
			r.signals = evidence | Sig.open_appeal;
			if (r.notSlop) r.signals |= Sig.not_slop_consensus;
		} else if (input.decision) {
			const d = input.decision;
			[r.rule, r.verdict, r.slopType, r.tests] = [2, d.verdict, '', 0];
			if (d.verdict === 'none') [r.verdict, r.signals] = ['', 0];
			else if (d.verdict === 'clear' || d.verdict === 'disputed') r.signals = d.signals | Sig.staff_review;
			else r.signals = evidence | d.signals | Sig.staff_review;
			if (d.verdict === 'slop' || d.verdict === 'likely_slop') {
				[r.slopType, r.tests] = [d.slopType, d.tests];
				if (r.slopType === '') r.slopType = slopType(input.votes);
				if (r.tests === 0) r.tests = tests;
			}
		}

		// An item has its own verdict only when it says more than its source's. An item of a Slop
		// source that scores Likely slop alone, or an item under a source shown as Disputed for an
		// appeal, is covered by the source. Reviewer decisions on items always stand, and items of a
		// mixed source keep their own verdicts except under an appeal.
		const covered = r.verdict === input.sourceVerdict || (r.rule >= 6 && sev(r.verdict) <= sev(input.sourceVerdict));
		if (input.item && r.rule !== 2 && covered && (r.rule === 1 || !input.sourceMixed)) {
			[r.verdict, r.signals, r.slopType, r.tests] = ['', 0, '', 0];
		}
		return r;
	}
}

/** The starting values from the contract. */
export const Default: Readonly<Thresholds> = Object.freeze(new Thresholds());
