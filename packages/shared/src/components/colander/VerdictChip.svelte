<!--
@component VerdictChip: glyph and verdict word. Never truncated.
`tone="tint"` for panels and pages (verdict color on its tint); `tone="ink"` for chips over media
(ink background, verdict media color). `plain` swaps the word for the plain-language phrase.
-->
<script lang="ts">
	import VerdictGlyph from './VerdictGlyph.svelte';
	import { VERDICT_PLAIN, VERDICT_WORD, type Verdict } from '../../verdicts';

	let {
		verdict,
		tone = 'tint',
		plain = false,
		size = 'md'
	}: { verdict: Verdict; tone?: 'tint' | 'ink'; plain?: boolean; size?: 'md' | 'lg' } = $props();
</script>

<span class="cl-chip cl-chip-{tone} cl-chip-{size}" data-verdict={verdict}>
	<VerdictGlyph {verdict} size={size === 'lg' ? 16 : 12} />
	<span>{plain ? VERDICT_PLAIN[verdict] : VERDICT_WORD[verdict]}</span>
</span>

<style>
	.cl-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 8px;
		border-radius: var(--cl-r-chip);
		font: var(--cl-chip);
		white-space: nowrap;
		border: 1px solid transparent;
	}
	.cl-chip-lg {
		font-size: 14px;
		line-height: 20px;
		padding: 4px 10px;
	}
	.cl-chip-ink {
		background: var(--cl-ink);
		color: #f2f0eb;
	}
	.cl-chip-tint[data-verdict='slop'] { color: var(--cl-slop); background: var(--cl-slop-tint); }
	.cl-chip-tint[data-verdict='likely_slop'] { color: var(--cl-likely); background: var(--cl-likely-tint); }
	.cl-chip-tint[data-verdict='ai_made'] { color: var(--cl-ai); background: var(--cl-ai-tint); }
	.cl-chip-tint[data-verdict='disputed'] { color: var(--cl-disputed); background: var(--cl-disputed-tint); }
	.cl-chip-tint[data-verdict='clear'] { color: var(--cl-clear); background: var(--cl-clear-tint); }
	.cl-chip-ink[data-verdict='slop'] :global(.cl-glyph) { color: var(--cl-slop-media); }
	.cl-chip-ink[data-verdict='likely_slop'] :global(.cl-glyph) { color: var(--cl-likely-media); }
	.cl-chip-ink[data-verdict='ai_made'] :global(.cl-glyph) { color: var(--cl-ai-media); }
	.cl-chip-ink[data-verdict='disputed'] :global(.cl-glyph) { color: var(--cl-disputed-media); }
	.cl-chip-ink[data-verdict='clear'] :global(.cl-glyph) { color: var(--cl-clear-media); }
</style>
