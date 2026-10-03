<!--
@component Thumb: a demo thumbnail, drawn from the same scene data as the in-page builder: an
illustration with, on the two slop templates, a large numeral drawn in code. Decorative.
-->
<script lang="ts">
	import type { ThumbScene } from '../../copy';
	import { THUMB_SCENES, THUMB_STYLE, numeralText, toneVar } from '../../inpage/thumbs';

	let { scene, part }: { scene: ThumbScene; part?: number } = $props();
	const s = $derived(THUMB_SCENES[scene]);
</script>

<svg viewBox="0 0 160 90" class="cl-thumb" style={THUMB_STYLE} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
	<rect width="160" height="90" style="fill:{toneVar(s.bg)}" />
	<image href={s.image} width="160" height="90" preserveAspectRatio="xMidYMid slice" />
	{#if part != null}
		{#each s.numeral ?? [] as line, i (i)}
			<text
				x={line.x}
				y={line.y}
				text-anchor="middle"
				style="fill:{line.fill};stroke:{line.halo};stroke-width:{line.size / 9};paint-order:stroke;font:700 {line.size}px var(--cl-font)"
				>{numeralText(line, part)}</text
			>
		{/each}
	{/if}
</svg>

<style>
	.cl-thumb {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
