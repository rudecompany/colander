// Journey 5: a curator reviews within their limits. The console says up front that large sources
// and appeals need staff, the server refuses them when forced, and the side panel lets a curator
// decide a source they are allowed to decide.
import { BASE_URL, CURATOR, LOCAL_ONLY, ORIGIN } from './stack.ts';
import { expect, launch, onboard, signIn, test, type Ext } from './harness.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

test('curators see staff-only limits, the server enforces them, and the side panel decides what curators may', async () => {
	const site = await ext.ctx.newPage();
	await signIn(site, CURATOR, '/console');
	await expect(site.getByText('Curator, Sam')).toBeVisible();

	// A large channel: the form says why and stays disabled.
	await site.getByRole('button', { name: /Celebrity Gossip Narrated/ }).click();
	await expect(site.getByRole('heading', { level: 2, name: 'Celebrity Gossip Narrated' })).toBeVisible();
	await expect(site.getByRole('status').filter({ hasText: 'Staff decision needed' })).toContainText('has a large audience, so only staff can decide it');
	await expect(site.getByRole('button', { name: 'Review decision' })).toBeDisabled();

	// An appeal under review: verifying and resolving need staff, and so does deciding the source.
	await site.getByRole('tab', { name: /^Appeals/ }).click();
	await site.getByRole('button', { name: /Ocean Mysteries Unveiled/ }).click();
	await expect(site.getByRole('heading', { level: 2, name: 'Ocean Mysteries Unveiled' })).toBeVisible();
	await expect(site.getByText('Verifying and resolving appeals needs staff.')).toBeVisible();
	await expect(site.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
	await expect(site.getByRole('status').filter({ hasText: 'Staff decision needed' })).toContainText('An appeal is open on this source');

	// A seed lead: curators see that a seed list names the source, never which list.
	await site.getByRole('tab', { name: /^All/ }).click();
	await site.getByRole('button', { name: /Seed lead/ }).first().click();
	await expect(site.getByRole('region', { name: 'Seed lists' })).toContainText('Which lists name it is for staff only.');
	await expect(site.locator('main')).not.toContainText(/demo list/i);

	// Forced past the console, the server answers 403 staff_required.
	const forced = await site.evaluate(async () => {
		const post = async (path: string, body: unknown) => {
			const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Colander-CSRF': '1' }, body: JSON.stringify(body) });
			return [res.status, ((await res.json()) as { error?: { code: string } }).error?.code];
		};
		const kindness = await (await fetch('/v1/review/sources/fb/kindness.stories.daily')).json();
		const pending = kindness.appeals.find((a: { status: string }) => a.status === 'pending_manual');
		return {
			large: await post('/v1/review/sources/yt/%40gossipnarrated/decision', { verdict: 'slop', reason: 'Forced past the console by a curator.', signals: [], slop_type: null, tests: [] }),
			verify: await post(`/v1/review/appeals/${pending.id}/verify`, {}),
			resolve: await post(`/v1/review/appeals/${pending.id}/resolve`, { outcome: 'upheld', reasoning: 'Forced past the console by a curator.' })
		};
	});
	expect(forced).toEqual({ large: [403, 'staff_required'], verify: [403, 'staff_required'], resolve: [403, 'staff_required'] });

	// The side panel: the account page hands the reviewer token to the extension.
	await site.goto(`${ORIGIN}/account`);
	await site.getByRole('button', { name: 'Connect side panel' }).click();
	await expect(site.getByText('Connected. The side panel can now open the review queue.')).toBeVisible();
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	await side.getByRole('button', { name: /Fitness Tips AI/ }).click();
	await expect(side.getByRole('heading', { level: 2, name: 'Fitness Tips AI' })).toBeVisible();
	await expect(side.getByText('Every post pushes the same supplement link.')).toBeVisible();
	await side.getByRole('radiogroup', { name: 'Verdict' }).getByRole('radio', { name: /^Likely slop/ }).click();
	await side.getByLabel('Reason, published in the decision log').fill('Generated workout images, each one funneling to the same supplement shop.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByText('Decision recorded.')).toBeVisible();

	await site.goto(`${ORIGIN}/log`);
	const entry = site.locator('ol.entries > li').first();
	await expect(entry.locator('.src')).toHaveText('Fitness Tips AI');
	await expect(entry).toContainText('funneling to the same supplement shop');
	await expect(entry).toContainText('Sam');
});
