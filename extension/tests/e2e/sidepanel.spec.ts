// The curator side panel against the review API (contract 6.7).
import { EXT_ID, expect, test } from './harness';

const SOURCE = {
	source: {
		platform: 'yt', id: '@catrescuetales', aliases: ['UCbbbbbbbbbbbbbbbbbbbbbb', '@catrescuetales'], name: 'Cat Rescue Tales', verdict: 'likely_slop',
		signals: ['mostly_ai', 'rubric_hollow'], slop_type: 'deceptive', tests: ['mass_produced', 'hollow'], large: false, imported: true, appeal_open: false,
		updated_at: '2026-08-01T00:00:00Z', rescore_at: '2026-10-30T00:00:00Z',
		evidence: { taggers: 41, tags: { slop: 35, ai_fine: 4, not_slop: 2 }, items_seen: 23, ai_item_share: 0.91, uploads_per_day: 14.2 }
	},
	layers: {
		provenance: { met: true, signals: ['platform_label'], detail: '6 installs saw the platform label on its items.' },
		behavior: { met: true, signals: ['mostly_ai', 'high_volume'], detail: '91% of 23 recent items carry AI evidence.' },
		rubric: { met: true, signals: ['rubric_hollow'], detail: 'Taggers found it hollow and mass-produced.' },
		consensus: { met: false, signals: [], detail: 'Consensus is still forming: 35 of 41 weighted tags say slop.' }
	},
	reports: [{ id: 'rpt_1', platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', status: 'under_review', verdict: null, protects: 0, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', reason: 'Fake rescue videos made with AI, posted every hour.', examples: ['dQw4w9WgXcQ'], slop_type: 'deceptive', tests: ['hollow'] }],
	appeals: [],
	items: [{ platform: 'yt', id: 'dQw4w9WgXcQ', verdict: null, signals: [], tags: { slop: 5, ai_fine: 0, not_slop: 0 }, platform_label_reports: 2 }],
	history: [{ id: 'log_1', at: '2026-08-01T00:00:00Z', platform: 'yt', target_type: 'source', target_id: '@catrescuetales', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', from: null, to: 'likely_slop', reason: 'Imported from the seed list.', signals: ['mostly_ai'], actor: 'community', actor_name: null }]
};

test('sign-in state for people without a reviewer token', async ({ ext }) => {
	const side = await ext.ctx.newPage();
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
	await expect(side.getByRole('heading', { name: 'Review for curators' })).toBeVisible();
	await expect(side.getByRole('button', { name: 'Open my account' })).toBeVisible();
});

test('queue, evidence and a decision', async ({ ext }) => {
	ext.api.review.queue = [{ id: 'q_1', kind: 'report', priority: 2, created_at: new Date(Date.now() - 3600_000).toISOString(), platform: 'yt', source_id: '@catrescuetales', source_name: 'Cat Rescue Tales', summary: '3 reports: fake rescue narration', large: false, verdict: 'likely_slop', computed_verdict: 'slop', report_count: 3 }];
	ext.api.review.source = SOURCE;
	await ext.ctl.evaluate(() => chrome.storage.local.set({ reviewerToken: 'rvw_test' }));
	const side = await ext.ctx.newPage();
	await side.setViewportSize({ width: 400, height: 900 });
	await side.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
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
	await side.screenshot({ path: 'screenshots/sidepanel-evidence-light.png', fullPage: true, animations: 'disabled' });
});
