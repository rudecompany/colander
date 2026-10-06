// Journey 6: a staff member, whom an admin invited to a passkey, connects the review side panel
// with a pairing code from the website, works the real queue there, and the decision lands in the
// public log. The panel's 7-day token carries curator authority only, so a large source is left to
// the admin console, and disconnecting on the website ends the token.
import { ADMIN, BASE_URL, LOCAL_ONLY, ORIGIN, STAFF } from './stack.ts';
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

test('a reviewer code from the account page connects the side panel, which reviews with curator authority', async () => {
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();

	const site = await ext.ctx.newPage();
	await enrollReviewer(site, STAFF, ADMIN);
	await site.goto(`${ORIGIN}/account`);
	await expect(site.getByRole('heading', { name: 'Hello, Rae' })).toBeVisible();
	const review = site.locator('section', { has: site.getByRole('heading', { name: 'Review', exact: true }) });
	const code = await pairWith(site, review, side);
	// The site sees the claim, with the extension's version and browser, on its next check.
	await expect(review.getByText('Connected Colander 1.0.0 in a Chromium browser.')).toBeVisible();
	await expect(review.getByText('The side panel is connected until', { exact: false })).toBeVisible();
	const token = await ext.storage<string>('reviewerToken');
	expect(token).toMatch(/^colander_rt_/);
	// The claim carried the code and nothing that identifies the install.
	const claim = ext.seen.find((s) => s.url === `${ORIGIN}/v1/pair/claim`)!;
	expect(claim.by).toBe('worker');
	expect(JSON.parse(claim.body!)).toEqual({ code: code.replace('-', ''), ext_version: '1.0.0', browser: 'chromium' });
	expect(claim.headers.authorization).toBeUndefined();

	// The open panel picks the token up from storage and loads the server's queue.
	const gossip = side.getByRole('button', { name: /Celebrity Gossip Narrated/ });
	await expect(gossip).toBeVisible();
	await expect(side.getByRole('button', { name: /Ocean Mysteries Unveiled/ })).toBeVisible();
	const queue = ext.seen.find((s) => s.url.startsWith(`${ORIGIN}/v1/review/queue`))!;
	expect(queue.by).toBe('extension');
	expect(queue.headers.authorization).toBe(`Bearer ${token}`);
	await side.screenshot({ path: 'screenshots/sidepanel-queue.png', animations: 'disabled' });

	// A large channel needs staff authority, which only the admin console gives, even to staff.
	await gossip.click();
	await expect(side.getByRole('heading', { level: 2, name: 'Celebrity Gossip Narrated' })).toBeVisible();
	await expect(side.getByText('Celebrity Gossip Narrated has a large audience, so only staff can decide it, in the admin console.')).toBeVisible();
	await expect(side.getByRole('radiogroup', { name: 'Verdict' })).toHaveCount(0);
	await expect(side.getByRole('button', { name: 'Record decision' })).toBeDisabled();

	await side.getByRole('button', { name: 'Queue' }).click();
	await side.getByRole('button', { name: /Galaxy Facts 4K/ }).click();
	await expect(side.getByRole('heading', { level: 2, name: 'Galaxy Facts 4K' })).toBeVisible();
	await side.getByRole('radiogroup', { name: 'Verdict' }).getByRole('radio', { name: /^AI-made/ }).click();
	await side.getByLabel('Reason, published in the decision log').fill('Generated space footage with a synthetic voice, labeled as AI by the platform.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByText('Decision recorded.')).toBeVisible();

	await site.goto(`${ORIGIN}/log`);
	const entry = site.locator('ol.entries > li').first();
	await expect(entry.locator('.src')).toHaveText('Galaxy Facts 4K');
	await expect(entry.locator('.change')).toContainText('AI-made');
	await expect(entry).toContainText('synthetic voice');
	await expect(entry).toContainText('Decided by curator Rae');

	// Disconnecting on the website ends the token: the panel asks for a new code.
	await site.goto(`${ORIGIN}/account`);
	await site.getByRole('button', { name: 'Disconnect' }).click();
	await expect(site.getByText('Disconnected.', { exact: false })).toBeVisible();
	await side.reload();
	await expect(side.getByRole('alert')).toHaveText('This connection has ended. Connect again with a new code from your account page.');
});
