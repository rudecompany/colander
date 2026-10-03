<!--
@component Thumb: a demo thumbnail, drawn from the same scene data as the in-page builder.
Neutral tones only. Decorative.
-->
<script lang="ts">
	import type { ThumbScene } from '../../copy';
	import { THUMB_SCENES, THUMB_STYLE, toneVar } from '../../inpage/thumbs';

	let { scene, part }: { scene: ThumbScene; part?: number } = $props();
	const s = $derived(THUMB_SCENES[scene]);
	const paint = (tone: Parameters<typeof toneVar>[0], stroke?: number) =>
		stroke ? `fill:none;stroke:${toneVar(tone)};stroke-width:${stroke}` : `fill:${toneVar(tone)}`;
</script>

<svg viewBox="0 0 160 90" class="cl-thumb" style={THUMB_STYLE} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
	<rect width="160" height="90" style={paint(s.bg)} />
	{#each s.prims as p, i (i)}
		{#if 'rect' in p}
			<rect x={p.rect[0]} y={p.rect[1]} width={p.rect[2]} height={p.rect[3]} style={paint(p.tone)} />
		{:else if 'circle' in p}
			<circle cx={p.circle[0]} cy={p.circle[1]} r={p.circle[2]} style={paint(p.tone)} />
		{:else if 'path' in p}
			<path d={p.path} style={paint(p.tone, p.stroke)} />
		{:else if part != null}
			<text x={p.x} y={p.y} style="{paint(p.tone)};font:700 {p.size}px var(--cl-font)">{scene === 'template-a' ? `Part ${part}` : part}</text>
		{/if}
	{/each}
</svg>

<style>
	.cl-thumb {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
