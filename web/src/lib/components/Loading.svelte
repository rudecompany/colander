<!-- @component Loading: a static 3-dot mark and the word, never a spinner or shimmer. -->
<script lang="ts">
	let { label = 'Loading' }: { label?: string } = $props();
</script>

<div class="loading" role="status">
	<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
	<span>{label}</span>
</div>

<style>
	.loading {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding-block: 16px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.dots {
		display: inline-flex;
		gap: 4px;
	}
	i {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
</style>
