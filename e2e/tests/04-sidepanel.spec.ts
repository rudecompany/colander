// Journey 6: staff connect the review side panel with a pairing code from the website, work the
// real queue there, and the decision lands in the public log.
import { BASE_URL, LOCAL_ONLY, ORIGIN, STAFF } from './stack.ts';
import { expect, launch, onboard, pairWith, signIn, test, type Ext } from './harness.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

test('a reviewer code from the account page connects the side panel, which decides from the real queue', async () => {
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();

	const site = await ext.ctx.newPage();
	await signIn(site, STAFF, '/account');
	await expect(site.getByRole('heading', { name: 'Hello, Rae' })).toBeVisible();
	const review = site.locator('section', { has: site.getByRole('heading', { name: 'Review', exact: true }) });
	const code = await pairWith(site, review, side);
	// The site sees the claim, with the extension's version and browser, on its next check.
	await expect(review.getByText('Connected Colander 1.0.0 in a Chromium browser.')).toBeVisible();
	const token = await ext.storage<string>('reviewerToken');
	expect(token).toBeTruthy();
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

	await gossip.click();
	await expect(side.getByRole('heading', { level: 2, name: 'Celebrity Gossip Narrated' })).toBeVisible();
	await side.getByRole('radiogroup', { name: 'Verdict' }).getByRole('radio', { name: /^Slop/ }).click();
	await side.getByLabel('Reason, published in the decision log').fill('Staff review confirmed synthetic narration over celebrity photos, nineteen uploads a day.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByText('Decision recorded.')).toBeVisible();

	await site.goto(`${ORIGIN}/log`);
	const entry = site.locator('ol.entries > li').first();
	await expect(entry.locator('.src')).toHaveText('Celebrity Gossip Narrated');
	await expect(entry.locator('.change')).toContainText('Slop');
	await expect(entry).toContainText('nineteen uploads a day');
	await expect(entry).toContainText('Rae');
});
