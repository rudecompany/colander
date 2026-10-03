<!-- @component The verdict chip, or a neutral "Not rated" chip when there is no verdict. -->
<script lang="ts">
	import { VerdictChip, type Verdict } from '@colander/shared';

	let { verdict, size = 'md' }: { verdict: Verdict | null; size?: 'md' | 'lg' } = $props();
</script>

{#if verdict}
	<VerdictChip {verdict} {size} />
{:else}
	<span class="chip-none" class:lg={size === 'lg'}>Not rated</span>
{/if}

<style>
	.lg {
		font-size: 14px;
		line-height: 20px;
		padding: 3px 9px;
	}
</style>
