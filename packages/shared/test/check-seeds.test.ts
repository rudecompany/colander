// scripts/check-seeds.ts: only an owner changes a cleared entry, a clearance or the seed rules and
// checks, and seed-guard judges a pull request with the base branch's own checker, so editing the
// checker or its rules in the same pull request cannot pass it (docs/contracts.md 14.2).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url).pathname;
const FILES = ['scripts/check-seeds.ts', 'packages/shared/src/seeds.ts', 'packages/shared/src/seed-registry.json', '.github/CODEOWNERS'];
const REGISTRY = 'packages/shared/src/seed-registry.json';

let repo = '';
const git = (...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const edit = (path: string, change: (text: string) => string) => writeFileSync(join(repo, path), change(readFileSync(join(repo, path), 'utf8')));
const commit = (message: string) => {
	git('add', '-A');
	git('commit', '-q', '-m', message);
	return git('rev-parse', 'HEAD');
};

/** Runs the checker of the working tree; head set means seed-guard's mode. */
function check(env: Record<string, string>): { code: number; out: string } {
	const r = spawnSync(process.execPath, [join(repo, 'scripts/check-seeds.ts')], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
	return { code: r.status ?? -1, out: (r.stdout + r.stderr).trim() };
}

/** Clears the AiSList blocklist entry as the owner would, in the working tree. */
const clearEntry = () =>
	edit(REGISTRY, (t) => {
		const r = JSON.parse(t);
		const e = r.entries.find((x: { id: string }) => x.id === 'aislist-cc0-20260115-blocklist');
		Object.assign(e, { sha256: 'a'.repeat(64), clearance: { status: 'cleared', by: 'slantview', at: '2026-10-05' } });
		return JSON.stringify(r, null, '\t');
	});

let base = '';
beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'check-seeds-'));
	for (const f of FILES) {
		mkdirSync(dirname(join(repo, f)), { recursive: true });
		cpSync(join(ROOT, f), join(repo, f));
	}
	git('init', '-q', '-b', 'main');
	base = commit('base');
	git('checkout', '-q', '-b', 'pr');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('check-seeds', () => {
	it('lets anyone add a pending entry, and only an owner clear one', () => {
		edit(REGISTRY, (t) => t.replace('"expires_after_days": 90', '"expires_after_days": 60'));
		expect(check({ SEED_BASE: base, SEED_ACTOR: 'mallory' })).toMatchObject({ code: 0 });
		clearEntry();
		const res = check({ SEED_BASE: base, SEED_ACTOR: 'mallory' });
		expect(res.code).toBe(1);
		expect(res.out).toContain('mallory changed aislist-cc0-20260115-blocklist, which only slantview may change');
		expect(check({ SEED_BASE: base, SEED_ACTOR: 'slantview' }).code).toBe(0);
		// The author and the last pusher must both be owners.
		expect(check({ SEED_BASE: base, SEED_ACTOR: 'slantview mallory' }).code).toBe(1);
	});

	it('counts any change to the rules or the checks as an owner-only change', () => {
		edit('packages/shared/src/seeds.ts', (t) => t.replace('if (cleared || clearance) out.push(id);', 'if (false) out.push(id);'));
		clearEntry();
		const res = check({ SEED_BASE: base, SEED_ACTOR: 'mallory' });
		expect(res.code).toBe(1);
		expect(res.out).toContain('packages/shared/src/seeds.ts');
	});

	// The pull request turns off the owner rule in its own copy of the checker and of the rules.
	// seed-guard runs the base branch's copy against the pull request's commit, so it still fails.
	it('judges a pull request with the base branch copy, which the pull request cannot change', () => {
		edit('packages/shared/src/seeds.ts', (t) => t.replace('if (cleared || clearance) out.push(id);', 'if (false) out.push(id);'));
		edit('scripts/check-seeds.ts', (t) => t.replace('if (changed.length && !byOwners) {', 'if (false) {'));
		clearEntry();
		const head = commit('pr');
		expect(check({ SEED_BASE: base, SEED_ACTOR: 'mallory' }), "the pull request's own copy passes itself").toMatchObject({ code: 0 });
		git('checkout', '-q', 'main');
		const res = check({ SEED_BASE: base, SEED_HEAD: head, SEED_ACTOR: 'mallory mallory' });
		expect(res.code).toBe(1);
		expect(res.out).toContain(
			'mallory changed aislist-cc0-20260115-blocklist, packages/shared/src/seeds.ts, scripts/check-seeds.ts, which only slantview may change'
		);
		expect(check({ SEED_BASE: base, SEED_HEAD: head, SEED_ACTOR: 'slantview slantview' }).code).toBe(0);
	});

	it('validates the pull request registry with the base rules', () => {
		edit(REGISTRY, (t) => t.replace('"expires_after_days": 90', '"expires_after_days": 9000'));
		const head = commit('pr');
		git('checkout', '-q', 'main');
		const res = check({ SEED_BASE: base, SEED_HEAD: head, SEED_ACTOR: 'mallory' });
		expect(res.code).toBe(1);
		expect(res.out).toContain('cevval-yt-ai-music: expires_after_days must be a whole number from 1 to 730');
	});
});
