<!--
@component StrictnessControl: the four-stop segmented control and the one line that says what
the chosen level does. The same control in the popup, the hero, welcome and options.
Heights: `md` 32 (extension), `lg` 40, `xl` 44 (website hero, welcome).
-->
<script lang="ts">
	import '../ui/segmented-control/segmented-control.css';
	import SegmentedControl from '../ui/segmented-control/segmented-control.svelte';
	import { STRICTNESS, STRICTNESS_HINT, STRICTNESS_WORD, type Strictness } from '../../verdicts';

	let {
		value = $bindable('standard'),
		onChange,
		size = 'md',
		hint = true,
		label = 'Strictness',
		disabled = false
	}: {
		value?: Strictness;
		onChange?: (next: Strictness) => void;
		size?: 'md' | 'lg' | 'xl';
		hint?: boolean;
		label?: string;
		disabled?: boolean;
	} = $props();

	const uid = $props.id();
	const options = $derived(STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s], disabled })));
</script>

<div class="sc sc-{size}" aria-describedby={hint ? `${uid}-hint` : undefined}>
	<SegmentedControl {options} bind:value {onChange} ariaLabel={label} {size} />
	{#if hint}<p class="hint" id="{uid}-hint">{STRICTNESS_HINT[value]}</p>{/if}
</div>

<style>
	.sc {
		display: grid;
		justify-items: start;
		gap: 8px;
	}
	.sc :global(.uin-seg) {
		max-width: 100%;
	}
	.hint {
		margin: 0;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.sc-lg .hint,
	.sc-xl .hint {
		font: var(--cl-body);
	}
</style>
