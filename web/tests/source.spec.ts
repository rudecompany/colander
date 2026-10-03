import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

const cases = [
	{ path: '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ', name: 'Ancient Facts Daily', chip: 'Slop', plain: 'Low-effort AI content', summary: 'Hidden for people on Standard', appeal: true },
	{ path: '/s/tt/@historybites247', name: 'History Bites 24/7', chip: 'Likely slop', plain: 'Probably low-effort AI content', summary: 'Collapsed to one line', appeal: true },
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
			await expect(banner.getByRole('link', { name: 'Appeal' })).toHaveAttribute('href', c.path.replace('/s/', '/appeal/'));
			await expect(page.getByRole('heading', { name: /Appeal this verdict/ })).toBeVisible();
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
	const notice = page.getByRole('status').filter({ hasText: 'An appeal is open' });
	await expect(notice).toContainText('The channel is shown to everyone while staff review it');
});

test('a Clear source says there is nothing to appeal', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/fb/104729388112');
	await expect(page.getByRole('heading', { name: 'Nothing to appeal' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Not the creator?' })).toHaveCount(0);
});

test('source page for a source with no verdict', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/tt/@nobodyknows');
	await expect(page.getByText('Not rated', { exact: true })).toBeVisible();
	await expect(page.getByText('Colander has no verdict for this profile.')).toBeVisible();
	await expect(page.getByRole('link', { name: /View on TikTok/ })).toHaveAttribute('href', 'https://www.tiktok.com/@nobodyknows');
});

test('an imported source with no verdict still names its seed list', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/yt/@everydaytrivia');
	await expect(page.getByText('Not rated', { exact: true })).toBeVisible();
	await expect(page.getByText('Imported from AiSList (CC BY-NC 4.0), blocklist.')).toBeVisible();
});

test('an unknown platform is a 404', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/xx/whatever');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page went through the holes');
});
