// Creator appeals (Go's store/appeals.go).
import { ConflictError, newId, NotFoundError, nullInt, nullString, placeholders, type Db } from './db';

/** Appeal statuses. */
export const AppealAwaiting = 'awaiting_verification';
export const AppealPendingManual = 'pending_manual';
export const AppealUnderReview = 'under_review';
export const AppealUpheld = 'upheld';
export const AppealDenied = 'denied';
export const AppealExpired = 'expired';

/** A creator's appeal against a source verdict. */
export interface Appeal {
	id: string;
	platform: string;
	sourceRef: number;
	/** the source's canonical ID */
	sourceId: string;
	sourceName: string;
	email: string;
	statement: string;
	code: string;
	secretHash: string;
	status: string;
	outcome: string;
	reasoning: string;
	createdAt: number;
	verifiedAt: number;
	resolvedAt: number;
}

type AppealRow = {
	id: string;
	platform: string;
	source_id: number;
	canonical_id: string;
	name: string;
	email: string;
	statement: string;
	code: string;
	secret_hash: string;
	status: string;
	outcome: string;
	reasoning: string;
	created_at: number;
	verified_at: number;
	resolved_at: number;
};

const appealCols = `a.id, a.platform, a.source_id, s.canonical_id, ifnull(s.name, '') AS name, a.email, a.statement, a.code,
	a.secret_hash, a.status, ifnull(a.outcome, '') AS outcome, ifnull(a.reasoning, '') AS reasoning, a.created_at,
	ifnull(a.verified_at, 0) AS verified_at, ifnull(a.resolved_at, 0) AS resolved_at`;

function appeals(db: Db, where: string, ...args: SqlStorageValue[]): Appeal[] {
	return db.all<AppealRow>(`SELECT ${appealCols} FROM appeals a JOIN sources s ON s.id = a.source_id WHERE ${where}`, ...args).map((r) => ({
		id: r.id,
		platform: r.platform,
		sourceRef: r.source_id,
		sourceId: r.canonical_id,
		sourceName: r.name,
		email: r.email,
		statement: r.statement,
		code: r.code,
		secretHash: r.secret_hash,
		status: r.status,
		outcome: r.outcome,
		reasoning: r.reasoning,
		createdAt: r.created_at,
		verifiedAt: r.verified_at,
		resolvedAt: r.resolved_at
	}));
}

/** Stores a new appeal awaiting verification. */
export function createAppeal(
	db: Db,
	a: Pick<Appeal, 'platform' | 'sourceRef' | 'email' | 'statement' | 'code' | 'secretHash' | 'createdAt'>
): Appeal {
	const id = newId('apl');
	db.run(
		`INSERT INTO appeals (id, platform, source_id, email, statement, code, secret_hash, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		a.platform,
		a.sourceRef,
		a.email,
		a.statement,
		a.code,
		a.secretHash,
		AppealAwaiting,
		a.createdAt
	);
	return getAppeal(db, id)!;
}

/** Loads one appeal. */
export function getAppeal(db: Db, id: string): Appeal | undefined {
	return appeals(db, 'a.id = ?', id)[0];
}

/** Lists a source's appeals, newest first. */
export function appealsBySource(db: Db, sourceRef: number): Appeal[] {
	return appeals(db, 'a.source_id = ? ORDER BY a.created_at DESC, a.rowid DESC', sourceRef);
}

/** Lists appeals in any of the given statuses, oldest first. */
export function appealsWithStatus(db: Db, ...statuses: string[]): Appeal[] {
	return appeals(db, `a.status IN (${placeholders(statuses.length)}) ORDER BY a.created_at, a.rowid`, ...statuses);
}

/** The optional fields a transition sets. */
export interface AppealChange {
	verifiedAt?: number;
	resolvedAt?: number;
	outcome?: string;
	reasoning?: string;
	resolvedBy?: string;
}

/**
 * Moves an appeal from one of the statuses in from to status, setting the given timestamps and
 * resolution fields. Throws NotFoundError for an unknown appeal and ConflictError when it is in
 * another status.
 */
export function transitionAppeal(db: Db, id: string, from: string[], status: string, set: AppealChange): void {
	db.tx(() => {
		const n = db.run(
			`UPDATE appeals SET status = ?, verified_at = coalesce(?, verified_at),
			resolved_at = coalesce(?, resolved_at), outcome = coalesce(?, outcome), reasoning = coalesce(?, reasoning),
			resolved_by = coalesce(?, resolved_by) WHERE id = ? AND status IN (${placeholders(from.length)})`,
			status,
			nullInt(set.verifiedAt ?? 0),
			nullInt(set.resolvedAt ?? 0),
			nullString(set.outcome ?? ''),
			nullString(set.reasoning ?? ''),
			nullString(set.resolvedBy ?? ''),
			id,
			...from
		);
		if (n === 0) throw getAppeal(db, id) ? new ConflictError() : new NotFoundError();
	});
}

/** Marks appeals still awaiting verification after the cutoff as expired and returns their source refs. */
export function expireAppeals(db: Db, createdBefore: number, now: number): number[] {
	return db
		.all<{ source_id: number }>(
			'UPDATE appeals SET status = ?, resolved_at = ? WHERE status = ? AND created_at < ? RETURNING source_id',
			AppealExpired,
			now,
			AppealAwaiting,
			createdBefore
		)
		.map((r) => r.source_id);
}

/** Counts open appeals and the median days from filing to resolution of decided ones (null when none). */
export function appealStats(db: Db): { open: number; medianDays: number | null } {
	const { open } = db.get<{ open: number }>(
		'SELECT count(*) AS open FROM appeals WHERE status IN (?, ?, ?)',
		AppealAwaiting,
		AppealPendingManual,
		AppealUnderReview
	)!;
	const secs = db
		.all<{ d: number }>('SELECT resolved_at - created_at AS d FROM appeals WHERE status IN (?, ?)', AppealUpheld, AppealDenied)
		.map((r) => r.d)
		.sort((a, b) => a - b);
	if (secs.length === 0) return { open, medianDays: null };
	const mid = secs.length >> 1;
	const m = secs.length % 2 === 0 ? (secs[mid - 1]! + secs[mid]!) / 2 : secs[mid]!;
	return { open, medianDays: m / 86400 };
}
