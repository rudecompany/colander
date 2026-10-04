<!--
@component InstallButton: "Add to Chrome" where Chrome extensions install, and "Send to my
computer" below 1024 px, where the header also swaps: phones and tablets run no extensions. Both
are in the page, so it reads right without JavaScript; CSS shows one. `caption` adds "Colander
runs in Chrome on desktop." under the phone button.
-->
<script lang="ts">
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import SendToComputer from './SendToComputer.svelte';

	let {
		label = 'Add to Chrome',
		variant = 'primary',
		size = 'xxl',
		block = true,
		caption = false
	}: { label?: string; variant?: 'primary' | 'secondary'; size?: 'xl' | 'xxl'; block?: boolean; caption?: boolean } = $props();
</script>

<span class="desk"><Button {variant} {size} {block} href={PUBLIC_STORE_URL}>{label}</Button></span>
<span class="phone"><SendToComputer {variant} {size} {caption} /></span>

<style>
	.desk,
	.phone {
		display: grid;
	}
	.phone {
		display: none;
	}
	@media (max-width: 1023px) {
		.desk {
			display: none;
		}
		.phone {
			display: grid;
			width: 100%;
		}
	}
</style>
