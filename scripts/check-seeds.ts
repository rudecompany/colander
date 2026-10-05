// The seed registry check (docs/contracts.md section 14), run by `make test-api` and the api job
// in CI. It needs nothing but Node 24 and git.
//
//   node scripts/check-seeds.ts
//   SEED_BASE=<commit> SEED_ACTOR=<github login> node scripts/check-seeds.ts
//
// It fails when:
// - an entry of packages/shared/src/seed-registry.json breaks a rule of validateEntry;
// - the repository holds a copy of a registered list: list files live only in the private bucket;
// - .github/CODEOWNERS stops giving the registry, its rules and this check to the owners;
// - with SEED_BASE and SEED_ACTOR, someone outside SEED_OWNERS changed a cleared entry, any
//   clearance, or the owner list since SEED_BASE (the pull request's base, or the commit before a
//   push to main).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ownerOnlyChanges, SEED_OWNERS, validateRegistry, type Registry } from '../packages/shared/src/seeds.ts';

const REGISTRY = 'packages/shared/src/seed-registry.json';
const RULES = 'packages/shared/src/seeds.ts';
/** The files only an owner may change, each one CODEOWNERS must give to every owner. */
const OWNED = ['/packages/shared/src/seed-registry.json', '/packages/shared/src/seeds.ts', '/scripts/check-seeds.ts', '/.github/CODEOWNERS'];

const root = new URL('../', import.meta.url);
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const problems: string[] = [];

const registry = JSON.parse(readFileSync(new URL(REGISTRY, root), 'utf8')) as Registry;
problems.push(...validateRegistry(registry));

// A committed copy of a registered list, byte for byte, is a published list.
const hashes = new Map(registry.entries.filter((e) => e.sha256).map((e) => [e.sha256!, e.id]));
if (hashes.size > 0) {
	for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(new URL(file, root));
		} catch {
			continue; // deleted in the working tree
		}
		const id = hashes.get(createHash('sha256').update(bytes).digest('hex'));
		if (id) problems.push(`${file} is a copy of the list ${id}: list files live only in the private bucket, never in the repository`);
	}
}

const owners = readFileSync(new URL('.github/CODEOWNERS', root), 'utf8')
	.split('\n')
	.map((l) => l.trim().split(/\s+/))
	.filter((f) => f[0] && !f[0].startsWith('#'));
for (const path of OWNED) {
	const line = owners.findLast((f) => f[0] === path);
	const missing = SEED_OWNERS.filter((o) => !line?.slice(1).includes(`@${o}`));
	if (missing.length) problems.push(`.github/CODEOWNERS must give ${path} to ${missing.map((o) => '@' + o).join(' ')}`);
}

const base = process.env.SEED_BASE?.trim();
const actor = process.env.SEED_ACTOR?.trim();
if (base) {
	if (!actor) throw new Error('SEED_BASE needs SEED_ACTOR, the GitHub login that made the change');
	const at = (path: string): string | undefined => {
		try {
			return git('show', `${base}:${path}`);
		} catch {
			return undefined; // the file is new since base
		}
	};
	const before = at(REGISTRY);
	const changed = ownerOnlyChanges(before ? (JSON.parse(before) as Registry).entries : [], registry.entries);
	// The owners as base had them: nobody can add themselves and approve their own change.
	const ownerList = (text: string | undefined): string[] | undefined => {
		const list = /SEED_OWNERS\s*=\s*\[([^\]]*)\]/.exec(text ?? '')?.[1];
		return list === undefined ? undefined : [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
	};
	const baseOwners = ownerList(at(RULES)) ?? SEED_OWNERS;
	if (baseOwners.join() !== SEED_OWNERS.join()) changed.push('SEED_OWNERS');
	if (changed.length && !baseOwners.includes(actor)) {
		problems.push(`${actor} changed ${changed.join(', ')}, which only ${baseOwners.join(', ')} may change: a cleared entry, a clearance or the owner list`);
	}
}

if (problems.length) {
	for (const p of problems) console.error(`check-seeds: ${p}`);
	process.exit(1);
}
console.log(`check-seeds: ${registry.entries.length} registry entries valid, ${registry.entries.filter((e) => e.clearance.status === 'cleared').length} cleared`);
