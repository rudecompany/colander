<!-- @component Privacy: what leaves the device, what never does, and why each permission is asked. -->
<script lang="ts">
	import { PageHeader, PermissionsTable, PrivacyFacts } from '@colander/shared';
	import { PRIVACY_INSTALL_ID } from '@colander/shared/copy';
	import Card from '@colander/shared/components/ui/card/card.svelte';
</script>

<PageHeader variant="app" eyebrow="Options" title="Privacy" lede="Matching happens on this device. Colander never asks a server about the page you are viewing." />

<div class="cards">
	<Card><PrivacyFacts headingLevel={2} /></Card>
	<section aria-labelledby="perm-title">
		<h2 id="perm-title" class="h">Permissions</h2>
		<PermissionsTable />
	</section>
	<p class="caption">{PRIVACY_INSTALL_ID}</p>
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
</style>
