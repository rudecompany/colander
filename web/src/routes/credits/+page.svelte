<script lang="ts">
	import { PageHeader, PerforatedDisc } from '@colander/shared';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ArrowLink from '#lib/components/ArrowLink.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Credits · Colander</title>
	<meta name="description" content="The openly licensed datasets Colander uses whose license asks for credit, with the exact credit each one asks for." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Credits"
		title="Credit where it is due."
		lede="Some openly licensed lists from other projects help Colander's staff choose which sources to review first. They never decide a verdict. This page names the ones whose license asks for credit, with the credit each one asks for."
	/>
</div>

<div class="cl-container page-body body">
	<section aria-labelledby="datasets-title" class="block">
		<h2 class="cl-title" id="datasets-title">Datasets</h2>
		{#if data.credits.length === 0}
			<div class="empty uin-card uin-card-lg uin-card-pad">
				<PerforatedDisc size={96} mark={40} />
				<div class="empty-text">
					<p class="cl-title">No dataset needs credit yet.</p>
					<p class="cl-muted">When Colander uses a dataset whose license asks for credit, it is named here first.</p>
				</div>
			</div>
		{:else}
			<ul class="credits">
				{#each data.credits as c (c.name)}
					<li class="credit uin-card uin-card-lg uin-card-pad">
						<h3 class="cl-title name">
							<a class="icon-line" href={c.homepage} rel="noreferrer" target="_blank">{c.name}<ExternalLink size={16} aria-hidden="true" /></a>
						</h3>
						<p class="cl-figure license">
							{#if c.license_url}<a href={c.license_url} rel="noreferrer" target="_blank">{c.license}</a>{:else}{c.license}{/if}
						</p>
						<blockquote class="attribution">{c.attribution}</blockquote>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section aria-labelledby="changes-title" class="block">
		<h2 class="cl-title" id="changes-title">What Colander changes</h2>
		<p class="text">
			Colander reads each list into platform IDs and leaves out entries it cannot read. Every entry is only a lead: staff look at the source
			itself and decide under Colander's own rules. These changes are Colander's, not the maintainers', and the data keeps its own license.
		</p>
		<ArrowLink href="/privacy#creators">What Colander keeps about creators</ArrowLink>
	</section>
</div>

<style>
	.body {
		display: grid;
		gap: var(--cl-s8);
	}
	.block {
		display: grid;
		gap: var(--cl-s4);
		align-content: start;
	}
	.text {
		max-width: 680px;
		font: var(--cl-body-lg);
	}
	.empty {
		display: flex;
		align-items: center;
		gap: var(--cl-s5);
		max-width: 680px;
	}
	.empty-text {
		display: grid;
		gap: var(--cl-s1);
	}
	.credits {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--cl-s4);
		list-style: none;
	}
	.credit {
		display: grid;
		gap: var(--cl-s2);
		align-content: start;
		min-width: 0;
	}
	.name a {
		color: var(--cl-text);
		overflow-wrap: anywhere;
	}
	.license {
		color: var(--cl-text-muted);
	}
	.attribution {
		margin: var(--cl-s2) 0 0;
		padding-left: var(--cl-s3);
		border-left: 2px solid var(--cl-border-strong);
		font: var(--cl-body);
		overflow-wrap: anywhere;
	}
	@media (max-width: 799px) {
		.credits {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 479px) {
		.empty {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
