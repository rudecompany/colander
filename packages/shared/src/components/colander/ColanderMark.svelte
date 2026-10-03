<!--
@component ColanderMark: the brand mark. `small` uses the 16 px simplification, `outline` the paused state.
Decorative by default; pass `label` to expose it to screen readers.
-->
<script lang="ts">
	import { MARK, MARK_SMALL, MARK_SMALL_VIEWBOX, MARK_VIEWBOX } from '../../glyphs';

	let {
		size = 24,
		small = size <= 16,
		outline = false,
		label
	}: { size?: number; small?: boolean; outline?: boolean; label?: string } = $props();
	const shapes = $derived(small ? MARK_SMALL : MARK);
</script>

<svg
	viewBox={small ? MARK_SMALL_VIEWBOX : MARK_VIEWBOX}
	width={size}
	height={size}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
	style="flex:none;display:block"
>
	{#each shapes as s, i (i)}
		{#if outline}
			<path d={s.d} fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" opacity="0.5" />
		{:else}
			<path d={s.d} fill="currentColor" fill-rule={s.evenodd ? 'evenodd' : undefined} />
		{/if}
	{/each}
</svg>
