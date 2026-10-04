<script lang="ts">
	import { PageHeader } from '@colander/shared';

	const toc = [
		['what', 'What Colander is'],
		['opinions', 'Verdicts are opinions'],
		['fair', 'Using it fairly'],
		['plans', 'Plans and refunds'],
		['warranty', 'No warranty'],
		['changes', 'Changes']
	] as const;
</script>

<svelte:head>
	<title>Terms · Colander</title>
	<meta name="description" content="The short, plain terms for using Colander." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader eyebrow="Terms" title="Short, plain terms." title2="Written to be read." lede="Using Colander means agreeing to these terms." />
</div>

{#snippet tocList()}
	<ol>
		{#each toc as [id, label] (id)}<li><a href="#{id}">{label}</a></li>{/each}
	</ol>
{/snippet}

<div class="cl-container page-body longform">
	<nav class="toc" aria-label="On this page">
		<p class="toc-title">On this page</p>
		{@render tocList()}
	</nav>
	<article class="prose doc">
		<details class="toc-mobile">
			<summary>On this page</summary>
			{@render tocList()}
		</details>
		<section id="what">
			<h2>What Colander is</h2>
			<p>
				Colander is a browser extension that hides or labels content on your own device, based on shared lists
				and your own settings. It does not act on your accounts, and everything it hides stays on the platform for everyone else.
			</p>
		</section>
		<section id="opinions">
			<h2>Verdicts are opinions</h2>
			<p>
				A verdict describes content against the <a href="/definition">published definition</a>. It is an opinion based on
				the evidence shown on each source page, not a statement of fact about any person. Labels never describe people.
				If you think a verdict is wrong, tag it Not slop, or appeal it if the source is yours.
			</p>
		</section>
		<section id="fair">
			<h2>Using it fairly</h2>
			<ul class="dots-list">
				<li>Tag and report honestly. Coordinated tagging to target a creator is against these terms.</li>
				<li>Do not try to disrupt the service, the lists or other people's use of them.</li>
				<li>Appeal only for accounts you control.</li>
			</ul>
			<p>We may lower the weight of, or ignore, tags from installs that break these rules.</p>
		</section>
		<section id="plans">
			<h2>Plans and refunds</h2>
			<ul class="dots-list">
				<li>Blocking is free and stays free. Plus adds convenience features.</li>
				<li>You can cancel in one click on your account page. Plus stays on until the end of the period you paid for.</li>
				<li>If you were charged in the last 30 days, you can cancel and get that charge refunded.</li>
				<li>Paying or donating never changes a verdict, tag weight or review order.</li>
			</ul>
		</section>
		<section id="warranty">
			<h2>No warranty</h2>
			<p>
				Colander is provided as is. We work hard to avoid wrong calls and to fix them fast, but we cannot promise the lists
				are complete or free of mistakes. To the extent the law allows, we are not liable for what you see or do not see
				because of it.
			</p>
		</section>
		<section id="changes">
			<h2>Changes</h2>
			<p>If these terms change, we will update this page and note the date. Version 1, October 2026.</p>
		</section>
	</article>
</div>

<style>
	.doc > section + section {
		margin-top: var(--cl-s7);
		padding-top: var(--cl-s7);
		border-top: 1px solid var(--cl-border);
	}
	.doc > section > :global(* + *) {
		margin-top: var(--cl-s4);
	}
	.prose .dots-list {
		padding-left: 0;
	}
</style>
