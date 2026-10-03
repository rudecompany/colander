// The spec's voice on every page: the vocabulary table's "Not" words never appear, and copy has no exclamation marks.
import { test, expect } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

// The "Not" column of the vocabulary table in docs/product-requirements.md.
const NOT_WORDS = /\b(detected|caught|flagged|fake|bots?|garbage|offenders?|spammers?|blacklist|removed|banned|deleted|false positives?|complaints?|donate|premium)\b/gi;

for (const [path, mocks] of PAGES) {
	test(`${path} follows the vocabulary`, async ({ page }) => {
		await mockApi(page, mocks);
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		if (path === '/console') await page.getByRole('button', { name: /History Bites/ }).click();
		await page.waitForLoadState('networkidle');
		const copy = await page.evaluate(() =>
			[document.title, document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '', document.body.innerText].join('\n')
		);
		expect(copy.match(NOT_WORDS) ?? []).toEqual([]);
		expect(copy.match(/\S*!\S*/g) ?? []).toEqual([]);
	});
}
