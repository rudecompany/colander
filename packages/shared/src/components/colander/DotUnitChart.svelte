<!--
@component DotUnitChart: a grid of data dots filled row by row from the top left. Two paths in
all, each filled with a dot pattern: one for the filled region, one for the rest. Filled dots
are the text color, empty ones --cl-dot-strong. role="img" with a full-sentence `label`; set the
number beside it in text too.
-->
<script lang="ts">
	let {
		cols,
		rows,
		filled,
		pitch = 12,
		dot = 4,
		label
	}: { cols: number; rows: number; filled: number; pitch?: number; dot?: number; label: string } = $props();

	const uid = $props.id();
	const w = $derived(cols * pitch);
	const ht = $derived(rows * pitch);
	const full = $derived(Math.floor(filled / cols));
	const rest = $derived(filled % cols);
	// The filled region: full rows, then the start of the next row.
	const on = $derived(`M0 0H${w}V${full * pitch}H${rest * pitch}V${(full + 1) * pitch}H0Z`);
	const off = $derived(`M0 ${(full + 1) * pitch}H${rest * pitch}V${full * pitch}H${w}V${ht}H0Z`);
</script>

<svg class="chart" viewBox="0 0 {w} {ht}" width={w} height={ht} role="img" aria-label={label}>
	<defs>
		<pattern id="{uid}-on" width={pitch} height={pitch} patternUnits="userSpaceOnUse">
			<circle cx={pitch / 2} cy={pitch / 2} r={dot / 2} style="fill: var(--cl-text)" />
		</pattern>
		<pattern id="{uid}-off" width={pitch} height={pitch} patternUnits="userSpaceOnUse">
			<circle cx={pitch / 2} cy={pitch / 2} r={dot / 2} style="fill: var(--cl-dot-strong)" />
		</pattern>
	</defs>
	<path d={on} fill="url(#{uid}-on)" />
	<path d={off} fill="url(#{uid}-off)" />
</svg>

<style>
	.chart {
		display: block;
		max-width: 100%;
		height: auto;
	}
</style>
