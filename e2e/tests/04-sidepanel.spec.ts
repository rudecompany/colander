// Journey 6: staff connect the review side panel from the website (externally_connectable),
// work the real queue there, and the decision lands in the public log.
import { BASE_URL, LOCAL_ONLY, ORIGIN, STAFF } from './stack.ts';
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

test('the account page hands the reviewer token to the side panel, which decides from the real queue', async () => {
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();

	const site = await ext.ctx.newPage();
	await signIn(site, STAFF, '/account');
	await expect(site.getByRole('heading', { name: 'Hello, Rae' })).toBeVisible();
	await site.getByRole('button', { name: 'Connect side panel' }).click();
	await expect(site.getByText('Connected. The side panel can now open the review queue.')).toBeVisible();
	const token = await ext.storage<string>('reviewerToken');
	expect(token).toBeTruthy();

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
