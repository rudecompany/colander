// The seed registry check (docs/contracts.md section 14), run by `make test-api`, the api job in
// CI and, from the base branch's own copy, the seed-guard workflow. It needs nothing but Node 24
// and git.
//
//   node scripts/check-seeds.ts
//   SEED_BASE=<commit> SEED_ACTOR=<github logins> node scripts/check-seeds.ts
//   SEED_BASE=<commit> SEED_HEAD=<commit> SEED_ACTOR=<github logins> node scripts/check-seeds.ts
//
// It fails when:
// - an entry of packages/shared/src/seed-registry.json breaks a rule of validateEntry;
// - the repository holds a copy of a registered list: list files live only in the private bucket;
// - .github/CODEOWNERS stops giving the registry, its rules, its checks and itself to the owners;
// - with SEED_BASE and SEED_ACTOR, any of the logins in SEED_ACTOR is outside SEED_OWNERS and the
//   change since SEED_BASE (the pull request's base, or the commit before a push to main) touches a
//   cleared entry, any clearance, the owner list, or any other file OWNED lists.
//
// With SEED_HEAD it checks that commit instead of the working tree, and only the owner rule and
// the registry's validity: seed-guard runs it from the base branch, so a pull request cannot change
// the check that judges it (it never runs the pull request's code, it reads its files from git).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ownerOnlyChanges, SEED_OWNERS, validateRegistry, type Registry } from '../packages/shared/src/seeds.ts';

const REGISTRY = 'packages/shared/src/seed-registry.json';
const RULES = 'packages/shared/src/seeds.ts';
/** The files only an owner may change, each one CODEOWNERS must give to every owner. */
const OWNED = [
	'/packages/shared/src/seed-registry.json',
	'/packages/shared/src/seeds.ts',
	'/scripts/check-seeds.ts',
	'/.github/workflows/seed-guard.yml',
	'/.github/CODEOWNERS'
];

const root = new URL('../', import.meta.url);
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
/** A file as a commit holds it, or undefined when the commit has none. */
const at = (rev: string, path: string): string | undefined => {
	try {
		return git('show', `${rev}:${path}`);
	} catch {
		return undefined;
	}
};
const problems: string[] = [];

const base = process.env.SEED_BASE?.trim();
const head = process.env.SEED_HEAD?.trim();
const actors = [...new Set((process.env.SEED_ACTOR ?? '').split(/[\s,]+/).filter(Boolean))];
if (head && !base) throw new Error('SEED_HEAD needs SEED_BASE, the commit it is compared with');
if (base && actors.length === 0) throw new Error('SEED_BASE needs SEED_ACTOR, the GitHub logins that made the change');

const registryText = head ? at(head, REGISTRY) : readFileSync(new URL(REGISTRY, root), 'utf8');
const registry = JSON.parse(registryText ?? '{"entries": []}') as Registry;
if (registryText === undefined) problems.push(`${head} has no ${REGISTRY}`);

/** The owners as a copy of seeds.ts lists them, or undefined. */
const ownerList = (text: string | undefined): string[] | undefined => {
	const list = /SEED_OWNERS\s*=\s*\[([^\]]*)\]/.exec(text ?? '')?.[1];
	return list === undefined ? undefined : [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
};
// The owners as base had them: nobody can add themselves and approve their own change.
const baseOwners = (base && ownerList(at(base, RULES))) || SEED_OWNERS;
const byOwners = actors.length > 0 && actors.every((a) => baseOwners.includes(a));

// An owner's change may also change the rules, which the head checks run with; this copy may be older.
if (!(head && byOwners)) problems.push(...validateRegistry(registry));

if (!head) {
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
}

if (base) {
	const before = at(base, REGISTRY);
	const changed = ownerOnlyChanges(before ? (JSON.parse(before) as Registry).entries : [], registry.entries);
	const headOwners = head ? ownerList(at(head, RULES)) : SEED_OWNERS;
	if (headOwners?.join() !== baseOwners.join()) changed.push('SEED_OWNERS');
	// The rules, the checks and CODEOWNERS themselves: whoever could change them could pass anything.
	// Before base had the rules there was no owner rule to keep, so the change bringing them is free.
	if (at(base, RULES) !== undefined) {
		const files = new Set(git('diff', '--name-only', base, ...(head ? [head] : []), '--').split('\n').filter(Boolean));
		for (const path of OWNED.map((p) => p.slice(1))) if (path !== REGISTRY && files.has(path)) changed.push(path);
	}
	if (changed.length && !byOwners) {
		const others = actors.filter((a) => !baseOwners.includes(a));
		problems.push(`${others.join(', ')} changed ${changed.join(', ')}, which only ${baseOwners.join(', ')} may change: a cleared entry, a clearance, the owner list or the seed rules and checks`);
	}
}

if (problems.length) {
	for (const p of problems) console.error(`check-seeds: ${p}`);
	process.exit(1);
}
console.log(`check-seeds: ${registry.entries.length} registry entries valid, ${registry.entries.filter((e) => e.clearance.status === 'cleared').length} cleared`);
