<script lang="ts">
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { ColanderMark } from '@colander/shared';
	import PerforatedDisc from '#lib/components/PerforatedDisc.svelte';

	const missing = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{missing ? 'Page not found' : 'Something went wrong'} · Colander</title>
</svelte:head>

<div class="wrap">
	<section class="lost">
		<div class="art" aria-hidden="true">
			<PerforatedDisc size={360} rings={6} class="lost-disc" />
			<span class="mark"><ColanderMark size={64} /></span>
		</div>
		<div class="copy">
			<p class="eyebrow">{missing ? 'Error 404' : `Error ${page.status}`}</p>
			<h1 class="t-display">{missing ? 'This page went through the holes' : 'Something went wrong on our side'}</h1>
			<p class="t-lede">
				{missing
					? 'The address may be mistyped, or the page may have moved. Nothing you did caused this.'
					: 'Please try again in a moment. If it keeps happening, the decision log and source pages may be catching up.'}
			</p>
			<div class="links">
				<a class="uin-btn uin-btn-primary btn-lg" href="/"><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /> Back to the start</a>
				<a class="uin-btn uin-btn-outline btn-lg" href="/log">Open the decision log</a>
			</div>
		</div>
	</section>
</div>

<style>
	.lost {
		display: grid;
		grid-template-columns: 360px minmax(0, 1fr);
		gap: 64px;
		align-items: center;
		padding-block: 96px 32px;
	}
	.art {
		position: relative;
		display: grid;
		place-items: center;
	}
	.mark {
		position: absolute;
		display: grid;
		place-items: center;
		width: 112px;
		height: 112px;
		border-radius: 50%;
		background: var(--cl-paper);
		color: var(--cl-text);
	}
	.copy {
		display: grid;
		gap: var(--cl-s4);
		max-width: 560px;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s3);
		margin-top: var(--cl-s2);
	}
	@media (max-width: 760px) {
		.lost {
			grid-template-columns: 1fr;
			gap: var(--cl-s5);
			padding-top: var(--cl-s6);
		}
		.art :global(.lost-disc) {
			width: 240px;
			height: 240px;
		}
	}
</style>
