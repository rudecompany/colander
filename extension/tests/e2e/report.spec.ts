// Report source (P0-6): on a channel page, pre-filled with the source and its recent items.
import { EXT_ID, expect, test } from './harness';

test('report a channel with examples, a reason, type and tests', async ({ ext }) => {
	await ext.setup();
	const page = await ext.open('https://www.youtube.com/@NASA/videos');
	const button = page.locator('yt-flexible-actions-view-model colander-ui[data-kind="report"] button');
	await expect(button).toHaveText('Report source');
	await button.click();
	const dialog = page.locator('colander-ui[data-kind="layer"] .dialog');
	await expect(dialog.getByRole('heading', { name: 'Report source' })).toBeVisible();
	await expect(dialog).toContainText('NASA');
	await expect(dialog).toContainText('YouTube channel · @nasa');
	const examples = dialog.locator('.examples input[type="checkbox"]');
	expect(await examples.count()).toBeGreaterThanOrEqual(6);
	for (let i = 0; i < 4; i++) await examples.nth(i).check({ force: i === 3 }).catch(() => undefined);
	// Up to three: the fourth stays unchecked and disabled.
	await expect(examples.nth(3)).not.toBeChecked();
	await expect(examples.nth(3)).toBeDisabled();

	await dialog.getByRole('button', { name: 'Send report' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Add a reason, so reviewers know what to look for.');
	await dialog.getByLabel('Reason').fill('Posts 40 AI history videos a day with the same voice.');
	await dialog.getByRole('button', { name: 'Filler' }).click();
	await dialog.getByLabel('Mass-produced').check();
	await dialog.getByRole('button', { name: 'Send report' }).click();
	await expect(dialog).toContainText('Reported. It is under review, and you can follow it in My reports.');

	const [sent] = ext.api.posted('/v1/reports');
	const body = sent!.body as Record<string, unknown>;
	expect(Object.keys(body).sort()).toEqual(['client_id', 'examples', 'ext_version', 'platform', 'reason', 'slop_type', 'source_id', 'source_name', 'tests'].sort());
	expect(body).toMatchObject({ platform: 'yt', source_id: '@nasa', source_name: 'NASA', slop_type: 'filler', tests: ['mass_produced'], reason: 'Posts 40 AI history videos a day with the same voice.' });
	expect((body.examples as string[]).length).toBe(3);
	expect(sent!.auth).toMatch(/^Install /);
	expect(JSON.stringify(body)).not.toContain('youtube.com');

	const opened = ext.ctx.waitForEvent('page');
	await dialog.getByRole('button', { name: 'Open My reports' }).click();
	const reports = await opened;
	await expect(reports).toHaveURL(`chrome-extension://${EXT_ID}/options.html#reports`);
	await expect(reports.getByText('Under review')).toBeVisible();
	await expect(reports.getByRole('link', { name: 'NASA' })).toHaveAttribute('href', 'http://localhost:8787/s/yt/@nasa');
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
	await expect(opts.getByText('Protects 1,240 installs')).toBeVisible();
	await expect(opts.locator('[data-verdict="slop"]')).toContainText('Slop');
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
	await expect(popup.getByText('A report you sent was closed.')).toBeVisible();
	await expect(popup.getByText('A report you sent has a verdict.')).toHaveCount(0);
	const opts = await ext.ctx.newPage();
	await opts.goto(`chrome-extension://${EXT_ID}/options.html#reports`);
	await expect(opts.getByText('Closed, no change')).toBeVisible();
	await expect.poll(() => ext.storage<{ reportsClosed: boolean }>('status').then((s) => s.reportsClosed)).toBe(false);
});
