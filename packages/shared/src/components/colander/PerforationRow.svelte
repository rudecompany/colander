<!--
@component PerforationRow: 3 px dots at an 8 px pitch. Marks section edges, the bento connector
and the store-art seam. `vertical` runs it down instead of across. Decorative.
-->
<script lang="ts">
	let { vertical = false, class: className = '' }: { vertical?: boolean; class?: string } = $props();
</script>

<div class="{vertical ? 'cl-perf-v' : 'cl-perf'} {className}" aria-hidden="true"></div>
