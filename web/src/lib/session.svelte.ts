// The signed-in account, loaded on demand by pages that need it.
import type { Account } from '@colander/shared/api';
import { api, ApiError } from './api';

export const session = $state<{ account: Account | null; status: 'idle' | 'loading' | 'ready' | 'error' }>({
	account: null,
	status: 'idle'
});

export async function loadAccount(): Promise<Account | null> {
	session.status = 'loading';
	try {
		const res = await api<{ account: Account }>('/v1/account');
		session.account = res.account;
		session.status = 'ready';
	} catch (e) {
		session.account = null;
		session.status = e instanceof ApiError && e.status === 401 ? 'ready' : 'error';
	}
	return session.account;
}

/** Reloads the account in place, without the loading state, after a change on the account page. */
export async function refreshAccount(): Promise<void> {
	try {
		session.account = (await api<{ account: Account }>('/v1/account')).account;
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) session.account = null;
	}
}
