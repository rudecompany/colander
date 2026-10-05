<!--
@component ColanderMark: the brand mark, from glyphs.ts.
The full mark at 24 px and up, the simplification below. In the text color on pages:
24 in the website header and options nav, 20 in the popup and side panel, 48 in the welcome
header, 64 in empty states, 160 on the 404 disc. --cl-mark is for the toolbar icon, favicon and
store icon only; set `color` on a parent to use it.

`outline` is the paused state (outlined, with pause bars at 32 px and up). `attention` adds the
paper dot with an ink ring at the top right. Decorative unless `label` is given.
-->
<script lang="ts">
	import { markShapes } from '../../glyphs';

	let {
		size = 24,
		small,
		outline = false,
		attention = false,
		label
	}: { size?: number; small?: boolean; outline?: boolean; attention?: boolean; label?: string } = $props();

	const m = $derived(markShapes(size, { outline, small }));
	// The attention dot: 5 px at 16, 8 at 32, 12 at 48, 24 at 128, with a 1 px knockout.
	const dot = $derived.by(() => {
		const px = size <= 16 ? 5 : size <= 32 ? 8 : size <= 48 ? 12 : Math.round(size * 0.1875);
		const [x, y, w] = m.viewBox.split(' ').map(Number) as [number, number, number];
		const unit = w / size;
		const r = (px / 2) * unit;
		return { cx: x + w - r, cy: y + r, r, ring: unit, knock: r + unit };
	});
	const uid = $props.id();
	const maskId = `cl-mark-${uid}`;
</script>

<svg
	class="cl-mark"
	viewBox={m.viewBox}
	width={size}
	height={size}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	{#if attention}
		<mask id={maskId}>
			<rect x="-30" y="-30" width="60" height="60" fill="white" />
			<circle cx={dot.cx} cy={dot.cy} r={dot.knock} fill="black" />
		</mask>
	{/if}
	<g mask={attention ? `url(#${maskId})` : undefined}>
		{#each m.shapes as s, i (i)}
			{#if s.stroke}
				<path d={s.d} fill="none" stroke="currentColor" stroke-width={m.strokeWidth} stroke-linejoin="round" />
			{:else}
				<path d={s.d} fill="currentColor" fill-rule={s.evenodd ? 'evenodd' : undefined} />
			{/if}
		{/each}
	</g>
	{#if attention}
		<circle
			cx={dot.cx}
			cy={dot.cy}
			r={dot.r - dot.ring / 2}
			stroke-width={dot.ring}
			style="fill: var(--cl-paper, #faf7f2); stroke: var(--cl-ink, #1a1c1f)"
		/>
	{/if}
</svg>

<style>
	.cl-mark {
		display: block;
		flex: none;
	}
</style>
