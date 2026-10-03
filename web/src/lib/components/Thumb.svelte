<!-- @component Abstract thumbnail art for the feed mock-up. No stock imagery, just shapes. -->
<script lang="ts">
	let { art }: { art: number } = $props();
</script>

<svg viewBox="0 0 160 90" class="thumb" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
	<rect width="160" height="90" class="bg" />
	{#if art === 0}
		<rect x="0" y="62" width="160" height="28" class="s1" />
		<circle cx="58" cy="58" r="14" class="s3" />
		<circle cx="58" cy="58" r="5" class="bg" />
		<circle cx="108" cy="58" r="14" class="s3" />
		<circle cx="108" cy="58" r="5" class="bg" />
		<path d="M52 44h44l12 14H58z" class="s2" />
	{:else if art === 1}
		<circle cx="118" cy="26" r="11" class="s2" />
		<path d="M14 80l34-44 34 44zM62 80l30-36 30 36z" class="s3" />
		<rect x="0" y="78" width="160" height="12" class="s1" />
	{:else if art === 2}
		<circle cx="54" cy="44" r="26" class="s2" opacity="0.8" />
		<circle cx="88" cy="50" r="22" class="s1" opacity="0.9" />
		<circle cx="112" cy="36" r="16" class="s3" opacity="0.55" />
	{:else if art === 3}
		<path d="M40 30l40-16 40 16z" class="s3" />
		<rect x="44" y="34" width="8" height="38" class="s2" />
		<rect x="66" y="34" width="8" height="38" class="s2" />
		<rect x="86" y="34" width="8" height="38" class="s2" />
		<rect x="108" y="34" width="8" height="38" class="s2" />
		<rect x="36" y="72" width="88" height="6" class="s3" />
	{:else if art === 4}
		<path d="M0 52q20-10 40 0t40 0t40 0t40 0v38H0z" class="s1" />
		<path d="M0 64q20-10 40 0t40 0t40 0t40 0v26H0z" class="s2" />
		<path d="M98 22h22l-3 22h-16z" class="s3" />
	{:else}
		<circle cx="64" cy="45" r="24" class="s3" />
		<circle cx="64" cy="45" r="17" class="s1" />
		<circle cx="104" cy="52" r="18" class="s2" />
		<circle cx="104" cy="52" r="12" class="s1" />
	{/if}
</svg>

<style>
	.thumb {
		width: 100%;
		height: 100%;
		border-radius: var(--cl-r-chip);
	}
	.bg {
		fill: var(--cl-surface-raised);
	}
	.s1 {
		fill: color-mix(in srgb, var(--cl-text-muted) 22%, var(--cl-surface-raised));
	}
	.s2 {
		fill: color-mix(in srgb, var(--cl-text-muted) 40%, var(--cl-surface-raised));
	}
	.s3 {
		fill: color-mix(in srgb, var(--cl-text-muted) 62%, var(--cl-surface-raised));
	}
</style>
