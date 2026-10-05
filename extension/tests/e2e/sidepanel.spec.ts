// The curator side panel against the review API (contract 6.7).
import { EXT_ID, REVIEW_QUEUE, REVIEW_SOURCE, expect, test } from './harness';

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
	await expect(side.getByRole('tab', { name: 'Reports 1' })).toBeVisible();
	await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
	await expect(side.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
	await expect(side.getByText('Consensus is still forming')).toBeVisible();
	await expect(side.getByText('Staged rescue videos made with AI, posted every hour.')).toBeVisible();
	expect(ext.api.sent.find((s) => s.path.startsWith('/v1/review/queue'))!.auth).toBe('Bearer rvw_test');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByRole('alert')).toContainText('Write the reason');
	await side.getByLabel('Reason, published in the decision log').fill('Staff review confirmed AI narration over generated footage, posted hourly.');
	await side.getByRole('button', { name: 'Record decision' }).click();
	await expect(side.getByText('Decision recorded.')).toBeVisible();
	const d = ext.api.posted('/v1/review/sources/yt/%40catrescuetales/decision')[0]!;
	expect(d.body).toMatchObject({ verdict: 'slop', reason: 'Staff review confirmed AI narration over generated footage, posted hourly.', signals: ['mostly_ai'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'] });
	// The panel never marks a source large: that is staff's, in the review console.
	expect(d.body).not.toHaveProperty('large');
	await expect(side.getByText('Large source, staff only')).toHaveCount(0);
});

// The reviewer token carries curator authority only, also a staff member's.
test('large sources and appeals are left to staff in the review console', async ({ ext }) => {
	ext.api.review.queue = REVIEW_QUEUE();
	const appeal = { id: 'apl_1', platform: 'yt', source_id: '@catrescuetales', status: 'under_review', code: 'CLN-7Q4K', statement: 'We film every rescue ourselves.', created_at: '2026-10-02T10:00:00Z' };
	ext.api.review.source = { ...REVIEW_SOURCE, source: { ...REVIEW_SOURCE.source, large: true }, appeals: [appeal] };
	await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
	const side = await ext.ctx.newPage();
	await side.setViewportSize({ width: 400, height: 900 });
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
	await expect(side.getByText('Cat Rescue Tales has a large audience, so only staff can decide it, in the review console on the website.')).toBeVisible();
	await expect(side.getByRole('radiogroup', { name: 'Verdict' })).toHaveCount(0);
	await expect(side.getByRole('button', { name: 'Record decision' })).toBeDisabled();
	await expect(side.getByText('Staff verify and resolve appeals in the review console on the website.')).toBeVisible();
	await expect(side.getByText('We film every rescue ourselves.')).toBeVisible();
	for (const name of ['Uphold', 'Deny', 'Code is on the account']) await expect(side.getByRole('button', { name })).toHaveCount(0);
	await side.keyboard.press('Control+Enter');
	expect(ext.api.posted('/v1/review/sources/yt/%40catrescuetales/decision')).toHaveLength(0);

	// An open appeal on a source that is not large: staff decide it until the appeal is resolved.
	ext.api.review.source = { ...REVIEW_SOURCE, appeals: [appeal] };
	await side.getByRole('button', { name: 'Queue' }).click();
	await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
	await expect(side.getByText('An appeal is open on this source, so only staff can decide it until the appeal is resolved.')).toBeVisible();
});

test('keys pick a verdict, list the shortcuts and go back', async ({ ext }) => {
	ext.api.review.queue = REVIEW_QUEUE();
	ext.api.review.source = REVIEW_SOURCE;
	await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
	const side = await ext.ctx.newPage();
	await side.setViewportSize({ width: 360, height: 800 });
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await side.getByRole('button', { name: /Cat Rescue Tales/ }).click();
	await expect(side.getByRole('heading', { name: 'Cat Rescue Tales' })).toBeVisible();
	const verdicts = side.getByRole('radiogroup', { name: 'Verdict' });
	await side.keyboard.press('2');
	await expect(verdicts.getByRole('radio', { name: /Likely slop/ })).toHaveAttribute('aria-checked', 'true');
	await side.keyboard.press('0');
	await expect(verdicts.getByRole('radio', { name: /Not rated/ })).toHaveAttribute('aria-checked', 'true');
	// Single keys never act while typing.
	await side.keyboard.press('r');
	await expect(side.getByLabel('Reason, published in the decision log')).toBeFocused();
	await side.keyboard.type('1');
	await expect(verdicts.getByRole('radio', { name: /Not rated/ })).toHaveAttribute('aria-checked', 'true');
	await side.getByRole('heading', { name: 'Cat Rescue Tales' }).click();
	await side.keyboard.press('?');
	await expect(side.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
	await side.keyboard.press('Escape');
	await expect(side.getByRole('dialog')).toHaveCount(0);
	// The decision bar stays in view at the bottom of a 360 px panel.
	const bar = await side.getByRole('button', { name: 'Record decision' }).boundingBox();
	expect(bar!.y + bar!.height).toBeLessThanOrEqual(800);
	expect(await side.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
	await side.keyboard.press('Escape');
	await expect(side.getByRole('tab', { name: 'All 1' })).toBeVisible();
});
