// The calibration report (seed design section 8): reads a calibration-export file and prints, per
// frame, the labeled counts and 95% Wilson lower bounds in every group, Cohen's kappa between the
// first two labelers, and how the scoring rules' verdicts compare with the labels. It needs only
// Node 24, and writes aggregates only: no channel ID or note leaves the export.
//
//   pnpm -C api exec wrangler r2 object get colander-backups/calibration/<time>.json --file export.json --remote
//   node scripts/calibration-report.ts export.json
//
// Each seed:<id> frame's "calibration" block is what the registry entry needs before an owner can
// promote that list to use "seed" (docs/contracts.md 14.2).
import { readFileSync } from 'node:fs';
import { wilsonLower, type CalibrationGroup } from '../packages/shared/src/seeds.ts';

const LABELS = ['slop', 'ai_not_slop', 'not_ai', 'gone', 'unsure'] as const;
type Label = (typeof LABELS)[number];

export interface ExportItem {
	platform: string;
	frame: string;
	large: boolean;
	computed: string | null;
	labels: { labeler: string; label: Label; language?: string | null; kind?: string | null; labeled_at: number }[];
}

/** The settled label: what two labelers agree on, or the majority of three; null while unsettled. */
export function settled(labels: ExportItem['labels']): Label | null {
	const counts = new Map<Label, number>();
	for (const l of labels) counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
	const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
	return n >= 2 && [...counts.values()].filter((c) => c === n).length === 1 ? top : null;
}

/**
 * What the labels say about the language or the kind of an item: the value most labelers gave, the
 * first label's on a tie, or "unknown" when none gave one.
 */
export function settledField(labels: ExportItem['labels'], field: 'language' | 'kind'): string {
	const values = [...labels].sort((a, b) => a.labeled_at - b.labeled_at).map((l) => l[field] ?? null).filter((v): v is string => v !== null);
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	const most = Math.max(0, ...counts.values());
	return values.find((v) => counts.get(v) === most) ?? 'unknown';
}

/** Cohen's kappa between the first two labels of each item, or null without any pair. */
export function kappa(items: ExportItem[]): { pairs: number; value: number | null } {
	const pairs = items
		.map((i) => [...i.labels].sort((a, b) => a.labeled_at - b.labeled_at))
		.filter((l) => l.length >= 2)
		.map((l) => [l[0]!.label, l[1]!.label] as const);
	if (pairs.length === 0) return { pairs: 0, value: null };
	const agree = pairs.filter(([a, b]) => a === b).length / pairs.length;
	let chance = 0;
	for (const c of LABELS) chance += (pairs.filter(([a]) => a === c).length / pairs.length) * (pairs.filter(([, b]) => b === c).length / pairs.length);
	return { pairs: pairs.length, value: chance === 1 ? 1 : (agree - chance) / (1 - chance) };
}

/** A group's counts with their lower bounds. */
const bounded = (g: CalibrationGroup) => ({ ...g, ai_lower: round(wilsonLower(g.ai, g.n)), slop_lower: round(wilsonLower(g.slop, g.n)) });
const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The report. A settled "gone" or "unsure" label, or an unsettled item, counts in no group; the
 * groups are "all", each platform, the audience size staff recorded (large or not recorded), each
 * language and music or other video (seed list review 16; CALIBRATION_GROUPS in seeds.ts).
 */
export function report(items: ExportItem[], date: string) {
	const frames: Record<string, unknown> = {};
	const confusion: Record<string, Record<string, number>> = {};
	let unsettled = 0;
	for (const frame of [...new Set(items.map((i) => i.frame))].sort()) {
		const groups = new Map<string, CalibrationGroup>();
		for (const i of items.filter((x) => x.frame === frame)) {
			const label = settled(i.labels);
			if (label === null) {
				unsettled++;
				continue;
			}
			const row = (confusion[i.computed ?? 'not_rated'] ??= {});
			row[label] = (row[label] ?? 0) + 1;
			if (label === 'gone' || label === 'unsure') continue;
			const names = [
				'all',
				`platform:${i.platform}`,
				`audience:${i.large ? 'large' : 'not_recorded'}`,
				`language:${settledField(i.labels, 'language')}`,
				`kind:${settledField(i.labels, 'kind')}`
			];
			for (const name of names) {
				const g = groups.get(name) ?? { group: name, n: 0, ai: 0, slop: 0 };
				g.n++;
				if (label !== 'not_ai') g.ai++;
				if (label === 'slop') g.slop++;
				groups.set(name, g);
			}
		}
		const list = [...groups.values()];
		frames[frame] = { groups: list.map(bounded), ...(frame.startsWith('seed:') ? { calibration: { report: date, groups: list } } : {}) };
	}
	return { report: date, items: items.length, unsettled, kappa: kappa(items), frames, confusion };
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.error('usage: node scripts/calibration-report.ts <calibration export JSON>');
		process.exit(2);
	}
	const data = JSON.parse(readFileSync(file, 'utf8')) as { exported_at: string; items: ExportItem[] };
	console.log(JSON.stringify(report(data.items, data.exported_at.slice(0, 10)), null, 2));
}
