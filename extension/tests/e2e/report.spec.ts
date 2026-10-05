// Report source (P0-6): on a channel page, pre-filled with the source and its recent items.
import { EXT_ID, expect, test } from './harness';

test('report a channel with examples, a type, tests and a note', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	const button = page.locator('yt-flexible-actions-view-model colander-ui[data-kind="report"] button');
	await expect(button).toHaveText('Report source');
	await button.click();
	const sheet = page.locator('colander-ui[data-kind="layer"] .report');
	// The handle as the page writes it.
	await expect(sheet.getByRole('heading', { name: 'Report @NASA' })).toBeVisible();
	await expect(sheet).toContainText('Step 1 of 2');
	const examples = sheet.locator('.tiles input[type="checkbox"]');
	expect(await examples.count()).toBe(6);
	for (let i = 0; i < 4; i++) await examples.nth(i).check({ force: i === 3 }).catch(() => undefined);
	// Up to three: the fourth stays unchecked and disabled.
	await expect(examples.nth(3)).not.toBeChecked();
	await expect(examples.nth(3)).toBeDisabled();

	await sheet.getByRole('button', { name: 'Next' }).click();
	await expect(sheet).toContainText('Step 2 of 2');
	// Only the body scrolls: Back and Send report stay inside the sheet without scrolling it.
	const box = (await sheet.boundingBox())!;
	for (const name of ['Back', 'Send report']) {
		const b = (await sheet.getByRole('button', { name }).boundingBox())!;
		expect(b.y + b.height, name).toBeLessThanOrEqual(box.y + box.height);
	}
	await sheet.getByRole('button', { name: 'Send report' }).click();
	await expect(sheet.getByRole('alert')).toHaveText('Choose a type or a test, or add a note, so reviewers know what to look for.');
	await sheet.getByLabel(/Filler/).check();
	await sheet.getByLabel(/Mass-produced/).check();
	await sheet.getByLabel('Note, optional').fill('Posts 40 AI history videos a day with the same voice.');
	await sheet.getByRole('button', { name: 'Send report' }).click();
	await expect(sheet).toContainText('Report received. Track it in My reports.');

	const [sent] = ext.api.posted('/v1/reports');
	const body = sent!.body as Record<string, unknown>;
	expect(Object.keys(body).sort()).toEqual(['client_id', 'examples', 'ext_version', 'platform', 'reason', 'slop_type', 'source_id', 'source_name', 'tests'].sort());
	expect(body).toMatchObject({ platform: 'yt', source_id: '@nasa', source_name: 'NASA', slop_type: 'filler', tests: ['mass_produced'], reason: 'Posts 40 AI history videos a day with the same voice.' });
	expect((body.examples as string[]).length).toBe(3);
	expect(sent!.auth).toMatch(/^Install /);
	expect(JSON.stringify(body)).not.toContain('youtube.com');

	const opened = ext.ctx.waitForEvent('page');
	await sheet.getByRole('button', { name: 'My reports' }).click();
	const reports = await opened;
	await expect(reports).toHaveURL(`chrome-extension://${EXT_ID}/options.html#reports`);
	await expect(reports.locator('summary').getByText('Under review')).toBeVisible();
	await reports.locator('summary', { hasText: 'NASA' }).click();
	await expect(reports.getByRole('link', { name: 'Source page' })).toHaveAttribute('href', 'http://localhost:8787/s/yt/@nasa');
});

test('keyboard: the sheet hands focus back to Report source, and fits a narrow window', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	const button = page.locator('colander-ui[data-kind="report"] button');
	const sheet = page.locator('colander-ui[data-kind="layer"] .report');
	await button.focus();
	await page.keyboard.press('Enter');
	await expect(sheet).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toHaveCount(0);
	await expect(button).toBeFocused();
	await page.keyboard.press('Enter');
	await sheet.getByRole('button', { name: 'Close' }).focus();
	await page.keyboard.press('Enter');
	await expect(sheet).toHaveCount(0);
	await expect(button).toBeFocused();

	// In a 390 px window (or at 400% zoom) it keeps 16 px from both edges, on both steps.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.keyboard.press('Enter');
	for (const step of [1, 2]) {
		const box = (await sheet.boundingBox())!;
		expect(box.x, `step ${step}`).toBeGreaterThanOrEqual(16);
		expect(box.x + box.width, `step ${step}`).toBeLessThanOrEqual(390 - 16);
		if (step === 1) await sheet.getByRole('button', { name: 'Next' }).click();
	}
});

test('without a note, the type and tests become the reason', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	await page.locator('colander-ui[data-kind="report"] button').click();
	const sheet = page.locator('colander-ui[data-kind="layer"] .report');
	await sheet.getByRole('button', { name: 'Next' }).click();
	await sheet.getByLabel(/Bait/).check();
	await sheet.getByLabel(/Hollow/).check();
	await sheet.getByRole('button', { name: 'Send report' }).click();
	await expect(sheet).toContainText('Report received.');
	const body = ext.api.posted('/v1/reports')[0]!.body as Record<string, unknown>;
	expect(body).toMatchObject({ slop_type: 'bait', tests: ['hollow'], reason: 'Bait: routes you to a link, product, install or scam. Hollow.', examples: [] });
});

const pending = { platform: 'yt', source_name: null, status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' };

test('a fresh install sends no install ID on its hourly sync (P0-11)', async ({ ext }) => {
	await ext.setup();
	await ext.send({ type: 'sync-now' });
	expect(ext.api.sent.length).toBeGreaterThan(0);
	expect(ext.api.sent.filter((s) => s.auth !== undefined)).toEqual([]);

	// Once a report waits for a verdict, the sync asks for its status, and stops once it has one.
	await ext.send({ type: 'report', report: { platform: 'yt', sourceId: '@aihistorydaily', examples: [], reason: 'Same voice on every video.' } });
	const statusChecks = () => ext.api.sent.filter((s) => s.method === 'GET' && s.path === '/v1/reports');
	await ext.send({ type: 'sync-now' });
	expect(statusChecks()).toHaveLength(1);
	expect(statusChecks()[0]!.auth).toMatch(/^Install /);
	ext.api.reports = [{ ...ext.api.reports[0]!, status: 'slop', verdict: 'slop' }];
	await ext.send({ type: 'sync-now' });
	await ext.send({ type: 'sync-now' });
	expect(statusChecks()).toHaveLength(2);
});

test('a report verdict raises the attention state and shows in My reports', async ({ ext }) => {
	await ext.setup();
	ext.api.reports = [{ ...pending, id: 'rpt_1', source_id: '@aihistorydaily', source_name: 'AI History Daily' }];
	// The report is in the local copy, as after sending it or opening My reports.
	await ext.send({ type: 'refresh-reports' });
	ext.api.reports = [{ ...ext.api.reports[0]!, status: 'slop', verdict: 'slop', protects: 1240 }];
	await ext.send({ type: 'sync-now' });
	expect((await ext.storage<{ reportsUpdated: boolean }>('status')).reportsUpdated).toBe(true);
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	await expect(popup.getByText('A report you sent has a verdict.')).toBeVisible();
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#reports`);
	await expect(opts.locator('summary [data-v="slop"]')).toContainText('Slop');
	await opts.locator('summary', { hasText: 'AI History Daily' }).click();
	await expect(opts.getByText('Protects 1,240 installs')).toBeVisible();
	await expect.poll(() => ext.storage<{ reportsUpdated: boolean }>('status').then((s) => s.reportsUpdated)).toBe(false);
});

test('a dismissed report is closed calmly, without the attention dot', async ({ ext }) => {
	await ext.setup();
	ext.api.reports = [{ ...pending, id: 'rpt_1', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales' }];
	await ext.send({ type: 'refresh-reports' });
	ext.api.reports = [{ ...ext.api.reports[0]!, status: 'dismissed' }];
	await ext.send({ type: 'sync-now' });
	const status = await ext.storage<{ reportsUpdated: boolean; reportsClosed: boolean }>('status');
	expect(status).toMatchObject({ reportsUpdated: false, reportsClosed: true });
	const popup = await ext.ctx.newPage();
	await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
	await expect(popup.getByRole('radiogroup', { name: 'Strictness' })).toBeVisible();
	await expect(popup.getByText('A report you sent has a verdict.')).toHaveCount(0);
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#reports`);
	await expect(opts.getByText('Closed, no change')).toBeVisible();
	await expect.poll(() => ext.storage<{ reportsClosed: boolean }>('status').then((s) => s.reportsClosed)).toBe(false);
});
