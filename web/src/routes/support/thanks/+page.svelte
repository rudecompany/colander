<script lang="ts">
	import Users from '@lucide/svelte/icons/users';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { PageHeader } from '@colander/shared';
</script>

<svelte:head>
	<title>Thank you · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
	eyebrow="Support our work"
	title="Thank you for your support"
	lede="Your gift pays for the people who review reports and appeals, the upkeep that keeps four platforms working, and the servers that sign the lists."
/>
</div>

<div class="cl-container page-body">
	<section class="uin-card uin-card-lg uin-card-pad section-card" aria-labelledby="next-title">
		<h2 class="cl-title" id="next-title">What happens now</h2>
		<ul class="steps">
			<li>Our payment provider emails you a receipt.</li>
			<li>If you gave a name for credit, it appears on the supporters page within a minute or two. We never publish amounts.</li>
			<li>To change or stop a monthly donation, write to the support address on your receipt.</li>
			<li>Giving never changes tag weight, review priority or any verdict.</li>
		</ul>
		<p class="row">
			<Button variant="primary" size="xl" href="/supporters"><Users size={16} aria-hidden="true" />See the supporters page</Button>
			<Button variant="quiet" size="xl" href="/transparency">Where the money goes</Button>
		</p>
	</section>
</div>

<style>
	.section-card {
		display: grid;
		gap: var(--cl-s3);
		max-width: 720px;
	}
	.steps {
		display: grid;
		gap: var(--cl-s2);
		padding-left: var(--cl-s5);
		font: var(--cl-body-lg);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
		margin-top: var(--cl-s2);
	}
</style>
