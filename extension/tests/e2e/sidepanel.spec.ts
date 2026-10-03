// The curator side panel against the review API (contract 6.7).
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, SHOTS, expect, test } from './harness';

test('sign-in state for people without a reviewer token', async ({ ext }) => {
	const side = await ext.ctx.newPage();
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();
	await expect(side.getByRole('button', { name: 'Open my account' })).toBeVisible();
});

test('queue, evidence and a decision', async ({ ext }) => {
	ext.api.review.queue = REVIEW_QUEUE();
	ext.api.review.source = REVIEW_SOURCE;
	await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
	const side = await ext.ctx.newPage();
	await side.setViewportSize({ width: 400, height: 900 });
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await expect(side.getByRole('button', { name: /Cat Rescue Tales/ })).toBeVisible();
	if (SHOTS) await side.screenshot({ path: 'screenshots/sidepanel-queue-light.png', animations: 'disabled' });
	await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
	await expect(side.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
	await expect(side.getByText('Consensus is still forming')).toBeVisible();
	await expect(side.getByText('Fake rescue videos made with AI, posted every hour.')).toBeVisible();
	expect(ext.api.sent.find((s) => s.path.startsWith('/v1/review/queue'))!.auth).toBe('Bearer rvw_test');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByRole('alert')).toContainText('Write the reason');
	await side.getByLabel('Reason, published in the decision log').fill('Staff review confirmed AI narration over generated footage, posted hourly.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByText('Decision recorded.')).toBeVisible();
	const d = ext.api.posted('/v1/review/sources/yt/%40catrescuetales/decision')[0]!;
	expect(d.body).toMatchObject({ verdict: 'slop', reason: 'Staff review confirmed AI narration over generated footage, posted hourly.', signals: ['mostly_ai'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'], large: false });
	await side.evaluate(() => scrollTo(0, 0));
	if (SHOTS) await side.screenshot({ path: 'screenshots/sidepanel-evidence-light.png', animations: 'disabled' });
	await side.getByRole('heading', { name: 'Decision' }).scrollIntoViewIfNeeded();
	await side.evaluate(() => scrollBy(0, -56));
	if (SHOTS) await side.screenshot({ path: 'screenshots/sidepanel-decision-light.png', animations: 'disabled' });
	await side.emulateMedia({ colorScheme: 'dark' });
	await side.evaluate(() => scrollTo(0, 0));
	if (SHOTS) await side.screenshot({ path: 'screenshots/sidepanel-evidence-dark.png', animations: 'disabled' });
});
