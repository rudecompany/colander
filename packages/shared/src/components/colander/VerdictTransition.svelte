<!--
@component VerdictTransition: the verdict before, an arrow, the verdict after. Screen readers
hear "Verdict changed from Likely slop to Clear".
-->
<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import VerdictChip from './VerdictChip.svelte';
	import { VERDICT_WORD, type Verdict } from '../../verdicts';

	let { from, to, size = 'sm' }: { from: Verdict | null; to: Verdict | null; size?: 'sm' | 'md' } = $props();
	const word = (v: Verdict | null) => (v ? VERDICT_WORD[v] : 'Not rated');
</script>

<span class="tr">
	<span class="cl-sr-only">Verdict changed from {word(from)} to {word(to)}</span>
	<span class="vis" aria-hidden="true">
		<VerdictChip verdict={from} {size} />
		<ArrowRight size={16} />
		<VerdictChip verdict={to} {size} />
	</span>
</span>

<style>
	.tr,
	.vis {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
</style>
