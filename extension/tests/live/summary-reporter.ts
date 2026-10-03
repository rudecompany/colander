// Reports the live adapter checks for the daily workflow (P0-2): a table of every surface in the
// GitHub job summary ($GITHUB_STEP_SUMMARY) and a ::warning:: for each one left unverified, so a
// surface without credentials, or one the site refused, is visible every day. Failures already
// fail the run; this only makes the gaps visible. It ignores every project but `live`.
import { appendFileSync } from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

interface Row {
	surface: string;
	credentials: string;
	outcome: 'verified' | 'unverified' | 'failed';
	detail: string;
}

export default class LiveSummary implements Reporter {
	private rows = new Map<string, Row>();

	onTestEnd(test: TestCase, result: TestResult): void {
		if (test.parent.project()?.name !== 'live') return;
		const notes = [...test.annotations, ...(result.annotations ?? [])];
		const note = (type: string) => notes.findLast((a) => a.type === type)?.description ?? '';
		const outcome = result.status === 'passed' ? 'verified' : result.status === 'skipped' ? 'unverified' : 'failed';
		const detail = outcome === 'verified' ? note('found') : outcome === 'unverified' ? note('skip').replace(/^unverified: /, '') : (result.error?.message ?? result.status).split('\n')[0]!;
		// A retry replaces the first attempt's row.
		this.rows.set(test.title, { surface: test.title, credentials: note('credentials'), outcome, detail });
	}

	onEnd(): void {
		if (!this.rows.size) return;
		const rows = [...this.rows.values()];
		for (const r of rows) if (r.outcome === 'unverified') console.log(`::warning title=Adapter surface unverified::${r.surface}: ${r.detail}`);
		const file = process.env.GITHUB_STEP_SUMMARY;
		if (!file) return;
		const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length;
		const cell = (s: string) => s.replace(/\|/g, '\\|');
		appendFileSync(
			file,
			[
				'## Adapter surfaces',
				'',
				`${count('verified')} verified, ${count('unverified')} unverified, ${count('failed')} failed.`,
				'Unverified surfaces were not checked today: add the platform\'s storage state secret (COLANDER_LIVE_STATE_YT, _TT, _IG or _FB) to check them.',
				'',
				'| Surface | Credentials | Result | Detail |',
				'| --- | --- | --- | --- |',
				...rows.map((r) => `| ${cell(r.surface)} | ${r.credentials} | ${r.outcome} | ${cell(r.detail)} |`),
				''
			].join('\n')
		);
	}
}
