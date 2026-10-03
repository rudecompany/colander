// Fails when a Wrangler config would delete, rename or transfer the Store Durable Object class in
// any environment. Each of those migrations wipes or moves the namespace that holds the database
// (hosting plan section 3), so none of them may ever reach a deploy.
//
//   node scripts/wrangler-guard.ts api/wrangler.jsonc
//
// The config is read with the api package's own Wrangler, so JSONC and TOML parse exactly as a
// deploy would parse them.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file || process.argv.length > 3) {
	console.error('Usage: node scripts/wrangler-guard.ts <wrangler config>');
	process.exit(2);
}

const wranglerEntry = createRequire(new URL('../api/package.json', import.meta.url)).resolve('wrangler');
const { experimental_readRawConfig } = await import(pathToFileURL(wranglerEntry).href);
const { rawConfig } = experimental_readRawConfig({ config: file });

interface Migration {
	tag?: string;
	deleted_classes?: string[];
	renamed_classes?: { from: string; to: string }[];
	transferred_classes?: { from: string; from_script: string; to: string }[];
}

const problems: string[] = [];
const scopes: [string, { migrations?: Migration[] }][] = [['top level', rawConfig], ...Object.entries<any>(rawConfig.env ?? {}).map(([name, cfg]): [string, any] => [`env.${name}`, cfg])];
for (const [scope, cfg] of scopes) {
	for (const m of cfg.migrations ?? []) {
		const where = `${scope}, migration ${m.tag ?? '(no tag)'}`;
		if (m.deleted_classes?.includes('Store')) problems.push(`${where} deletes Store`);
		for (const r of m.renamed_classes ?? []) if (r.from === 'Store' || r.to === 'Store') problems.push(`${where} renames ${r.from} to ${r.to}`);
		for (const t of m.transferred_classes ?? []) if (t.from === 'Store' || t.to === 'Store') problems.push(`${where} transfers ${t.from} to ${t.to}`);
	}
}

if (problems.length) {
	console.error(`${file} would wipe or move the Store Durable Object namespace:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}
console.log(`${file}: no migration deletes, renames or transfers Store (${scopes.length} scope(s) checked).`);
