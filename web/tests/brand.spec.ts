// The spec's brand rules on every page: the vocabulary table's "Not" words never appear, copy has no exclamation
// marks, nothing is set below 12 px, and controls are at least 32 px tall (inline text links aside). A segmented
// control is measured by its track, and inert pictures of the product (the landing's bento visuals) are not controls.
import { test, expect, layoutSpills } from './fixtures.ts';
import { PAGES, mockApi } from './mocks.ts';

// The "Not" column of the vocabulary table in docs/product-requirements.md.
const NOT_WORDS = /\b(detected|caught|flagged|fake|bots?|garbage|offenders?|spammers?|blacklist|removed|banned|deleted|false positives?|complaints?|donate|premium)\b/gi;

for (const [path, mocks] of PAGES) {
	test(`${path} follows the brand rules`, async ({ page }) => {
		await mockApi(page, mocks);
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		if (path === '/console') {
			await page.getByRole('button', { name: /History Bites/ }).click();
			await page.getByRole('heading', { level: 2, name: 'History Bites 24/7' }).waitFor();
		}

		const copy = await page.evaluate(() =>
			[document.title, document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '', document.body.innerText].join('\n')
		);
		expect(copy.match(NOT_WORDS) ?? [], 'vocabulary').toEqual([]);
		expect(copy.match(/\S*!\S*/g) ?? [], 'exclamation marks').toEqual([]);

		const { small, short } = await page.evaluate(() => {
			const visible = (el: Element) => {
				const r = el.getBoundingClientRect();
				return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.sr-only');
			};
			const name = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
			const small: string[] = [];
			for (const el of document.body.querySelectorAll('*')) {
				const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
				if (hasText && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 12) small.push(name(el));
			}
			const controls = 'button, select, input:not([type="checkbox"]):not([type="radio"]), a.uin-btn, label:has(> input[type="checkbox"], > input[type="radio"])';
			const box = (el: Element) => el.closest('.uin-seg') ?? el;
			const short = [...document.querySelectorAll(controls)]
				.filter((el) => visible(el) && !el.matches('.linkish') && !el.closest('[inert]'))
				.filter((el) => box(el).getBoundingClientRect().height < 31.5)
				.map((el) => `${name(el)} ${box(el).getBoundingClientRect().height}px`);
			return { small, short };
		});
		expect(small, 'text below 12 px').toEqual([]);
		expect(short, 'controls under 32 px').toEqual([]);
		expect(await layoutSpills(page), 'layout spills').toEqual([]);
	});
}
