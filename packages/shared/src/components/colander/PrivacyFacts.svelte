<!--
@component PrivacyFacts: what leaves your device and what never does, from copy.ts. Both lists
use 6 px dot bullets, not checks and crosses. Side by side when there is room. `compact` lists
the headings only, for a summary that links to the full policy (the landing page).
-->
<script lang="ts">
	import { PRIVACY_HEADINGS, PRIVACY_LEAVES, PRIVACY_NEVER } from '../../copy';

	let { headingLevel = 3, compact = false }: { headingLevel?: 2 | 3 | 4; compact?: boolean } = $props();
</script>

<div class="facts">
	<section>
		<svelte:element this={`h${headingLevel}`} class="h">{PRIVACY_HEADINGS.leaves}</svelte:element>
		<ul>
			{#each PRIVACY_LEAVES as f (f.title)}
				<li><span class="t">{f.title}</span>{#if !compact}<span class="d">{f.detail}</span>{/if}</li>
			{/each}
		</ul>
	</section>
	<section>
		<svelte:element this={`h${headingLevel}`} class="h">{PRIVACY_HEADINGS.never}</svelte:element>
		<ul>
			{#each PRIVACY_NEVER as n (n)}<li><span class="t">{n}</span></li>{/each}
		</ul>
	</section>
</div>

<style>
	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
		gap: 32px;
	}
	.h {
		margin: 0 0 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	ul {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		position: relative;
		display: grid;
		gap: 2px;
		padding-left: 18px;
	}
	li::before {
		content: '';
		position: absolute;
		top: 7px;
		left: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
	.t {
		font: var(--cl-body-strong);
	}
	.d {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
</style>
