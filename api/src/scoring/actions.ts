// Reviewer decisions and appeal outcomes (Go's scoring/actions.go). Each runs in one transaction
// with its inline rescore and decision log entries (hosting plan section 2, flows 6 and 7), and the
// rescore asks for a list publication when it changed something.
import { FLAG_LARGE } from '@colander/shared/list';
import type { Account } from '../store/accounts';
import {
	AppealAwaiting,
	AppealDenied,
	AppealPendingManual,
	appealsBySource,
	AppealUnderReview,
	AppealUpheld,
	transitionAppeal,
	type Appeal
} from '../store/appeals';
import { NotFoundError } from '../store/db';
import { getSource } from '../store/sources';
import { addDecision, loadSourceData, reputation, voidCuratorDecisions } from '../store/verdicts';
import { unix, type Engine } from './engine';
import { ProvenanceSignals, slopTypeCode } from './rules';

/** A reviewer's decision on a source or one of its items. */
export interface DecisionInput {
	sourceRef: number;
	/** 0 (the default) for the source itself */
	itemRef?: number;
	/** a verdict or "none" */
	verdict: string;
	reason: string;
	signals?: number;
	slopType?: string;
	tests?: number;
	/** sources only: the staff view of the source's size */
	large?: boolean;
	/** curator | staff | appeal */
	actor: string;
	accountId?: string;
	actorName?: string;
}

/** Rejects a Slop or Likely slop decision on a target without AI evidence (Go's ErrAIEvidenceRequired). */
export class AIEvidenceRequiredError extends Error {
	constructor() {
		super('slop verdicts need AI evidence');
	}
}

/**
 * Rejects a curator's decision on a source only staff may decide (contracts 6.7). The message is
 * the API's: "Large sources need staff review."
 */
export class StaffRequiredError extends Error {
	constructor(readonly what: string) {
		super(`${what} need staff review.`);
	}
}

/**
 * The curator limits of contracts 6.7, which Go checked in its review route: curators may decide
 * items and sources that are not large, but not set a source's size, and not decide a source while
 * an appeal on it is pending_manual or under_review. Returns what needs staff, or "".
 */
function staffRequired(e: Engine, sourceRef: number, large: boolean | undefined): string {
	const src = getSource(e.db, sourceRef);
	if (!src) throw new NotFoundError();
	const isLarge = (src.state.flags & FLAG_LARGE) !== 0 || e.audience(src).large;
	if (isLarge || large !== undefined) return 'Large sources';
	if (appealsBySource(e.db, sourceRef).some((a) => a.status === AppealPendingManual || a.status === AppealUnderReview)) {
		return 'Sources with an open appeal';
	}
	return '';
}

/**
 * Whether the target's provenance layer is met without its current decision, which a new
 * decision replaces.
 */
function hasAIEvidence(e: Engine, sourceRef: number, itemRef: number): boolean {
	const now = e.now();
	const reps = reputation(e.db, sourceRef);
	const d = loadSourceData(e.db, sourceRef, unix(now));
	if (!d) throw new NotFoundError();
	d.decisions.delete(itemRef);
	const ev = e.evaluate(d, reps, now);
	if (itemRef === 0) return ev.result.provenance.met;
	return ev.items.find((it) => it.item.ref === itemRef)?.result.provenance.met ?? false;
}

/**
 * Records a decision, applies it at once and logs it, even when the verdict stays the same.
 * Slop and Likely slop need AI evidence: the target's provenance layer, or a provenance signal
 * the decision records. A curator's decision on a source also has to pass the curator limits.
 * Throws StaffRequiredError or AIEvidenceRequiredError, and then writes nothing.
 */
export function decide(e: Engine, input: DecisionInput): void {
	const itemRef = input.itemRef ?? 0;
	const signals = input.signals ?? 0;
	e.db.tx(() => {
		if (input.actor === 'curator' && itemRef === 0) {
			const what = staffRequired(e, input.sourceRef, input.large);
			if (what !== '') throw new StaffRequiredError(what);
		}
		if ((input.verdict === 'slop' || input.verdict === 'likely_slop') && (signals & ProvenanceSignals) === 0) {
			if (!hasAIEvidence(e, input.sourceRef, itemRef)) throw new AIEvidenceRequiredError();
		}
		const now = e.now();
		addDecision(
			e.db,
			{
				sourceRef: input.sourceRef,
				itemRef,
				verdict: input.verdict,
				reason: input.reason,
				signals,
				detail: slopTypeCode(input.slopType ?? '') | (input.tests ?? 0),
				actor: input.actor,
				accountId: input.accountId ?? '',
				actorName: input.actorName ?? '',
				createdAt: unix(now),
				expiresAt: unix(now + e.th.rescore)
			},
			input.large
		);
		e.rescore(input.sourceRef, { itemRef, actor: input.actor, actorName: input.actorName, reason: input.reason, always: true });
	});
}

/** Marks an appeal verified. The source becomes Disputed at once. */
export function verifyAppeal(e: Engine, a: Appeal): void {
	e.db.tx(() => {
		transitionAppeal(e.db, a.id, [AppealAwaiting, AppealPendingManual], AppealUnderReview, { verifiedAt: unix(e.now()) });
		e.rescore(a.sourceRef, {
			actor: 'appeal',
			always: true,
			reason: 'The creator verified control of the account and appealed. Shown as Disputed while staff review it.'
		});
	});
}

/**
 * Closes an appeal. Upheld records a Clear decision; denied restores the scored verdict, never a
 * curator decision made while the appeal was open. Both write the decision log with the
 * reviewer's reasoning.
 */
export function resolveAppeal(e: Engine, a: Appeal, outcome: string, reasoning: string, reviewer: Account): void {
	const now = unix(e.now());
	const status = outcome === 'upheld' ? AppealUpheld : AppealDenied;
	e.db.tx(() => {
		transitionAppeal(e.db, a.id, [AppealAwaiting, AppealPendingManual, AppealUnderReview], status, {
			resolvedAt: now,
			outcome,
			reasoning,
			resolvedBy: reviewer.id
		});
		if (outcome === 'upheld') {
			decide(e, {
				sourceRef: a.sourceRef,
				verdict: 'clear',
				reason: 'Appeal upheld. ' + reasoning,
				actor: 'appeal',
				accountId: reviewer.id,
				actorName: reviewer.displayName
			});
			return;
		}
		voidCuratorDecisions(e.db, a.sourceRef, a.createdAt, now);
		e.rescore(a.sourceRef, { actor: 'appeal', actorName: reviewer.displayName, always: true, reason: 'Appeal denied. ' + reasoning });
	});
}
