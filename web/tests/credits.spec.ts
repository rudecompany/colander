// /credits names exactly the datasets whose license asks for credit (docs/contracts.md 14.3), and
// no other page or file of the built site names a dataset at all. The tests build the site with a
// fictional registry (tests/seed-registry.ts) that clears one such dataset, so its card renders.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { credits, datasetNames, INTERNAL, type Registry, type SeedEntry } from '@colander/shared/seeds';
import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';
import { REGISTRY as TEST_REGISTRY } from './seed-registry.ts';

const BUILD = new URL('../build/', import.meta.url).pathname;
const REGISTRY = (JSON.parse(readFileSync(new URL('../../packages/shared/src/seed-registry.json', import.meta.url), 'utf8')) as Registry).entries;
/** Every name of a third-party dataset, real or fictional, that a page may not contain. */
const names = (entries: readonly SeedEntry[]) => entries.filter((e) => !e.dev_only && e.license !== INTERNAL).flatMap(datasetNames);

for (const theme of ['light', 'dark'] as const) {
	test(`/credits shows each dataset whose license asks for credit, with its exact credit, in ${theme}`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: theme });
		await mockApi(page);
		await page.goto('/credits');
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Credit where it is due.');
		const list = credits(TEST_REGISTRY);
		expect(list.map((c) => c.name)).toEqual(['Example Open Channels']);
		await expect(page.locator('.credit')).toHaveCount(1);
		const card = page.locator('.credit');
		await expect(card.getByRole('heading', { level: 3 })).toHaveText('Example Open Channels');
		await expect(card.getByRole('link', { name: 'Example Open Channels' })).toHaveAttribute('href', 'https://example.org/open-channels');
		await expect(card.getByRole('link', { name: 'CC-BY-4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
		await expect(card.locator('blockquote')).toHaveText(list[0]!.attribution);
		await expect(page.getByText('No dataset needs credit yet.')).toHaveCount(0);
		// A cleared CC0 dataset and a pending one are not named, not even here.
		const text = (await page.locator('main').innerText()).toLowerCase();
		for (const n of names(TEST_REGISTRY.filter((e) => e.id !== 'example-open-channels'))) expect(text).not.toContain(n.toLowerCase());
		await expect(page.getByRole('link', { name: 'What Colander keeps about creators' })).toHaveAttribute('href', '/privacy#creators');
		// Reachable from every page's footer and from the privacy page.
		await expect(page.locator('footer').getByRole('link', { name: 'Credits' })).toHaveAttribute('href', '/credits');
		await page.goto('/privacy');
		await expect(page.locator('#creators').getByRole('link', { name: 'credits page' })).toHaveAttribute('href', '/credits');
	});
}

test('the privacy page gives creators the legal basis and the way to ask, without promising an appeal code', async ({ page }) => {
	await mockApi(page);
	await page.goto('/privacy');
	const creators = page.locator('#creators');
	await expect(creators).toContainText('The legal basis is legitimate interest under GDPR Article 6(1)(f)');
	await expect(creators).toContainText('Staff will give you a code to post on it, to show that you control it.');
	await expect(creators.locator('p', { hasText: 'you can ask which sources name it' })).not.toContainText('appeal');
	await expect(creators.getByRole('link', { name: 'Your rights and contact' })).toHaveAttribute('href', '#contact');
});

test('nothing in the built site names a dataset, except /credits', () => {
	// Every name of the real third-party datasets and the fictional ones the tests build with: the
	// registry module may reach no page but /credits, and no page may name a dataset in its copy.
	const needles = [...names(REGISTRY), ...names(TEST_REGISTRY)];
	expect(needles).toEqual(expect.arrayContaining(['AiSList', 'Cevval', 'souloverai', 'Tube Census', 'Override92', 'xoundbyte', 'OpenChannels']));
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(html|js|json|css|txt|xml|svg|webmanifest)$/.test(f)) files.push(p);
		}
	};
	walk(BUILD);
	expect(files.length).toBeGreaterThan(20);
	const found: string[] = [];
	for (const file of files) {
		const rel = relative(BUILD, file);
		if (/^credits(\.html|\/)/.test(rel)) continue;
		const text = readFileSync(file, 'utf8').toLowerCase();
		for (const n of needles) if (text.includes(n.toLowerCase())) found.push(`${rel}: ${n}`);
	}
	expect(found).toEqual([]);
});
