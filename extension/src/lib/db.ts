// A small promise wrapper over the extension's IndexedDB. The service worker keeps the
// canonical list, the tag queue and the activity log here; pages read the activity log.

const NAME = 'colander';
const VERSION = 1;
export type Store = 'kv' | 'tags' | 'activity';

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
	dbp ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(NAME, VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
			if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags', { keyPath: 'client_id' });
			if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { autoIncrement: true });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => {
			dbp = null;
			reject(req.error);
		};
	});
	return dbp;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function tx(store: Store, mode: IDBTransactionMode) {
	return (await openDb()).transaction(store, mode).objectStore(store);
}

export async function get<T>(store: Store, key: IDBValidKey): Promise<T | undefined> {
	return done((await tx(store, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function put(store: Store, value: unknown, key?: IDBValidKey): Promise<void> {
	await done((await tx(store, 'readwrite')).put(value, key));
}

export async function del(store: Store, key: IDBValidKey): Promise<void> {
	await done((await tx(store, 'readwrite')).delete(key));
}

export async function all<T>(store: Store): Promise<T[]> {
	return done((await tx(store, 'readonly')).getAll()) as Promise<T[]>;
}

export async function clear(store: Store): Promise<void> {
	await done((await tx(store, 'readwrite')).clear());
}

/** The newest `n` records of an auto-increment store, newest first. */
export async function latest<T>(store: Store, n: number): Promise<T[]> {
	const os = await tx(store, 'readonly');
	return new Promise((resolve, reject) => {
		const out: T[] = [];
		const req = os.openCursor(null, 'prev');
		req.onsuccess = () => {
			const c = req.result;
			if (!c || out.length >= n) return resolve(out);
			out.push(c.value as T);
			c.continue();
		};
		req.onerror = () => reject(req.error);
	});
}

/** Deletes all but the newest `keep` records of an auto-increment store. */
export async function trim(store: Store, keep: number): Promise<void> {
	const os = await tx(store, 'readwrite');
	const count = await done(os.count());
	if (count <= keep) return;
	await new Promise<void>((resolve, reject) => {
		let left = count - keep;
		const req = os.openCursor();
		req.onsuccess = () => {
			const c = req.result;
			if (!c || left <= 0) return resolve();
			c.delete();
			left--;
			c.continue();
		};
		req.onerror = () => reject(req.error);
	});
}
