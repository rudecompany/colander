// The extension names no dataset: its about text says where the list comes from and points to the
// website's /credits page, the one place that names the datasets whose license asks for credit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DIST, EXT_ID, expect, ROOT, test } from './harness';

test('the about text in the options links to the credits page', async ({ ext }) => {
	const page = await ext.ctx.newPage();
	await page.setViewportSize({ width: 1280, height: 860 });
	await page.goto(`chrome-extension://${EXT_ID}/options.html#privacy`);
	const about = page.getByRole('region', { name: 'Where the list comes from' });
	await expect(about).toContainText('Some openly licensed lists from other projects help staff choose which sources to review first. They never decide a verdict.');
	await expect(about.getByRole('link', { name: 'Credits' })).toHaveAttribute('href', /^https?:\/\/[^/]+\/credits$/);
	await expect(page.getByRole('complementary').getByRole('link', { name: 'Credits' })).toHaveAttribute('href', /\/credits$/);
});

test('nothing in the built extension names a dataset', () => {
	const registry = JSON.parse(readFileSync(resolve(ROOT, '../packages/shared/src/seed-registry.json'), 'utf8')) as {
		entries: { name: string; id: string; homepage: string; license: string; dev_only: boolean }[];
	};
	const needles = registry.entries.filter((e) => !e.dev_only && e.license !== 'LicenseRef-Colander-internal').flatMap((e) => [e.name, e.id, e.homepage]);
	expect(needles.length).toBeGreaterThan(5);
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(html|js|json|css)$/.test(f)) {
				const text = readFileSync(p, 'utf8').toLowerCase();
				for (const n of needles) if (text.includes(n.toLowerCase())) found.push(`${relative(DIST, p)}: ${n}`);
			}
		}
	};
	walk(DIST);
	expect(found).toEqual([]);
});
