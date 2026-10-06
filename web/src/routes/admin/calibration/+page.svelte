<!-- The calibration set on the admin host: staff authority, so items whose two labels disagree come too. -->
<script lang="ts">
	import Calibration from '#lib/components/console/Calibration.svelte';
	import { admin } from '#lib/admin.svelte.ts';
</script>

<svelte:head>
	<title>Calibration · Admin console · Colander</title>
</svelte:head>

{#if admin.me}
	<Calibration authority={admin.me.authority} name={admin.me.account.display_name} />
{/if}
