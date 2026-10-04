import { test, expect } from './fixtures.ts';
import { LOG, SOURCES, mockApi } from './mocks.ts';

const cases = [
	{ path: '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ', name: 'Ancient Facts Daily', chip: 'Slop', plain: 'Low-effort AI content', summary: 'Hidden for people on Standard', appeal: true },
	{ path: '/s/tt/@historybites247', name: 'History Bites 24/7', chip: 'Likely slop', plain: 'Probably low-effort AI content', summary: 'Hidden for people on Standard', appeal: true },
	{ path: '/s/ig/studiolumen', name: 'Studio Lumen', chip: 'AI-made', plain: 'Made with AI', summary: 'Labeled AI-made', appeal: true },
	{ path: '/s/yt/@numisnotes', name: 'Numis Notes', chip: 'Disputed', plain: 'People disagree about this', summary: 'Shown to everyone, with a disputed mark', appeal: false },
	{ path: '/s/fb/104729388112', name: 'Coastal Science Club', chip: 'Clear', plain: 'Checked and fine', summary: 'Allowed for everyone', appeal: false }
];

for (const c of cases) {
	test(`source page for ${c.chip}`, async ({ page }) => {
		const calls = await mockApi(page);
		await page.goto(c.path);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.name);
		const banner = page.getByRole('region', { name: 'Verdict', exact: true });
		await expect(banner.locator('.cl-chip')).toHaveText(c.chip);
		await expect(banner).toContainText(c.plain);
		await expect(banner).toContainText(c.summary);
		// Appeal is offered only where an appeal can start: a verdict other than Clear, with no appeal open.
		if (c.appeal) {
			// One Appeal call to action on the page, in the banner.
			await expect(banner.getByRole('link', { name: 'Appeal this verdict' })).toHaveAttribute('href', c.path.replace('/s/', '/appeal/'));
			await expect(page.locator('a[href^="/appeal/"]')).toHaveCount(1);
		} else {
			await expect(page.locator('a[href^="/appeal/"]')).toHaveCount(0);
		}
		// Never ask for money on a source page.
		await expect(page.locator('a[href="/support"], a[href="/supporters"]')).toHaveCount(0);
		expect(calls.some((x) => x.path.startsWith('/v1/sources/'))).toBe(true);
	});
}

test('an open appeal is explained instead of offering another', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/yt/@numisnotes');
	const banner = page.getByRole('region', { name: 'Verdict', exact: true });
	await expect(banner).toContainText('Unhidden while staff review');
	await expect(banner).toContainText('The channel is shown to everyone while staff review the appeal');
	await expect(banner.getByRole('list', { name: 'Appeal' }).getByRole('listitem')).toHaveCount(4);
	await expect(page.locator('a[href^="/appeal/"]')).toHaveCount(0);
});

test('history hides entries where nothing changed', async ({ page }) => {
	await mockApi(page, {
		'GET /v1/sources/*': () => ({
			json: {
				source: { ...SOURCES['fb:104729388112'] },
				history: [
					{ ...LOG[3] },
					{ ...LOG[3], id: 'log_same', from: 'clear', to: 'clear', reason: 'Re-scored with no change.' }
				]
			}
		})
	});
	await page.goto('/s/fb/104729388112');
	await expect(page.getByText('Appeal upheld. Original footage')).toBeVisible();
	await expect(page.getByText('Re-scored with no change.')).toHaveCount(0);
});

test('source page for a source with no verdict', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/tt/@nobodyknows');
	await expect(page.getByText('Not rated', { exact: true })).toBeVisible();
	await expect(page.getByText('Colander has no verdict for this profile.')).toBeVisible();
	await expect(page.getByRole('link', { name: /View on TikTok/ })).toHaveAttribute('href', 'https://www.tiktok.com/@nobodyknows');
});

test('a source page never names a data source, even when an older server still sends one', async ({ page }) => {
	// Old wire data on purpose: imported and attribution are deprecated and always false and null now.
	await mockApi(page, {
		'GET /v1/sources/*': () => ({
			json: { source: { ...SOURCES['yt:@everydaytrivia'], imported: true, attribution: 'AiSList (CC BY-NC 4.0), blocklist' }, history: [] }
		})
	});
	await page.goto('/s/yt/@everydaytrivia');
	await expect(page.getByText('Not rated', { exact: true })).toBeVisible();
	await expect(page.locator('main')).not.toContainText(/AiSList|seed list|imported/i);
});

test('audience size says when it is not known, and no upload figures appear', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/tt/@historybites247');
	const numbers = page.getByRole('region', { name: 'The numbers behind it' });
	await expect(numbers).toContainText('Audience size');
	await expect(numbers).toContainText('Not known.');
	await expect(page.locator('main')).not.toContainText(/Large audience|uploads? a day|upload data|Posting volume/i);

	await mockApi(page, { 'GET /v1/sources/*': () => ({ json: { source: { ...SOURCES['tt:@historybites247'], large: true }, history: [] } }) });
	await page.reload();
	await expect(numbers).toContainText('Large. A Slop verdict on it needs staff review.');
});

test('an unknown platform is a 404', async ({ page }) => {
	await mockApi(page);
	const res = await page.goto('/s/xx/whatever');
	expect(res?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page went through the holes');
});

test('an unknown page answers with a real 404, and source pages with 200', async ({ page }) => {
	await mockApi(page);
	expect((await page.goto('/no-such-page'))?.status()).toBe(404);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page went through the holes');
	expect((await page.goto('/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ'))?.status()).toBe(200);
});
