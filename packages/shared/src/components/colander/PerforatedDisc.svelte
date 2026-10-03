<!--
@component PerforatedDisc: a colander seen from above, concentric rings of holes, for the 404
page and empty states. `mark` puts the brand mark at that size in the middle. Decorative.
-->
<script lang="ts">
	import ColanderMark from './ColanderMark.svelte';

	let {
		size = 160,
		rings = Math.max(2, Math.min(9, Math.round(size / 22))),
		mark = 0,
		class: className = ''
	}: { size?: number; rings?: number; mark?: number; class?: string } = $props();

	const step = 24;
	const outer = $derived((rings + 1) * step);
	// Leave the middle clear for the mark.
	const clear = $derived(mark ? (mark / size) * (outer + 8) * 0.75 : 0);
	const holes = $derived.by(() => {
		const out: { x: number; y: number }[] = clear ? [] : [{ x: 0, y: 0 }];
		for (let ring = 1; ring <= rings; ring++) {
			const radius = ring * step;
			if (radius < clear) continue;
			const count = Math.round((2 * Math.PI * radius) / 22);
			const offset = ring % 2 ? 0 : Math.PI / count;
			for (let i = 0; i < count; i++) {
				const a = offset + (i / count) * 2 * Math.PI;
				out.push({ x: +(radius * Math.cos(a)).toFixed(2), y: +(radius * Math.sin(a)).toFixed(2) });
			}
		}
		return out;
	});
</script>

<div class="disc {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true">
	<svg viewBox="{-outer - 8} {-outer - 8} {2 * outer + 16} {2 * outer + 16}" width={size} height={size} focusable="false">
		<circle r={outer} fill="none" stroke="currentColor" stroke-width="2" />
		<circle r={outer - 8} fill="none" stroke="currentColor" stroke-width="1" opacity="0.6" />
		{#each holes as h, i (i)}
			<circle cx={h.x} cy={h.y} r="4" fill="currentColor" />
		{/each}
	</svg>
	{#if mark}<span class="mark"><ColanderMark size={mark} /></span>{/if}
</div>

<style>
	.disc {
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		color: var(--cl-dot-strong);
	}
	.disc svg {
		position: absolute;
		inset: 0;
	}
	.mark {
		position: relative;
		color: var(--cl-text);
	}
</style>
