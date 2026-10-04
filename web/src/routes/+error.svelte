<script lang="ts">
	import { page } from '$app/state';
	import { PerforatedDisc } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';

	const missing = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{missing ? 'Page not found' : 'Something went wrong'} · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="cl-container">
	<section class="lost">
		<PerforatedDisc size={360} mark={160} class="disc" />
		<div class="copy">
			<p class="cl-eyebrow">{missing ? 'Error 404' : `Error ${page.status}`}</p>
			<h1 class="cl-display-lg">{missing ? 'This page went through the holes' : 'Something went wrong on our side'}</h1>
			<p class="cl-lead lede">
				{missing
					? 'The address may be mistyped, or the page may have moved. Nothing you did caused this.'
					: 'Please try again in a moment. Nothing you did caused this.'}
			</p>
			<div class="links">
				<Button variant="primary" size="xl" href="/">Go to the home page</Button>
				<Button variant="secondary" size="xl" href="/log">Open the decision log</Button>
			</div>
		</div>
	</section>
</div>

<style>
	.lost {
		display: grid;
		grid-template-columns: 360px minmax(0, 1fr);
		gap: var(--cl-s8);
		align-items: center;
		padding-block: var(--cl-s9);
	}
	.copy {
		display: grid;
		justify-items: start;
		gap: 16px;
		max-width: 560px;
	}
	.lede {
		color: var(--cl-text-muted);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-top: 8px;
	}
	@media (max-width: 1023px) {
		.lost {
			grid-template-columns: 1fr;
			gap: var(--cl-s6);
			padding-block: var(--cl-s7) var(--cl-s8);
		}
		.lost :global(.disc) {
			width: 240px !important;
			height: 240px !important;
		}
		.lost :global(.disc svg) {
			width: 240px;
			height: 240px;
		}
		.lost :global(.disc .cl-mark) {
			width: 112px;
			height: 112px;
		}
	}
</style>
