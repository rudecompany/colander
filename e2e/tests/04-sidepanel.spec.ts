// Journey 6: a staff member connects the review side panel from the website (externally_connectable)
// after an admin invited them to a passkey, works the real queue there with curator authority, and
// is pointed to the admin console for what only staff decide.
import { ADMIN, BASE_URL, LOCAL_ONLY, ORIGIN, STAFF } from './stack.ts';
import { enrollReviewer, expect, launch, onboard, test, type Ext } from './harness.ts';

test.skip(!!BASE_URL, LOCAL_ONLY);

let ext: Ext;
test.beforeAll(async () => {
	ext = await launch();
	await onboard(ext);
});
test.afterAll(async () => {
	await ext?.close();
});

test('the account page hands the reviewer token to the side panel, which reviews with curator authority', async () => {
	const side = await ext.page('sidepanel.html');
	await side.setViewportSize({ width: 400, height: 900 });
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();

	const site = await ext.ctx.newPage();
	await enrollReviewer(site, STAFF, ADMIN);
	await site.goto(`${ORIGIN}/account`);
	await expect(site.getByRole('heading', { name: 'Hello, Rae' })).toBeVisible();
	await site.getByRole('button', { name: 'Connect side panel' }).click();
	await expect(site.getByRole('status').filter({ hasText: 'Connected until' })).toBeVisible();
	await expect(site.getByText('The side panel is connected until', { exact: false })).toBeVisible();
	const token = await ext.storage<string>('reviewerToken');
	expect(token).toMatch(/^colander_rt_/);

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
	await side.getByRole('radiogroup', { name: 'Verdict' }).getByRole('radio', { name: /^Slop/ }).click();
	await side.getByLabel('Reason, published in the decision log').fill('Synthetic narration over celebrity photos, nineteen uploads a day.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByRole('alert')).toContainText('staff decide large sources and appeals in the admin console');

	// Disconnecting on the website ends the token: the panel asks to connect again.
	await site.getByRole('button', { name: 'Disconnect' }).click();
	await expect(site.getByText('Disconnected.', { exact: false })).toBeVisible();
	await side.reload();
	await expect(side.getByText('Your reviewer token was not accepted.', { exact: false })).toBeVisible();
});
