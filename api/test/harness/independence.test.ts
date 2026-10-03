// The independence rule (Go's billing/independence_test.go): paying or donating never changes tag
// weight, review order or a verdict, because scoring and the tag, report and review handlers
// cannot reach billing state. It walks the runtime imports of scoring and of every route module
// except the account, billing and settings sync routes (which show, sell and check plans), and
// fails on any module that imports billing or mentions its tables or the Store's billing service.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url).pathname;
/** The modules that hold billing: the Stripe side and its SQL. */
const BILLING = ['billing.ts', 'store/billing.ts'];
/** Billing tables in SQL, and the Store's billing service. */
const BILLING_STATE = /\b(subscriptions|donations|billing_events)\b|\.billing\b/;
/** Route modules that may read plans: the account page shows one, billing sells it, sync checks it. */
const PLAN_ROUTES = ['routes/account.ts', 'routes/billing.ts', 'routes/sync.ts'];

/** The src-relative paths a module imports at runtime. `import type` and `export type` are erased. */
function runtimeImports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest);
	const out: string[] = [];
	for (const st of source.statements) {
		const runtime = (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) || (ts.isExportDeclaration(st) && !st.isTypeOnly);
		if (!runtime || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
		const spec = st.moduleSpecifier.text;
		if (!spec.startsWith('.')) continue; // packages cannot reach this Worker's modules
		const target = relative(SRC, join(SRC, dirname(file), spec));
		if (existsSync(join(SRC, target + '.ts'))) out.push(target + '.ts');
	}
	return out;
}

/** Every module reachable from the start modules that reaches billing state, with the import chain. */
function violations(start: string[], seen = new Set<string>()): string[] {
	const out: string[] = [];
	const walk = (file: string, chain: string[]) => {
		if (seen.has(file)) return;
		seen.add(file);
		chain = [...chain, file];
		if (BILLING.includes(file)) {
			out.push(`${chain.join(' -> ')} imports billing`);
			return;
		}
		const text = readFileSync(join(SRC, file), 'utf8');
		const m = BILLING_STATE.exec(text);
		if (m) out.push(`${file}:${text.slice(0, m.index).split('\n').length} reaches billing state (${m[0]}) via ${chain.join(' -> ')}`);
		for (const imp of runtimeImports(file)) walk(imp, chain);
	};
	for (const f of start) walk(f, []);
	return out;
}

const modules = (dir: string) =>
	existsSync(join(SRC, dir))
		? readdirSync(join(SRC, dir))
				.filter((f) => f.endsWith('.ts'))
				.map((f) => `${dir}/${f}`)
		: [];

describe('independence of verdicts from billing', () => {
	it('keeps scoring and everything it imports away from billing state', () => {
		const seen = new Set<string>();
		const scoring = modules('scoring');
		expect(scoring).toContain('scoring/engine.ts');
		expect(violations(scoring, seen)).toEqual([]);
		// The walk must reach the store, or it is not looking where it should.
		expect([...seen].filter((f) => f.startsWith('store/')).length).toBeGreaterThan(3);
	});

	it('keeps the tag, report and review handlers away from billing state', () => {
		const handlers = modules('routes').filter((f) => !PLAN_ROUTES.includes(f));
		// The route table (routes/server.ts, Go's server.go) registers sync too; the walk stops at the
		// plan routes, which may read plans, and checks everything else it reaches.
		expect(violations(handlers, new Set(PLAN_ROUTES))).toEqual([]);
	});

	it('catches a module that reaches billing', () => {
		expect(violations(['routes/account.ts'])).toEqual(['routes/account.ts -> billing.ts imports billing', expect.stringContaining('routes/account.ts -> store/billing.ts')]);
		expect(violations(['store/store.ts']).length).toBeGreaterThan(0);
	});
});
