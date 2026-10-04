// The content scripts run on every feed page, so they carry only the in-page builders: the demo
// feed and its bundled thumbnail images belong to extension pages (welcome, options, store art).
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIST } from './harness';

test('content scripts carry no demo images', () => {
	const dir = resolve(DIST, 'content-scripts');
	const scripts = readdirSync(dir).filter((f) => f.endsWith('.js'));
	expect(scripts).toContain('content.js');
	for (const f of scripts) {
		const js = readFileSync(resolve(dir, f), 'utf8');
		expect(js, f).not.toMatch(/data:image\//);
		expect(js, f).not.toMatch(/\.webp\b/);
		expect(js, f).not.toContain('Ancient Rome facts');
	}
});
