<!--
@component InstallButton: "Add to Chrome", "Add to Edge", "Add to Firefox" or "Add to Opera", for
the store this browser installs from (lib/install.svelte.ts), and "Send to my computer" below
1024 px, where the header also swaps: phones and tablets run no extensions. Both are in the page,
so it reads right without JavaScript; CSS shows one. `free` adds ", free" to the label, and
`caption` adds the browsers line under the phone button. StoreNote says the rest, in the line under.
-->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { install } from '#lib/install.svelte.ts';
	import SendToComputer from './SendToComputer.svelte';

	let {
		free = false,
		variant = 'primary',
		size = 'xxl',
		block = true,
		caption = false
	}: { free?: boolean; variant?: 'primary' | 'secondary'; size?: 'xl' | 'xxl'; block?: boolean; caption?: boolean } = $props();
</script>

<span class="desk">
	<Button {variant} {size} {block} href={install.store.href}>{install.store.label}{free ? ', free' : ''}</Button>
</span>
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
