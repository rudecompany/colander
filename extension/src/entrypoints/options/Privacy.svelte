<!--
@component Privacy: what leaves the device, what never does, why each permission is asked, and the
about text on where the list comes from, which points to the website's credits page. It names no
dataset: only /credits does.
-->
<script lang="ts">
	import { PageHeader, PermissionsTable, PrivacyFacts } from '@colander/shared';
	import { ABOUT_DATA, PRIVACY_INSTALL_ID } from '@colander/shared/copy';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { SITE } from '../../lib/env';
</script>

<PageHeader variant="app" eyebrow="Options" title="Privacy" lede="Matching happens on this device. Colander never asks a server about the page you are viewing." />

<div class="cards">
	<Card><PrivacyFacts headingLevel={2} /></Card>
	<section aria-labelledby="perm-title">
		<h2 id="perm-title" class="h">Permissions</h2>
		<PermissionsTable />
	</section>
	<p class="caption">{PRIVACY_INSTALL_ID}</p>
	<section aria-labelledby="about-data" class="about">
		<h2 id="about-data" class="h">{ABOUT_DATA.title}</h2>
		<p>{ABOUT_DATA.body} {ABOUT_DATA.credits}</p>
		<a class="cl-link" href="{SITE}/credits" target="_blank" rel="noopener">Credits<ArrowRight size={16} aria-hidden="true" /></a>
	</section>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.h {
		margin-bottom: 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.caption {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.about {
		display: grid;
		justify-items: start;
		gap: 8px;
		font: var(--cl-body);
	}
	.about .h {
		margin-bottom: 4px;
	}
</style>
