// Firefox's built-in consent for data collection (contracts 8). The manifest declares two optional
// kinds: websiteContent for tags and reports, which carry what was seen on a page and the install
// ID, and authenticationInfo for the requests that carry or fetch a plan or reviewer token. Firefox
// grants neither at install, so each waits until the person allows it. Other browsers disclose the
// same data in their store listing and need no runtime consent.
import { browser } from 'wxt/browser';

export type DataKind = 'websiteContent' | 'authenticationInfo';

// The typed Browser namespace is Chrome's, which has no data_collection permission.
type DataPermissions = { data_collection: DataKind[] };
const permissions = browser.permissions as unknown as {
	contains(p: DataPermissions): Promise<boolean>;
	request(p: DataPermissions): Promise<boolean>;
};

/** Whether this kind of data may leave the device now. */
export function allowed(kind: DataKind): Promise<boolean> {
	if (!import.meta.env.FIREFOX) return Promise.resolve(true);
	return permissions.contains({ data_collection: [kind] }).catch(() => false);
}

/** Asks for the kinds still missing. Call it first thing in a click handler, or Firefox refuses. */
export function ask(kinds: DataKind[]): Promise<boolean> {
	if (!import.meta.env.FIREFOX) return Promise.resolve(true);
	return permissions.request({ data_collection: kinds }).catch(() => false);
}
