// Who is signed in on the admin host, from GET /v1/admin/me (docs/contracts.md 6.9). Cloudflare
// Access signs staff in before any page loads; the Worker resolves the identity to a staff or
// admin account and answers 403 not_staff for anyone else.
import type { Person, Role } from '@colander/shared/api';
import { api, ApiError, errorText } from './api';

export interface Me {
	account: Person;
	authority: Role;
	permissions: string[];
}

export const admin = $state<{ status: 'loading' | 'ready' | 'error'; me: Me | null; code: string; message: string }>({
	status: 'loading',
	me: null,
	code: '',
	message: ''
});

export async function loadMe(): Promise<void> {
	if (admin.status === 'ready') return;
	try {
		admin.me = await api<Me>('/v1/admin/me', { stepUp: false });
		admin.status = 'ready';
	} catch (e) {
		admin.code = e instanceof ApiError ? e.code : '';
		admin.message = errorText(e);
		admin.status = 'error';
	}
}

/** Whether the signed-in staff member may do this (the server checks again). */
export const may = (permission: string): boolean => admin.me?.permissions.includes(permission) ?? false;
