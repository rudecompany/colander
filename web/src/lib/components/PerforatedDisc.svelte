<!-- @component A colander seen from above: concentric rings of holes. Decorative. -->
<script lang="ts">
	let { size = 520, rings = 9, class: className = '' }: { size?: number; rings?: number; class?: string } = $props();

	const step = 24;
	const outer = $derived((rings + 1) * step);
	const holes = $derived.by(() => {
		const out: { x: number; y: number; r: number }[] = [{ x: 0, y: 0, r: 4 }];
		for (let ring = 1; ring <= rings; ring++) {
			const radius = ring * step;
			const count = Math.round((2 * Math.PI * radius) / 22);
			const offset = ring % 2 ? 0 : Math.PI / count;
			for (let i = 0; i < count; i++) {
				const a = offset + (i / count) * 2 * Math.PI;
				out.push({ x: +(radius * Math.cos(a)).toFixed(2), y: +(radius * Math.sin(a)).toFixed(2), r: 4 });
			}
		}
		return out;
	});
</script>

<svg
	class="disc {className}"
	viewBox="{-outer - 8} {-outer - 8} {2 * outer + 16} {2 * outer + 16}"
	width={size}
	height={size}
	aria-hidden="true"
	focusable="false"
>
	<circle r={outer} fill="none" stroke="currentColor" stroke-width="2" opacity="0.55" />
	<circle r={outer - 8} fill="none" stroke="currentColor" stroke-width="1" opacity="0.35" />
	{#each holes as h, i (i)}
		<circle cx={h.x} cy={h.y} r={h.r} fill="currentColor" />
	{/each}
</svg>

<style>
	.disc {
		color: var(--w-dot-strong);
	}
</style>
