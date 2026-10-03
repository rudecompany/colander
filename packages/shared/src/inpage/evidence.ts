// The evidence card's one data model and copy. The in-page builder (evidencePopover) and the
// Svelte EvidenceCard both render an Evidence, so the story reads the same everywhere.
import { INPAGE_COPY } from '../copy';
import { LAYER_EMPTY, LAYER_KEYS, LAYER_SHORT, LAYER_SIGNALS, type LayerKey } from '../layers';
import { appealPath, fmtShortDate, sourcePath, type DateInput } from '../utils/format';
import { SIGNAL_TEXT, SOURCE_NOUN, type Platform, type Signal, type Verdict } from '../verdicts';

export interface EvidenceRow {
	/** A layer, `review` for staff review and appeals, or any key for the person's own rules. */
	key: LayerKey | 'review' | string;
	label: string;
	/** One sentence per signal, each ending in a full stop. */
	texts: string[];
	/** Filled dot when the layer agreed; hollow ring when it has no data yet. */
	agreed: boolean;
}

export interface Evidence {
	verdict: Verdict | null;
	/** The chip word when there is no verdict, such as "Your rule". */
	word: string | null;
	title: string;
	/** Every layer in order. The popover shows the first 3 by `popoverRows`. */
	rows: EvidenceRow[];
	/** "Core list, updated 2 Oct 2026", or null when the date is unknown. */
	list: string | null;
	sourceUrl: string | null;
	appealUrl: string | null;
	appealText: string | null;
}

export interface EvidenceInput {
	verdict: Verdict | null;
	signals?: Signal[];
	/** Hidden or collapsed, as opposed to labeled. Picks the title. */
	hidden: boolean;
	/** Rows given directly, such as the demo's or the person's own rules. Replaces the signal rows. */
	rows?: { layer?: LayerKey; key?: string; label?: string; text: string; agreed: boolean }[];
	word?: string;
	listDate?: DateInput | null;
	imported?: boolean;
	platform?: Platform;
	sourceId?: string | null;
	/** Website origin for links; empty for same-site links. */
	site?: string;
	/** Only list verdicts can be appealed. */
	appealable?: boolean;
}

const sentence = (s: string) => (/[.?]$/.test(s) ? s : `${s}.`);

export function evidence(input: EvidenceInput, fmt: (t: DateInput) => string = fmtShortDate): Evidence {
	const signals = input.signals ?? [];
	let rows: EvidenceRow[];
	if (input.rows) {
		rows = input.rows.map((r) => ({
			key: r.layer ?? r.key ?? 'rule',
			label: r.label ?? (r.layer ? LAYER_SHORT[r.layer] : ''),
			texts: [sentence(r.text)],
			agreed: r.agreed
		}));
	} else {
		rows = LAYER_KEYS.map((layer) => {
			const hits = LAYER_SIGNALS[layer].filter((s) => signals.includes(s));
			return {
				key: layer,
				label: LAYER_SHORT[layer],
				texts: hits.length ? hits.map((s) => sentence(SIGNAL_TEXT[s])) : [LAYER_EMPTY[layer]],
				agreed: hits.length > 0
			};
		});
		const review = (['staff_review', 'open_appeal'] as Signal[]).filter((s) => signals.includes(s));
		if (review.length) rows.push({ key: 'review', label: 'Review', texts: review.map((s) => sentence(SIGNAL_TEXT[s])), agreed: true });
	}
	const { platform, sourceId, site = '' } = input;
	const linkable = !!platform && !!sourceId;
	return {
		verdict: input.verdict,
		word: input.word ?? null,
		title: input.hidden ? INPAGE_COPY.whyHidden : INPAGE_COPY.whyLabeled,
		rows,
		list: input.listDate
			? `${INPAGE_COPY.coreList(fmt(input.listDate))}${input.imported ? ', imported and not yet reviewed' : ''}`
			: null,
		sourceUrl: linkable ? site + sourcePath(platform, sourceId) : null,
		appealUrl: linkable && input.appealable ? site + appealPath(platform, sourceId) : null,
		appealText: linkable && input.appealable ? INPAGE_COPY.appeal(SOURCE_NOUN[platform]) : null
	};
}

/** The rows a popover shows: agreed layers first, then layers with no data, 3 at most. */
export function popoverRows(ev: Evidence): EvidenceRow[] {
	return [...ev.rows.filter((r) => r.agreed), ...ev.rows.filter((r) => !r.agreed)].slice(0, 3);
}

/** Layers with no data fold into one line on full cards: "2 layers have no data yet." */
export function emptyLayersLine(ev: Evidence): string | null {
	const n = ev.rows.filter((r) => !r.agreed).length;
	return n ? `${n} ${n === 1 ? 'layer has' : 'layers have'} no data yet.` : null;
}
