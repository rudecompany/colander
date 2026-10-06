<!-- The review queue on the admin host, with the staff member's full authority. -->
<script lang="ts">
	import Console from '#lib/components/console/Console.svelte';
	import { admin } from '#lib/admin.svelte.ts';
</script>

<svelte:head>
	<title>Admin console · Colander</title>
</svelte:head>

{#if admin.me}
	<Console authority={admin.me.authority} name={admin.me.account.display_name} />
{/if}
