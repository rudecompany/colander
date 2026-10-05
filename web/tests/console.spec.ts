import { test, expect } from './fixtures.ts';
import { APPEAL, CURATOR, SEED_ENTRY, STAFF, mockApi, queueReply, reviewSource } from './mocks.ts';

const review = (account: typeof STAFF, extra: Parameters<typeof mockApi>[1] = {}) => ({
	'GET /v1/account': { json: { account } },
	'GET /v1/review/queue': queueReply,
	'GET /v1/review/sources/*': (c: { path: string }) => {
		const [, , , , p, id] = c.path.split('/');
		return { json: reviewSource(`${p}:${decodeURIComponent(id)}`) };
	},
	...extra
});

test('staff move through the queue by keyboard, read the evidence and write a decision', async ({ page }) => {
	const calls = await mockApi(page, review(STAFF, { 'POST /v1/review/sources/*/decision': { json: {} } }));
	await page.goto('/console');
	await expect(page.getByRole('button', { name: /Ancient Facts Daily/ })).toBeVisible();

	await page.locator('body').click({ position: { x: 5, y: 300 } });
	await page.keyboard.press('j');
	await page.keyboard.press('j');
	await expect(page.getByRole('button', { name: /History Bites 24\/7/ })).toBeFocused();
	await page.keyboard.press('k');
	await expect(page.getByRole('button', { name: /Numis Notes/ })).toBeFocused();
	await page.keyboard.press('j');
	await page.keyboard.press('Enter');

	await expect(page.getByRole('heading', { level: 2, name: 'History Bites 24/7' })).toBeVisible();
	await expect(page.getByText('6 slop tags from 9 installs, a share of 0.67. Consensus needs 0.7.')).toBeVisible();
	await expect(page.getByText('Not met')).toBeVisible();
	// The status keeps its 14 px icon when the layer name wraps beside it.
	expect(await page.locator('.status').filter({ hasText: 'Not met' }).locator('svg').evaluate((s) => s.getBoundingClientRect().width)).toBe(14);
	await expect(page.getByRole('link', { name: /7421983300112233445/ }).first()).toHaveAttribute('href', 'https://www.tiktok.com/@historybites247/video/7421983300112233445');

	await page.locator('label.verdict-option').filter({ has: page.getByRole('radio', { name: 'Slop', exact: true }) }).click();
	await page.getByLabel('Reason').fill('Twelve near-identical AI history videos a day with one caption template.');
	await page.locator('label.uin-checkbox', { hasText: 'Posts at a volume no person could sustain' }).click();
	await page.getByLabel('Type').selectOption('filler');
	await page.getByRole('button', { name: 'Review decision' }).click();

	const dialog = page.getByRole('dialog', { name: 'Write this to the public log?' });
	await expect(dialog).toContainText('Decided by staff member Sam');
	await expect(dialog.locator('.cl-chip')).toHaveText(['Likely slop', 'Slop']);
	await dialog.getByRole('button', { name: 'Write to the log' }).click();
	await expect(page.getByText('Decision written to the public log.')).toBeVisible();

	const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/review/sources/tt/%40historybites247/decision')!;
	expect(post.headers['x-colander-csrf']).toBe('1');
	expect(post.body).toEqual({
		verdict: 'slop',
		reason: 'Twelve near-identical AI history videos a day with one caption template.',
		signals: ['platform_label', 'templated', 'near_duplicates', 'high_volume'],
		slop_type: 'filler',
		tests: ['mass_produced', 'hollow'],
		large: false
	});
});

test('curators see staff-only limits before submit, and the staff_required answer after', async ({ page }) => {
	await mockApi(
		page,
		review(CURATOR, {
			'POST /v1/review/sources/*/decision': {
				status: 403,
				json: { error: { code: 'staff_required', message: 'This source now has a large audience, so a staff member must decide it.' } }
			}
		})
	);
	await page.goto('/console');

	await page.getByRole('button', { name: /Ancient Facts Daily/ }).click();
	await expect(page.getByText('Staff decision needed')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Review decision' })).toBeDisabled();

	await page.getByRole('button', { name: /History Bites 24\/7/ }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'History Bites 24/7' })).toBeVisible();
	await expect(page.getByText('Only staff can mark a source as large.')).toBeVisible();
	await page.locator('label.verdict-option').filter({ has: page.getByRole('radio', { name: 'No verdict' }) }).click();
	await page.getByLabel('Reason').fill('Reports describe a different channel with a similar name.');
	await page.getByRole('button', { name: 'Review decision' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Write to the log' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Staff decision needed' })).toContainText('a staff member must decide it');
});

test('curators see that an appeal waiting for a manual code check needs staff', async ({ page }) => {
	const numis = reviewSource('yt:@numisnotes');
	await mockApi(
		page,
		review(CURATOR, {
			'GET /v1/review/sources/*': {
				json: { ...numis, source: { ...numis.source, appeal_open: false }, appeals: [{ ...APPEAL, status: 'pending_manual' }] }
			}
		})
	);
	await page.goto('/console');
	await page.getByRole('button', { name: /Numis Notes/ }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Staff decision needed' })).toContainText('An appeal is open on this source');
	await expect(page.getByRole('button', { name: 'Review decision' })).toBeDisabled();
});

test('Slop and Likely slop wait for AI evidence, and the server answer is shown', async ({ page }) => {
	const base = reviewSource('tt:@historybites247');
	const noAi = {
		...base,
		source: { ...base.source, signals: base.source.signals.filter((s) => s !== 'platform_label') },
		layers: { ...base.layers, provenance: { met: false, signals: [], detail: 'One install reported the platform AI label. Provenance needs 2.' } }
	};
	await mockApi(
		page,
		review(STAFF, {
			'GET /v1/review/sources/*': { json: noAi },
			'POST /v1/review/sources/*/decision': {
				status: 400,
				json: { error: { code: 'ai_evidence_required', message: 'Slop and Likely slop need AI evidence on this source.' } }
			}
		})
	);
	await page.goto('/console');
	await page.getByRole('button', { name: /History Bites/ }).click();

	const slop = page.getByRole('radio', { name: 'Slop', exact: true });
	await expect(page.getByText('Slop and Likely slop need AI evidence. The provenance layer is not met')).toBeVisible();
	await expect(slop).toBeDisabled();
	await expect(page.getByRole('radio', { name: 'Likely slop' })).toBeDisabled();
	await expect(page.getByRole('radio', { name: 'AI-made' })).toBeEnabled();

	// Recording a provenance signal is AI evidence, so the verdicts open up.
	await page.locator('label.uin-checkbox', { hasText: 'The platform labels it AI-generated' }).click();
	await expect(slop).toBeEnabled();
	await page.locator('label.verdict-option').filter({ has: slop }).click();
	await page.getByLabel('Reason').fill('Twelve near-identical AI history videos a day with one caption template.');
	await page.getByRole('button', { name: 'Review decision' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Write to the log' }).click();
	await expect(page.getByRole('alert').filter({ hasText: 'AI evidence needed' })).toContainText('need AI evidence on this source');
});

// A seed lead is never evidence. Staff see which lists name the source, with provenance, and can
// suppress seed lists on it; curators see only that lists name it (contracts 6.7).
test('staff see the provenance of a seed lead and can suppress it; curators see only a count', async ({ page }) => {
	const calls = await mockApi(page, review(STAFF, { 'POST /v1/review/sources/*/suppress-seeds': { json: reviewSource('yt:@everydaytrivia') } }));
	await page.goto('/console');
	// A lead nothing backs waits under Escalated, after the other escalations, so it never buries the reports under All.
	await expect(page.getByRole('button', { name: /Ancient Facts Daily/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /Everyday Trivia/ })).toHaveCount(0);
	await page.getByRole('tab', { name: /^Escalated/ }).click();
	const row = page.getByRole('button', { name: /Everyday Trivia/ });
	await expect(row).toContainText('Seed lead');
	await row.click();
	const seeds = page.getByRole('region', { name: 'Seed lists' });
	await expect(seeds).toContainText('A seed list is a review lead, never evidence.');
	await expect(seeds).toContainText('Example seed list');
	await expect(seeds).toContainText(/Listed as @everydaytrivia in the file dated 15 Sept? 2026\./);
	await seeds.getByRole('button', { name: 'Suppress seed lists' }).click();
	await page.getByLabel(/Why suppress seed lists here/).fill('Objection under Article 21, by email');
	await seeds.getByRole('button', { name: 'Suppress seed lists' }).click();
	await expect(page.getByText('Seed lists suppressed. No import lists it again.')).toBeVisible();
	const post = calls.find((c) => c.method === 'POST' && c.path === '/v1/review/sources/yt/%40everydaytrivia/suppress-seeds')!;
	expect(post.body).toEqual({ reason: 'Objection under Article 21, by email' });
});

test('curators see that seed lists name a lead, never which', async ({ page }) => {
	await mockApi(
		page,
		review(CURATOR, {
			'GET /v1/review/sources/*': (c: { path: string }) => {
				const [, , , , p, id] = c.path.split('/');
				return { json: reviewSource(`${p}:${decodeURIComponent(id)}`, false) };
			}
		})
	);
	await page.goto('/console');
	await page.getByRole('tab', { name: /^Escalated/ }).click();
	await page.getByRole('button', { name: /Everyday Trivia/ }).click();
	const seeds = page.getByRole('region', { name: 'Seed lists' });
	await expect(seeds).toContainText('Which lists name it is for staff only.');
	await expect(page.locator('main')).not.toContainText('Example seed list');
	await expect(seeds.getByRole('button', { name: 'Suppress seed lists' })).toHaveCount(0);
	await page.getByRole('tab', { name: /^All/ }).click();
	await page.getByRole('button', { name: /History Bites/ }).click();
	await expect(page.getByRole('heading', { name: /Seed lists/ }), 'no section where no list names the source').toHaveCount(0);
});

test("staff see where staff saw a source on Colander's own list", async ({ page }) => {
	const own = { ...SEED_ENTRY, seed: 'staff-research', name: 'Colander staff research', license: 'LicenseRef-Colander-internal', note: 'Named in a published report on AI music' };
	await mockApi(page, review(STAFF, { 'GET /v1/review/sources/*': { json: { ...reviewSource('yt:@everydaytrivia'), seeds: [own] } } }));
	await page.goto('/console');
	await page.getByRole('tab', { name: /^Escalated/ }).click();
	await page.getByRole('button', { name: /Everyday Trivia/ }).click();
	await expect(page.getByRole('region', { name: 'Seed lists' })).toContainText('Where staff saw it: Named in a published report on AI music');
});

test('members are told the console is for curators and staff', async ({ page }) => {
	await mockApi(page, { 'GET /v1/account': { json: { account: { ...STAFF, role: 'member' } } } });
	await page.goto('/console');
	await expect(page.getByRole('heading', { name: 'For curators and staff' })).toBeVisible();
});

// Between the tablet and wide layouts the queue keeps room for all 4 kind tabs, counts included.
for (const width of [800, 1024, 1199]) {
	test(`the queue tabs fit their column at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await mockApi(page, review(STAFF));
		await page.goto('/console');
		const tabs = page.getByRole('tablist', { name: 'Queue kind' });
		await expect(tabs.getByRole('tab', { name: /Escalated/ })).toBeVisible();
		const { scroll, client } = await tabs.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
		expect(scroll).toBeLessThanOrEqual(client);
	});
}
