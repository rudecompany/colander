// WCAG 2.2 AA checks with axe on every page, in light and dark.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.ts';
import { APPEAL, PLUS_ACCOUNT, QUEUE, STAFF, mockApi, reviewSource } from './mocks.ts';

const pages: [string, Parameters<typeof mockApi>[1]?][] = [
	['/'],
	['/definition'],
	['/s/yt/UCq3x9Vb2m4LkT7pQe8sW1aZ'],
	['/s/yt/@unknownchannel'],
	['/appeal/tt/@historybites247'],
	['/appeal/status/apl_4k9x2m?secret=s3cret', { 'GET /v1/appeals/*': { json: { appeal: APPEAL } } }],
	['/log'],
	['/plans'],
	['/plans/welcome', { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } }],
	['/support'],
	['/support/thanks'],
	['/supporters'],
	['/transparency'],
	['/account', { 'GET /v1/account': { json: { account: PLUS_ACCOUNT } } }],
	[
		'/console',
		{
			'GET /v1/account': { json: { account: STAFF } },
			'GET /v1/review/queue': { json: { items: QUEUE, next_cursor: null } },
			'GET /v1/review/sources/*': { json: reviewSource('tt:@historybites247') }
		}
	],
	['/privacy'],
	['/terms'],
	['/missing-page']
];

for (const scheme of ['light', 'dark'] as const) {
	for (const [path, mocks] of pages) {
		test(`${path} has no WCAG A or AA violations (${scheme})`, async ({ page }) => {
			await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await mockApi(page, mocks);
			await page.goto(path);
			await page.waitForLoadState('networkidle');
			if (path === '/console') await page.getByRole('button', { name: /History Bites/ }).click();
			await page.waitForLoadState('networkidle');
			const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
			const found = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(' | ')}`);
			expect(found).toEqual([]);
		});
	}
}
