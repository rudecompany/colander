// Account deletion and the actions held for a few days (docs/contracts.md 6.6 and 6.8).
//
// Deleting an account settles billing with Stripe first, then records the erasure in the backup
// bucket, then deletes the rows in one transaction and confirms by email. The record outlives every
// dump (the bucket's lifecycle deletes both after 90 days, the record later), so a restore of a dump
// or of an earlier point in time deletes the account again before it serves (reapplyErasures).
import { emailRef } from './auth';
import { accountDeleted, emailChanged } from './mail';
import { rank } from './permissions';
import {
	accountByEmail,
	audit,
	cancelRequest,
	deleteAccount,
	deletePasskey,
	dueRequests,
	finishRequest,
	getAccount,
	revokeCredentials,
	type AuditEntry,
	type HeldRequest
} from './store/accounts';
import type { Store } from './store/store';

/** Erasure records live under this prefix of the backup bucket, one empty object per account ID. */
export const ERASURE_PREFIX = 'erasures/';

/**
 * Staff and admin accounts are never deleted, by their owner or by a held request: their mailbox
 * alone would be enough, and deleting the last admin would reopen the ops bootstrap. An admin
 * lowers the role on the admin host first.
 */
export class StaffAccountError extends Error {
	constructor() {
		super('staff and admin accounts are not deleted');
	}
}

/** Whether the role keeps its account from deletion (StaffAccountError). */
export const undeletable = (role: string): boolean => rank(role) >= rank('staff');

/**
 * Deletes an account: ends Plus (refunding when refundable) and deletes its Stripe customers,
 * records the erasure, deletes the rows, and mails the confirmation. Throws StaffAccountError for
 * a staff or admin account, and the billing error (UnavailableError or StripeError), before
 * anything is deleted.
 */
export async function eraseAccount(store: Store, accountId: string, who: Omit<AuditEntry, 'action' | 'target'>): Promise<boolean> {
	const account = getAccount(store.db, accountId);
	if (!account) return false;
	if (undeletable(account.role)) throw new StaffAccountError();
	await store.billing.closeAccount(accountId, Math.floor(store.now() / 1000));
	await store.backups.put(ERASURE_PREFIX + accountId, '', { customMetadata: { at: new Date(store.now()).toISOString() } });
	const deleted = deleteAccount(store.db, accountId, Math.floor(store.now() / 1000), who);
	if (deleted) await sendQuietly(store, account.email, accountDeleted());
	return deleted;
}

/** After a restore: deletes again every account erased since. Returns how many it deleted. */
export async function reapplyErasures(store: Store, env: Pick<Env, 'BACKUPS'>): Promise<number> {
	let erased = 0;
	let cursor: string | undefined;
	do {
		const page = await env.BACKUPS.list({ prefix: ERASURE_PREFIX, cursor });
		for (const o of page.objects) {
			const id = o.key.slice(ERASURE_PREFIX.length);
			if (deleteAccount(store.db, id, Math.floor(store.now() / 1000), { host: 'ops', reason: 'erased again after a restore' })) erased++;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return erased;
}

/** Sends one email; a failure is logged, never thrown, because the action it reports is done. */
export async function sendQuietly(store: Store, to: string, [subject, text]: [string, string]): Promise<void> {
	try {
		await store.mailer.send(to, subject, text);
	} catch (err) {
		console.error(JSON.stringify({ message: 'email not sent', subject, error: String(err) }));
	}
}

/**
 * Runs the held requests whose time has come: deletions, passkey removals and email changes. A
 * held export only becomes downloadable, so it is just marked done. A request cancelled meanwhile
 * does nothing. Returns when to run next.
 */
export async function runHeldRequests(store: Store, now: number): Promise<number> {
	const s = Math.floor(now / 1000);
	for (const r of dueRequests(store.db, s)) {
		try {
			await runOne(store, r, s);
		} catch (err) {
			console.error(JSON.stringify({ message: 'held request failed', kind: r.kind, error: String(err) }));
		}
	}
	return now + 3_600_000;
}

async function runOne(store: Store, r: HeldRequest, s: number): Promise<void> {
	const db = store.db;
	const job = { host: 'job' as const, reason: `held request ${r.id}` };
	switch (r.kind) {
		case 'delete':
			// Billing is settled first; finishing the request after the deletion is a no-op then. An
			// account that became staff while the request waited is kept, and the request ends.
			try {
				await eraseAccount(store, r.accountId, job);
			} catch (err) {
				if (!(err instanceof StaffAccountError)) throw err;
				refuse(store, r, s, 'staff and admin accounts are not deleted');
			}
			return;
		case 'export':
			finishRequest(db, r.id, s);
			return;
		case 'remove_passkey':
			db.tx(() => {
				if (!finishRequest(db, r.id, s)) return;
				if (deletePasskey(db, r.accountId, r.arg)) audit(db, { ...job, action: 'passkey_removed', target: r.accountId, before: r.arg }, s);
			});
			return;
		case 'email_change': {
			const account = getAccount(db, r.accountId);
			if (!account) return;
			// Support moves member accounts only (contracts 6.9): one promoted while the change waited
			// is re-onboarded instead.
			if (account.role !== 'member') {
				refuse(store, r, s, 'only member accounts move to a new address');
				return;
			}
			const moved = db.tx(() => {
				if (accountByEmail(db, r.arg) || !finishRequest(db, r.id, s)) return false;
				db.run('UPDATE accounts SET email = ? WHERE id = ?', r.arg, r.accountId);
				revokeCredentials(db, r.accountId);
				audit(db, { ...job, actorId: r.actorId || undefined, action: 'email_changed', target: r.accountId, before: emailRef(account.email), after: emailRef(r.arg) }, s);
				return true;
			});
			if (moved) {
				await sendQuietly(store, account.email, emailChanged(r.arg));
				await sendQuietly(store, r.arg, emailChanged(r.arg));
			}
			return;
		}
	}
}

/** Ends a held request that may no longer run, with the reason in the audit log. */
function refuse(store: Store, r: HeldRequest, s: number, reason: string): void {
	store.db.tx(() => {
		if (cancelRequest(store.db, r.accountId, r.id, s)) audit(store.db, { host: 'job', action: `${r.kind}_refused`, target: r.accountId, reason }, s);
	});
}
