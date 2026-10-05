<!--
@component VerdictGlyph: the verdict's own shape in currentColor. Decorative; always beside the word.
12 in chips, 16 in rows, 20 in the evidence card header, 56 in the website specimen strip,
32 in mobile specimen rows. Monochrome (the text color) outside chips.
-->
<script lang="ts">
	import { GLYPHS, GLYPH_VIEWBOX } from '../../glyphs';
	import type { Verdict } from '../../verdicts';

	let { verdict, size = 12 }: { verdict: Verdict; size?: number } = $props();
</script>

<svg viewBox={GLYPH_VIEWBOX} width={size} height={size} aria-hidden="true" focusable="false" class="cl-glyph">
	{#each GLYPHS[verdict] as s, i (i)}
		{#if s.stroke}
			<path d={s.d} fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" />
		{:else}
			<path d={s.d} fill="currentColor" fill-rule={s.evenodd ? 'evenodd' : undefined} />
		{/if}
	{/each}
</svg>
