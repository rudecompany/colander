<!-- @component Privacy: what leaves the device, and what never does. -->
<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';

	const LEAVES = [
		['List downloads', 'The core list and its updates, fetched with no identifier at all.'],
		['Adapter updates', 'Signed selector updates for the four platforms, also with no identifier.'],
		['Tags you choose to send', 'Platform, the item or source ID, your choice, optional type and tests, whether the platform showed an AI label, the time, the extension version and a random install ID.'],
		['Reports you choose to send', 'The source, up to three example items, your reason, optional type and tests, and the install ID.'],
		['Plus, if you use it', 'Your plan token to start a trial, renew, and sync settings across browsers.'],
		['Review, for curators', 'Decisions you make in the side panel, with your reviewer token.']
	];
	const NEVER = ['The pages you visit or their addresses', 'What you watch, read or scroll past', 'Your account names on YouTube, TikTok, Instagram or Facebook', 'Anything about items Colander hides for you'];
</script>

<Section id="privacy" title="Privacy" description="Matching happens on this device. Colander never asks a server about the page you are viewing.">
	<Card title="What leaves this device">
		<ul class="list">
			{#each LEAVES as [title, detail] (title)}
				<li><Check size={16} strokeWidth={1.75} class="yes" /><div><p class="strong">{title}</p><p class="muted t-caption">{detail}</p></div></li>
			{/each}
		</ul>
	</Card>
	<Card title="What never does">
		<ul class="list">
			{#each NEVER as n (n)}
				<li><X size={16} strokeWidth={1.75} class="no" /><p>{n}</p></li>
			{/each}
		</ul>
	</Card>
	<p class="muted t-caption">The install ID is 16 random bytes made on this device. The server stores only a hash of it. Delete local data to replace it.</p>
</Section>

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.list li {
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}
	.list :global(svg) {
		margin-top: 2px;
	}
	.list :global(.yes) {
		color: var(--cl-clear);
	}
	.list :global(.no) {
		color: var(--cl-text-muted);
	}
	.strong {
		font-weight: 600;
	}
</style>
