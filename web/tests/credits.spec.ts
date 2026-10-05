// /credits names exactly the datasets whose license asks for credit (docs/contracts.md 14.3), and
// no other page or file of the built site names a dataset at all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { credits, type Registry } from '@colander/shared/seeds';
import { test, expect } from './fixtures.ts';
import { mockApi } from './mocks.ts';

const BUILD = new URL('../build/', import.meta.url).pathname;
const REGISTRY = (JSON.parse(readFileSync(new URL('../../packages/shared/src/seed-registry.json', import.meta.url), 'utf8')) as Registry).entries;

test('/credits lists each dataset whose license asks for credit, with its exact credit', async ({ page }) => {
	await mockApi(page);
	await page.goto('/credits');
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Credit where it is due.');
	const list = credits(REGISTRY);
	if (list.length === 0) {
		await expect(page.getByText('No dataset needs credit yet.')).toBeVisible();
		await expect(page.locator('.credit')).toHaveCount(0);
	} else {
		await expect(page.locator('.credit')).toHaveCount(list.length);
		for (const c of list) {
			const card = page.locator('.credit').filter({ hasText: c.name });
			await expect(card.getByRole('link', { name: c.name })).toHaveAttribute('href', c.homepage);
			await expect(card.locator('blockquote')).toHaveText(c.attribution);
		}
	}
	await expect(page.getByRole('link', { name: 'What Colander keeps about creators' })).toHaveAttribute('href', '/privacy#creators');
	// Reachable from every page's footer and from the privacy page.
	await expect(page.locator('footer').getByRole('link', { name: 'Credits' })).toHaveAttribute('href', '/credits');
	await page.goto('/privacy');
	await expect(page.locator('#creators').getByRole('link', { name: 'credits page' })).toHaveAttribute('href', '/credits');
});

test('nothing in the built site names a dataset, except /credits', () => {
	// Third-party datasets, by name, registry ID and homepage. Credits may name the ones it lists.
	const needles = REGISTRY.filter((e) => !e.dev_only && e.license !== 'LicenseRef-Colander-internal').flatMap((e) => [e.name, e.id, e.homepage]);
	expect(needles.length).toBeGreaterThan(5);
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
