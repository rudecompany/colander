<!--
@component VerdictGlyph: the verdict's own shape, colored by currentColor. Decorative; always pair with the verdict word.
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

<style>
	.cl-glyph {
		flex: none;
		display: block;
	}
</style>
