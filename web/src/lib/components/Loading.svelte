<!-- @component Loading state: three perforation dots. Static when reduced motion is set. -->
<script lang="ts">
	let { label = 'Loading' }: { label?: string } = $props();
</script>

<div class="loading" role="status">
	<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
	<span class="text">{label}</span>
</div>

<style>
	.loading {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
		padding-block: var(--cl-s4);
	}
	.dots {
		display: inline-flex;
		gap: 5px;
	}
	i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		animation: pulse 1.2s var(--cl-ease) infinite;
	}
	i:nth-child(2) {
		animation-delay: 0.15s;
	}
	i:nth-child(3) {
		animation-delay: 0.3s;
	}
	@keyframes pulse {
		0%,
		80%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		i {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
