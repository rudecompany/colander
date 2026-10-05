<!--
@component VerdictTransition: the verdict before, an arrow, the verdict after. Screen readers
hear "Verdict changed from Likely slop to Clear". Each chip sits in its own box (.from, .to), so a
list of rows can give them fixed tracks and line the arrows up. A review that kept the verdict
(staff confirming Slop) reads as one chip and the word "Confirmed", never "Slop -> Slop".
-->
<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import VerdictChip from './VerdictChip.svelte';
	import { VERDICT_WORD, type Verdict } from '../../verdicts';

	let { from, to, size = 'sm' }: { from: Verdict | null; to: Verdict | null; size?: 'sm' | 'md' } = $props();
	const word = (v: Verdict | null) => (v ? VERDICT_WORD[v] : 'Not rated');
</script>

<span class="tr">
	{#if from === to}
		<span class="cl-sr-only">Verdict confirmed as {word(to)}</span>
		<span class="vis" aria-hidden="true">
			<span class="from"><VerdictChip verdict={to} {size} /></span>
			<span class="same">Confirmed</span>
		</span>
	{:else}
		<span class="cl-sr-only">Verdict changed from {word(from)} to {word(to)}</span>
		<span class="vis" aria-hidden="true">
			<span class="from"><VerdictChip verdict={from} {size} /></span>
			<ArrowRight size={16} />
			<span class="to"><VerdictChip verdict={to} {size} /></span>
		</span>
	{/if}
</span>

<style>
	.tr,
	.vis,
	.from,
	.to {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
	.same {
		font: var(--cl-chip);
	}
</style>
