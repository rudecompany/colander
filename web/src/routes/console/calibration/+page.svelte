<!--
The calibration set on getcolander.com: curator authority at most, behind the same passkey gate
as the review console. Staff settle labels that disagree on the admin host.
-->
<script lang="ts">
	import Calibration from '#lib/components/console/Calibration.svelte';
	import ReviewGate from '#lib/components/console/ReviewGate.svelte';
</script>

<svelte:head>
	<title>Calibration · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<ReviewGate
	title="Calibration"
	signInTitle="Sign in to label"
	signInLede="The calibration set is for curators and staff."
	next="/console/calibration"
	staffNote="Third labels where two labels disagree"
>
	{#snippet children(account)}
		<Calibration authority="curator" name={account.display_name} queueHref="/console" />
	{/snippet}
</ReviewGate>
