import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

const cases = [
	{ path: '/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ', name: 'Ancient Facts Daily', chip: 'Slop', summary: 'Hidden for people on Standard' },
	{ path: '/s/tt/@historybites247', name: 'History Bites 24/7', chip: 'Likely slop', summary: 'Collapsed to one line' },
	{ path: '/s/ig/studiolumen', name: 'Studio Lumen', chip: 'AI-made', summary: 'Labeled AI-made' },
	{ path: '/s/yt/@numisnotes', name: 'Numis Notes', chip: 'Disputed', summary: 'Shown to everyone, with a disputed mark' },
	{ path: '/s/fb/104729388112', name: 'Coastal Science Club', chip: 'Clear', summary: 'Allowed for everyone' }
];

for (const c of cases) {
	test(`source page for ${c.chip}`, async ({ page }) => {
		const calls = await mockApi(page);
		await page.goto(c.path);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(c.name);
		const banner = page.getByRole('region', { name: 'Verdict', exact: true });
		await expect(banner.locator('.cl-chip')).toHaveText(c.chip);
		await expect(banner).toContainText(c.summary);
		await expect(banner.getByRole('link', { name: 'Appeal' })).toHaveAttribute('href', c.path.replace('/s/', '/appeal/'));
		await expect(page.getByRole('heading', { name: /Appeal this verdict/ })).toBeVisible();
		// Never ask for money on a source page.
		await expect(page.locator('a[href="/support"], a[href="/supporters"]')).toHaveCount(0);
		expect(calls.some((x) => x.path.startsWith('/v1/sources/'))).toBe(true);
	});
}

test('source page for a source with no verdict', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/tt/@nobodyknows');
	await expect(page.getByText('Not rated', { exact: true })).toBeVisible();
	await expect(page.getByText('Colander has no verdict for this profile.')).toBeVisible();
	await expect(page.getByRole('link', { name: /View on TikTok/ })).toHaveAttribute('href', 'https://www.tiktok.com/@nobodyknows');
});

test('an unknown platform is a 404', async ({ page }) => {
	await mockApi(page);
	await page.goto('/s/xx/whatever');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('This page went through the holes');
});
