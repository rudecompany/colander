<!--
@component SiteFooter: the footer CTA (except on /s, /appeal, /console and /account), a
perforation row, four link columns and a bottom row with the mark, the live list badge and the
cookie line. Support links never appear on source or appeal pages: no creator is asked for money
while their case is open.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import { ColanderMark, LiveBadge, PerforationRow } from '@colander/shared';
	import { live } from '#lib/live.svelte.ts';
	import ArrowLink from './ArrowLink.svelte';
	import InstallButton from './InstallButton.svelte';

	const path = $derived(page.url.pathname);
	const creatorPage = $derived(/^\/(s|appeal)(\/|$)/.test(path));
	const cta = $derived(!creatorPage && !/^\/(console|account)(\/|$)/.test(path));

	const columns = $derived([
		{
			title: 'Product',
			links: [
				{ href: PUBLIC_STORE_URL, label: 'Add to Chrome' },
				{ href: '/definition', label: 'How it decides' },
				{ href: '/plans', label: 'Plans' },
				...(creatorPage ? [] : [{ href: '/support', label: 'Support our work' }])
			]
		},
		{
			title: 'Openness',
			links: [
				{ href: '/log', label: 'Decision log' },
				{ href: '/transparency', label: 'Transparency' },
				...(creatorPage ? [] : [{ href: '/supporters', label: 'Supporters' }])
			]
		},
		{
			title: 'Help',
			links: [
				{ href: '/definition#appeals', label: 'Appeal a verdict' },
				{ href: '/account', label: 'Account' },
				{ href: '/privacy#contact', label: 'Contact' }
			]
		},
		{
			title: 'Legal',
			links: [
				{ href: '/privacy', label: 'Privacy' },
				{ href: '/terms', label: 'Terms' },
				{ href: '/credits', label: 'Credits' }
			]
		}
	]);
</script>

<footer class="site-footer">
	{#if cta}
		<section class="cta" aria-labelledby="footer-cta">
			<PerforationRow />
			<div class="cl-container cta-in">
				<h2 class="cl-display-lg" id="footer-cta">Install once. <span class="cl-tone2">Change nothing.</span></h2>
				<div class="cta-btn"><InstallButton label="Add to Chrome, free" block={false} /></div>
				<p class="cl-figure small">Chrome on desktop. Also works in Edge and Brave. No account needed.</p>
			</div>
		</section>
	{/if}
	<PerforationRow />
	<div class="cl-container cols">
		{#each columns as c (c.title)}
			<nav aria-labelledby="foot-{c.title}">
				<h2 id="foot-{c.title}">{c.title}</h2>
				<ul>
					{#each c.links as l (l.label)}<li><a href={l.href}>{l.label}</a></li>{/each}
				</ul>
			</nav>
		{/each}
	</div>
	<div class="cl-container">
		<div class="base">
			<span class="brand"><ColanderMark size={20} /><span class="word">Colander</span></span>
			<LiveBadge sequence={live.stats?.list_sequence} updatedAt={live.stats?.list_updated_at} now={live.now ?? undefined} />
			<span class="note">No cookies, so no banner.</span>
			<span class="who"><ArrowLink href="/transparency" size="sm">Who runs Colander and how it is funded</ArrowLink></span>
		</div>
	</div>
</footer>

<style>
	.site-footer {
		margin-top: auto;
		background: var(--cl-paper);
	}
	.cta-in {
		display: grid;
		justify-items: center;
		gap: 24px;
		padding-block: var(--cl-s8);
		text-align: center;
	}
	.cta h2 {
		max-width: none;
	}
	.small {
		color: var(--cl-text-muted);
	}
	/* Below 1024 the button sends the link: 360 wide on tablets, full width on phones. */
	@media (max-width: 1023px) {
		.cta-btn {
			width: min(100%, 360px);
		}
	}
	.cols {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 24px;
		padding-block: var(--cl-s6) var(--cl-s5);
	}
	nav h2 {
		margin-bottom: 12px;
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	nav ul {
		display: grid;
		gap: 4px;
		list-style: none;
	}
	nav a {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		color: var(--cl-text);
		font: var(--cl-body);
		text-decoration: none;
	}
	nav a:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.base {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 24px;
		padding-block: 20px 32px;
		border-top: 1px solid var(--cl-border);
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--cl-text);
	}
	.word {
		font: var(--cl-body-strong);
	}
	.who {
		margin-left: auto;
	}
	@media (max-width: 1023px) {
		.who {
			margin-left: 0;
		}
	}
	@media (max-width: 639px) {
		.cta-in {
			justify-items: stretch;
			padding-block: var(--cl-s7);
		}
		.cta-btn {
			width: 100%;
		}
		.cols {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			row-gap: 32px;
		}
		.base {
			flex-direction: column;
			align-items: flex-start;
			gap: 12px;
		}
	}
</style>
