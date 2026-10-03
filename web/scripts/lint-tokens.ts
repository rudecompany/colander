// One source for every value: colors are tokens in @colander/shared, and dates go through its
// format.ts. Fails on a hex color, Intl.DateTimeFormat or toLocale*String anywhere in src/.
// app.html is exempt for its theme-color meta tags, which cannot read CSS variables.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', 'src');
const rules: [RegExp, string][] = [
	[/(?<![\w&/-])#[0-9a-fA-F]{3,8}\b(?![\w-])/g, 'hex color: use a --cl- token from @colander/shared'],
	[/Intl\.DateTimeFormat|toLocale(Date|Time)?String/g, 'date format: use the formats in @colander/shared/format']
];
const problems: string[] = [];

function walk(dir: string) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (/\.(svelte|ts|css)$/.test(name)) check(path);
	}
}

function check(path: string) {
	readFileSync(path, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			// Skip anchors and ids such as href="#appeals" and aria targets.
			const text = line.replace(/(href|id|for)="[^"]*"/g, '');
			for (const [re, why] of rules) {
				for (const m of text.matchAll(re)) problems.push(`${relative(root, path)}:${i + 1}: ${m[0]} (${why})`);
			}
		});
}

walk(root);
if (problems.length) {
	console.error(problems.join('\n'));
	process.exit(1);
}
