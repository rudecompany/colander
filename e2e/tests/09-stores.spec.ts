// The install line, with every store listed: each browser gets its own store, and the line under
// the button names the others in order. Pages prerender the Chrome Web Store and switch once they
// run, which reorders that list.
import { expect, test } from '@playwright/test';
import { BASE_URL, ORIGIN, STORES } from './stack.ts';

test.skip(!!BASE_URL, 'the local build lists every store; a deployed origin lists the ones it has');

const UA = {
	chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
	edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
	firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0'
};

const CASES = [
	{ ua: UA.edge, label: 'Add to Edge, free', href: STORES.PUBLIC_STORE_EDGE, also: 'Also in the Chrome Web Store and Firefox Add-ons.' },
	{ ua: UA.firefox, label: 'Add to Firefox, free', href: STORES.PUBLIC_STORE_FIREFOX, also: 'Also in the Chrome Web Store and Edge Add-ons.' },
	{ ua: UA.chrome, label: 'Add to Chrome, free', href: STORES.PUBLIC_STORE_CHROME, also: 'Also in Firefox Add-ons and Edge Add-ons.' }
];

for (const c of CASES) {
	test(`${c.label.split(',')[0]} links its own store and names the other two`, async ({ browser }) => {
		const page = await browser.newPage({ userAgent: c.ua, viewport: { width: 1440, height: 900 } });
		await page.goto(`${ORIGIN}/`);
		const hero = page.locator('.hero');
		await expect(hero.getByRole('link', { name: c.label })).toHaveAttribute('href', c.href);
		await expect(hero.locator('.version')).toHaveText(new RegExp(`For Chrome, Firefox, Edge, Brave and Opera on desktop\\. ${c.also.replace(/\./g, '\\.')}$`));
		await expect(page.locator('.cta').locator('p.small')).toHaveText(`For Chrome, Firefox, Edge, Brave and Opera on desktop. No account needed. ${c.also}`);
		await page.close();
	});
}
