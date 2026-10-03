<script lang="ts">
	import Users from '@lucide/svelte/icons/users';
	import PageHead from '#lib/components/PageHead.svelte';
</script>

<svelte:head>
	<title>Thank you · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<PageHead
	eyebrow="Support our work"
	title="Thank you for your support"
	lede="Your gift pays for the people who review reports and appeals, the upkeep that keeps four platforms working, and the servers that sign the lists."
	narrow
/>

<div class="wrap wrap-narrow page">
	<section class="card section-card" aria-labelledby="next-title">
		<h2 class="t-title" id="next-title">What happens now</h2>
		<ul class="steps">
			<li>Our payment provider emails you a receipt.</li>
			<li>If you gave a name for credit, it appears on the supporters page within a minute or two. We never publish amounts.</li>
			<li>To change or stop a monthly donation, write to the support address on your receipt.</li>
			<li>Giving never changes tag weight, review priority or any verdict.</li>
		</ul>
		<p class="row">
			<a class="uin-btn uin-btn-primary uin-btn-md" href="/supporters"><Users size={16} strokeWidth={1.75} aria-hidden="true" /> See the supporters page</a>
			<a class="uin-btn uin-btn-ghost uin-btn-md" href="/transparency">Where the money goes</a>
		</p>
	</section>
</div>

<style>
	.page {
		padding-top: var(--cl-s6);
	}
	.section-card {
		display: grid;
		gap: var(--cl-s3);
	}
	.steps {
		display: grid;
		gap: var(--cl-s2);
		padding-left: 20px;
		font: var(--cl-body);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
		margin-top: var(--cl-s2);
	}
</style>
