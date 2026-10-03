// Journey 7: the 14-day trial with no card, Plus features unlocking, and settings sync through
// the real /v1/sync in both directions.
import { CARD, SEARCH, card, expect, launch, onboard, syncNow, test, type Ext } from './harness.ts';
import { ORIGIN, api } from './stack.ts';

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

type Settings = { perPlatform: Record<string, string> };
type SyncState = { version: number; dirty: boolean };

test('the trial unlocks Plus, per-platform strictness applies, and settings sync round-trips', async () => {
	const options = await ext.page('options.html#plan');
	await expect(options.getByRole('heading', { level: 3, name: 'Free' })).toBeVisible();
	await options.getByRole('button', { name: 'Start 14-day trial, no card' }).click();
	await expect(options.getByRole('heading', { level: 3, name: 'Plus trial' })).toBeVisible();

	// The server issued the token: no card, no account, just the install.
	const trial = ext.seen.find((s) => s.method === 'POST' && s.url === `${ORIGIN}/v1/trial`)!;
	expect(trial.headers.authorization).toMatch(/^Install /);
	expect(trial.body).toBeNull();
	const token = await ext.storage<string>('planToken');
	const claims = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { plan: string; trial: boolean; exp: number; iat: number };
	expect(claims).toMatchObject({ plan: 'plus', trial: true });
	expect(claims.exp - claims.iat).toBe(14 * 86_400);
	const ends = await options.evaluate((ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), claims.exp * 1000);
	await expect(options.getByText('Your trial ends on')).toContainText(ends);

	// Plus sections are open: topics and a level per platform.
	await options.goto(options.url().replace(/#.*/, '#plus'));
	await expect(options.getByRole('button', { name: 'Add topic' })).toBeVisible();
	await options.goto(options.url().replace(/#.*/, '#strictness'));
	await options.getByLabel('YouTube').selectOption('strict');
	await expect.poll(() => ext.storage<Settings>('settings').then((s) => s.perPlatform)).toEqual({ yt: 'strict' });

	// YouTube alone now runs at Strict: Likely slop is hidden instead of collapsed.
	const page = await ext.youtube(SEARCH);
	await expect(card(page, CARD.likely)).toHaveAttribute('data-colander', 'hide');

	// The change went up with the plan token, and the server holds it under the version the extension knows.
	await expect.poll(() => ext.storage<SyncState>('syncState')).toMatchObject({ dirty: false, version: 1 });
	const put = ext.seen.filter((s) => s.method === 'PUT' && s.url === `${ORIGIN}/v1/sync`).at(-1)!;
	expect(put.headers.authorization).toBe(`Plan ${token}`);
	const auth = `Plan ${token}`;
	const stored = await api<{ version: number; data: Settings }>('/v1/sync', { auth });
	expect(stored.status).toBe(200);
	expect(stored.json.version).toBe(1);
	expect(stored.json.data.perPlatform).toEqual({ yt: 'strict' });

	// A stale write is refused with the current blob.
	const stale = await api<{ version: number }>('/v1/sync', { method: 'PUT', auth, body: { version: 0, data: { perPlatform: {} } } });
	expect(stale.status).toBe(409);
	expect(stale.json.version).toBe(1);

	// Another browser on this plan changes the level; Sync now brings it here.
	const other = await api<{ version: number }>('/v1/sync', { method: 'PUT', auth, body: { version: 1, data: { ...stored.json.data, perPlatform: { yt: 'no_ai' } } } });
	expect(other.status).toBe(200);
	expect(other.json.version).toBe(2);
	const from = ext.seen.length;
	await (await syncNow(ext)).close();
	await expect.poll(() => ext.storage<Settings>('settings').then((s) => s.perPlatform)).toEqual({ yt: 'no_ai' });
	await expect(options.getByLabel('YouTube')).toHaveValue('no_ai');
	await expect(card(page, CARD.aiMade)).toHaveAttribute('data-colander', 'hide');
	expect(await ext.storage<SyncState>('syncState')).toEqual({ version: 2, dirty: false });
	// Taking the other browser's settings is not a local edit: nothing is written back.
	const after = ext.seen.slice(from).filter((s) => s.url === `${ORIGIN}/v1/sync`).map((s) => s.method);
	expect(after).toEqual(['GET']);
});
