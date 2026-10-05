// Roles and the fixed permission table (docs/contracts.md 6.9). Authority depends on the role and
// on the host: on getcolander.com nobody acts above curator, and staff and admin authority exists
// only on the admin host behind Cloudflare Access. Every role and admin check goes through can().

export const ROLES = ['member', 'curator', 'staff', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

/** member 0, curator 1, staff 2, admin 3; anything else ranks below member. */
export const rank = (r: string): number => (ROLES as readonly string[]).indexOf(r);

/** Where a request arrived: the public host, or the admin host behind Access. */
export type Host = 'main' | 'admin';

/**
 * The authority a request acts with: the account's role, capped at curator on the main host
 * (the review console and the side panel) and in full on the admin host.
 */
export function authority(role: string, host: Host): Role | null {
	if (rank(role) < rank('curator')) return null;
	return host === 'admin' ? (role as Role) : 'curator';
}

/** Everything that needs more than a member account, and the lowest authority that may do it. */
export const PERMISSIONS = {
	/** the review queue and source detail, deciding items and sources that are not large, dismissing reports */
	review: 'curator',
	/** large sources, the large flag, verifying and resolving appeals */
	'review.staff': 'staff',
	/** the people list on the admin host */
	'people.read': 'staff',
	/** granting and revoking roles below the actor's own */
	'role.set': 'staff',
	/** passkey invites: curators by staff, staff and admin by an admin */
	'invite.issue': 'staff',
	/** ending every session, passkey and token of an account */
	'people.revoke': 'admin',
	/** changing a member's email after a support check */
	'people.email': 'admin',
	/** removing a donor's supporter credit */
	'supporters.credit': 'admin',
	/** reading the audit log */
	'audit.read': 'admin'
} as const satisfies Record<string, Role>;

export type Action = keyof typeof PERMISSIONS;

/** Who acts: an account and the authority this request gives it. */
export interface Actor {
	id: string;
	authority: Role;
}

/** The account an action is about. */
export interface Target {
	id: string;
	role: string;
	/** role.set: the role it would get */
	newRole?: string;
}

/**
 * Whether actor may do action, on target when the action has one. Roles change only on accounts
 * strictly below the actor's authority and only to roles strictly below it, never on the actor's
 * own account, and never to admin: admin is granted only through the ops channel's bootstrap.
 * Invites exist only for review roles, and only an admin invites staff or admin. Revoking and
 * email changes never touch the actor's own account, and email changes only member accounts.
 */
export function can(actor: Actor, action: Action, target?: Target): boolean {
	const a = rank(actor.authority);
	if (a < rank(PERMISSIONS[action])) return false;
	if (!target) return true;
	if (target.id === actor.id) return action === 'people.read' || action === 'audit.read';
	switch (action) {
		case 'role.set':
			return target.newRole !== undefined && isRole(target.newRole) && target.newRole !== 'admin' && rank(target.role) < a && rank(target.newRole) < a;
		case 'invite.issue':
			return rank(target.role) >= rank('curator') && (rank(target.role) < rank('staff') || actor.authority === 'admin');
		case 'people.revoke':
			return rank(target.role) < a;
		case 'people.email':
			return target.role === 'member';
		default:
			return true;
	}
}
