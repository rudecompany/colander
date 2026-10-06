// Journey 5: a curator reviews within their limits. Staff invite the curator to a passkey, which
// review needs; the console says up front that large sources and appeals need staff, the server
// refuses them when forced, and the side panel, connected with a reviewer code from the account
// page, lets a curator decide a source they are allowed to decide.
import { BASE_URL, CURATOR, LOCAL_ONLY, ORIGIN, STAFF } from './stack.ts';
import { enrollReviewer, expect, launch, onboard, pairWith, test, type Ext } from './harness.ts';

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
	await enrollReviewer(site, CURATOR, STAFF);
	await site.getByRole('link', { name: 'Open the review console' }).click();
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

	// A seed lead: curators see that a seed list names the source, never which list. Leads nothing
	// backs wait under Escalated, after the other escalations.
	await site.getByRole('tab', { name: /^Escalated/ }).click();
	await site.getByRole('button', { name: /Seed lead/ }).first().click();
	await expect(site.getByRole('region', { name: 'Seed lists' })).toContainText('Only staff see which lists name it, in the admin console.');
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
			resolve: await post(`/v1/review/appeals/${pending.id}/resolve`, { outcome: 'upheld', reasoning: 'Forced past the console by a curator.' }),
			suppress: await post('/v1/review/sources/yt/%40catrescuetales/suppress-seeds', { reason: 'Forced past the console by a curator.' })
		};
	});
	expect(forced).toEqual({ large: [403, 'staff_required'], verify: [403, 'staff_required'], resolve: [403, 'staff_required'], suppress: [403, 'staff_required'] });

	// The side panel: a reviewer code from the account page, typed into the panel.
	await site.goto(`${ORIGIN}/account`);
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	const review = site.locator('section', { has: site.getByRole('heading', { name: 'Review', exact: true }) });
	await pairWith(site, review, side);
	await expect(review.getByText('Connected Colander 1.0.0 in a Chromium browser.')).toBeVisible();
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
