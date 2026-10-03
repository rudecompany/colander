<script lang="ts">
	import { ColanderMark } from '@colander/shared';

	let { size = 28 }: { size?: number } = $props();
</script>

<span class="wordmark" style:--mark-size="{size}px">
	<ColanderMark {size} />
	<span class="word">Colander</span>
</span>

<style>
	.wordmark {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--cl-text);
	}
	.word {
		font: 700 20px/28px var(--cl-font);
		letter-spacing: -0.01em;
	}
</style>
