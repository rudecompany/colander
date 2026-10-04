<!--
@component TagTally: the community's tags on a source, drawn one way everywhere (the /s page and
the side panel): each tag's glyph and word (TAG_WORD), a 50-dot DotMeter on one scale shared by
all three rows, the count, and the legend "Each dot is N tags". Tags are not verdicts, so the
glyphs are monochrome, beside their words.
-->
<script lang="ts">
	import DotMeter from './DotMeter.svelte';
	import VerdictGlyph from './VerdictGlyph.svelte';
	import { TAG_GLYPH } from '../../copy';
	import { fmtNum, plural } from '../../utils/format';
	import { TAG_WORD, type TagVerdict } from '../../verdicts';

	let { tags }: { tags: Record<TagVerdict, number> } = $props();

	const KEYS: TagVerdict[] = ['slop', 'ai_fine', 'not_slop'];
	// Each dot is a whole number of tags, so the largest row fits in its 50 dots.
	const perDot = $derived(Math.max(1, Math.ceil(Math.max(...KEYS.map((k) => tags[k])) / 50)));
</script>

<div class="tally">
	<ul>
		{#each KEYS as k (k)}
			<li>
				<span class="word"><VerdictGlyph verdict={TAG_GLYPH[k]} size={16} />{TAG_WORD[k]}</span>
				<DotMeter value={tags[k]} max={50 * perDot} />
				<b>{fmtNum(tags[k])}</b>
			</li>
		{/each}
	</ul>
	<p class="legend">Each dot is {plural(perDot, 'tag')}.</p>
</div>

<style>
	.tally {
		display: grid;
		gap: 8px;
	}
	/* Each tag: its glyph and word with the count at the end, and its dots under them. */
	ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 4px 8px;
	}
	li :global(.meter) {
		grid-row: 2;
		grid-column: 1 / -1;
	}
	.word {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		color: var(--cl-text);
		font: var(--cl-body);
	}
	.word :global(.cl-glyph) {
		flex: none;
	}
	b {
		grid-row: 1;
		grid-column: 2;
		font: var(--cl-body-strong);
		font-variant-numeric: tabular-nums;
	}
	.legend {
		margin: 0;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
</style>
