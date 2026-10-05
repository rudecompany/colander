<!--
@component PlatformTag: the platform's name in words, as an outline badge. Never a logo.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import { PLATFORM_NAME, type Platform } from '../../verdicts';

	let { platform, size = 'md' }: { platform: Platform; size?: 'md' | 'lg' } = $props();
</script>

<span class="uin-badge uin-badge-{size}">{PLATFORM_NAME[platform]}</span>
