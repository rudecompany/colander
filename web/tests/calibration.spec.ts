// The calibration set is labeled blind: the page shows only the platform and ID of the next source,
// with a link to it, and posts the label (seed design section 8).
import { test, expect } from './fixtures.ts';
import { CALIBRATION_ITEM, CURATOR, ME, STAFF, mockApi, queueReply } from './mocks.ts';

test('a curator labels the next source blind, and the page moves on', async ({ page }) => {
	const next = { platform: 'tt', source_id: '@quietloops', labels: 0 };
	const calls = await mockApi(page, {
		'GET /v1/account': { json: { account: CURATOR } },
		'GET /v1/review/calibration/next': { json: { item: CALIBRATION_ITEM } },
		'POST /v1/review/calibration/*/label': { json: { item: next } }
	});
	await page.goto('/console/calibration');
	await expect(page.getByRole('heading', { level: 1, name: 'Calibration' })).toBeVisible();
	await expect(page.locator('main').getByRole('heading', { level: 2 })).toContainText('UCq8Lw3xN2bKp7Tz5vR1mYsA');
	await expect(page.getByRole('link', { name: 'Open on YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/channel/UCq8Lw3xN2bKp7Tz5vR1mYsA');
	// Nothing that could sway the label: no verdict, tags or lists.
	await expect(page.locator('main')).not.toContainText(/Likely slop|tagged|seed list/i);

	await page.getByRole('button', { name: 'Save and show the next' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose what you saw first.');
	await page.getByText('Slop', { exact: true }).click();
	await page.getByText('Hollow', { exact: true }).click();
	await page.getByText('The platform labels it AI-generated').click();
	await page.getByLabel('Note, if it helps').fill('Same voice over stock footage in every video');
	// The report groups every judged source by language and by music or other video.
	await page.getByRole('button', { name: 'Save and show the next' }).click();
	await expect(page.getByRole('alert')).toHaveText('Choose its language and whether it is mostly music.');
	await page.getByLabel('Language').selectOption({ label: 'Turkish' });
	await page.getByText('Mostly music', { exact: true }).click();
	await page.getByRole('button', { name: 'Save and show the next' }).click();
	await expect(page.locator('main').getByRole('heading', { level: 2 })).toContainText('@quietloops');
	await expect(page.getByText('1 saved this visit')).toBeVisible();
	const post = calls.find((c) => c.method === 'POST')!;
	expect(post.path).toBe('/v1/review/calibration/yt/UCq8Lw3xN2bKp7Tz5vR1mYsA/label');
	expect(post.body).toEqual({
		label: 'slop',
		tests: ['hollow'],
		evidence: ['platform_label'],
		note: 'Same voice over stock footage in every video',
		language: 'tr',
		kind: 'music'
	});
	// A source that is gone asks for no language or kind.
	await page.getByText('Gone: the page is not there any more').click();
	await expect(page.getByLabel('Language')).toHaveCount(0);
	await page.getByRole('button', { name: 'Save and show the next' }).click();
	expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ label: 'gone', tests: [], evidence: [], note: '' });
});

// The ID is what the labeler reads: a 24-character channel ID stays on one line on a phone.
test('the channel ID fits on one line at 390 px', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page, {
		'GET /v1/account': { json: { account: CURATOR } },
		'GET /v1/review/calibration/next': { json: { item: CALIBRATION_ITEM } }
	});
	await page.goto('/console/calibration');
	const id = page.locator('main').getByRole('heading', { level: 2 }).locator('span', { hasText: CALIBRATION_ITEM.source_id });
	await expect(id).toHaveText(CALIBRATION_ITEM.source_id);
	expect(CALIBRATION_ITEM.source_id).toHaveLength(24);
	const { height, lineHeight } = await id.evaluate((el) => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) }));
	expect(height).toBeLessThan(lineHeight * 1.5);
});

test('an empty set says so, and the console links to it', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/account': { json: { account: STAFF } },
		'GET /v1/review/calibration/next': { json: { item: null } },
		'GET /v1/review/queue': { json: { items: [], next_cursor: null } }
	});
	await page.goto('/console');
	await page.getByRole('link', { name: 'Calibration set' }).click();
	await expect(page.getByText('Nothing to label right now.')).toBeVisible();
});

// Staff settle labels that disagree with a third, which needs staff authority: the admin host.
test('staff label on the admin host, from its Calibration tab', async ({ page, baseURL }) => {
	await mockApi(page, {
		'GET /v1/admin/me': { json: ME },
		'GET /v1/review/queue': queueReply,
		'GET /v1/review/calibration/next': { json: { item: CALIBRATION_ITEM } }
	});
	await page.goto('/admin');
	const nav = page.getByRole('navigation', { name: 'Admin console' });
	await nav.getByRole('link', { name: 'Calibration' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Calibration' })).toBeVisible();
	await expect(page.getByText('Admin, Rae')).toBeVisible();
	await expect(nav.getByRole('link', { name: 'Calibration' })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('main').getByRole('heading', { level: 2 })).toContainText(CALIBRATION_ITEM.source_id);
	// The admin host serves only the console: the definition lives on the main host.
	await expect(page.getByRole('link', { name: 'definition' })).toHaveAttribute('href', `${baseURL}/definition`);
});

// Four admin tabs wrap at 320 px (WCAG 2.2 reflow) instead of scrolling the page sideways.
test('the admin tabs fit a 320 px screen', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await mockApi(page, { 'GET /v1/admin/me': { json: ME }, 'GET /v1/review/calibration/next': { json: { item: CALIBRATION_ITEM } } });
	await page.goto('/admin/calibration');
	await expect(page.getByRole('navigation', { name: 'Admin console' }).getByRole('link')).toHaveText(['Review', 'Calibration', 'People', 'Audit log']);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
