<!--
The review console on getcolander.com (docs/contracts.md 6.7): curator authority at most, for
curators, staff and admins who signed in with a passkey in the last 12 hours (ReviewGate). Staff
work on large sources, appeals and people happens in the admin console on the admin host.
-->
<script lang="ts">
	import Console from '#lib/components/console/Console.svelte';
	import ReviewGate from '#lib/components/console/ReviewGate.svelte';
</script>

<svelte:head>
	<title>Review console · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<ReviewGate
	title="Review console"
	signInTitle="Sign in to review"
	signInLede="The console is for curators and staff. Every decision you make here is published in the decision log."
	next="/console"
	staffNote="Large sources, appeals and people"
>
	{#snippet children(account)}
		<Console authority="curator" name={account.display_name} calibrationHref="/console/calibration" />
	{/snippet}
</ReviewGate>
