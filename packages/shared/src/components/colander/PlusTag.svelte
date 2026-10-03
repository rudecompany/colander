<!--
@component PlusTag: an outline badge with a 12 px lock and the word "Plus", for gated features.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import Lock from '@lucide/svelte/icons/lock';

	let { size = 'md' }: { size?: 'md' | 'lg' } = $props();
</script>

<span class="uin-badge uin-badge-{size}"><Lock size={12} aria-hidden="true" />Plus</span>
