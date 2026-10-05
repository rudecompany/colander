<!--
@component VerdictChip: glyph and verdict word, never truncated. The same markup and CSS
(styles/parts.css) as the in-page chip builder, so the two are pixel-identical.

Sizes: `sm` 20 for rows and tables, `md` 24 (default), `lg` 28 for plain-language chips and the
source banner. `tone="tint"` in panels and on host pages (tint fill, text color, glyph in the
verdict color); `tone="ink"` on thumbnails and swipe feeds. `plain` uses the plain-language
phrase. A null verdict renders a dashed "Not rated" chip.
-->
<script lang="ts">
	import VerdictGlyph from './VerdictGlyph.svelte';
	import { VERDICT_PLAIN, VERDICT_WORD, type Verdict } from '../../verdicts';

	let {
		verdict,
		tone = 'tint',
		plain = false,
		size = plain ? 'lg' : 'md'
	}: { verdict: Verdict | null; tone?: 'tint' | 'ink'; plain?: boolean; size?: 'sm' | 'md' | 'lg' } = $props();
</script>

{#if verdict}
	<span class="cl-chip cl-chip-{size} cl-chip-{tone}" data-v={verdict}>
		<VerdictGlyph {verdict} size={size === 'lg' ? 14 : 12} />
		<span>{plain ? VERDICT_PLAIN[verdict] : VERDICT_WORD[verdict]}</span>
	</span>
{:else}
	<span class="cl-chip cl-chip-{size} cl-chip-none"><span>Not rated</span></span>
{/if}
