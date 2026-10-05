<!--
@component SiteHeader: sticky, 64 tall on paper at 88% with a blur, over a hairline that is always
there. The mark and wordmark, four quiet links, Account and Add to Chrome. Below 1024 px it is 56
tall with a Menu button that opens a full-height sheet: native <dialog>, so focus stays inside,
Escape closes it and focus returns to Menu.
-->
<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import { ColanderMark } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import SendToComputer from './SendToComputer.svelte';

	/** The app title in place of the site navigation: the review or admin console. */
	let { app = '' }: { app?: string } = $props();

	const links = [
		{ href: '/definition', label: 'How it decides' },
		{ href: '/log', label: 'Decision log' },
		{ href: '/transparency', label: 'Transparency' },
		{ href: '/plans', label: 'Plans' }
	];

	let sheet = $state<HTMLDialogElement>();
	const current = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	const close = () => sheet?.close();
	afterNavigate(close);
</script>

<header class="site-header" class:app>
	<div class="cl-container bar">
		<a class="home" href="/"><ColanderMark size={24} /><span class="word">Colander</span></a>
		{#if app}<span class="app-title">{app}</span>{/if}

		{#if !app}
			<nav class="main" aria-label="Main">
				<ul>
					{#each links as l (l.href)}
						<li><a href={l.href} aria-current={current(l.href) ? 'page' : undefined}>{l.label}</a></li>
					{/each}
				</ul>
			</nav>
		{/if}

		<div class="end">
			<a class="account" href="/account" aria-current={current('/account') ? 'page' : undefined}>Account</a>
			{#if !app}<Button variant="primary" size="lg" href={PUBLIC_STORE_URL} class="install">Add to Chrome</Button>{/if}
			<button type="button" class="menu-btn" aria-haspopup="dialog" onclick={() => sheet?.showModal()}>
				<MenuIcon size={16} aria-hidden="true" />Menu
			</button>
		</div>
	</div>
</header>

<dialog class="sheet" bind:this={sheet} aria-label="Menu">
	<div class="cl-container sheet-bar">
		<a class="home" href="/" onclick={close}><ColanderMark size={24} /><span class="word">Colander</span></a>
		<button type="button" class="menu-btn" onclick={close}><X size={16} aria-hidden="true" />Close</button>
	</div>
	<nav class="cl-container sheet-nav" aria-label="Menu">
		<ul>
			{#each [...links, { href: '/account', label: 'Account' }] as l (l.href)}
				<li><a href={l.href} aria-current={current(l.href) ? 'page' : undefined} onclick={close}>{l.label}</a></li>
			{/each}
		</ul>
	</nav>
	<div class="cl-container sheet-foot">
		<SendToComputer onDone={close} />
	</div>
</dialog>

<style>
	.site-header {
		position: sticky;
		top: 0;
		z-index: 50;
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-paper);
	}
	@supports (backdrop-filter: blur(12px)) {
		.site-header {
			background: color-mix(in srgb, var(--cl-paper) 88%, transparent);
			backdrop-filter: blur(12px);
		}
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 24px;
		height: 63px;
	}
	.home {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 8px;
		color: var(--cl-text);
		text-decoration: none;
		border-radius: var(--cl-r-chip);
	}
	.word {
		font: 600 18px/24px var(--cl-font);
	}
	.app-title {
		padding-left: 16px;
		border-left: 1px solid var(--cl-border);
		color: var(--cl-text-muted);
		font: var(--cl-body-strong);
	}
	.app .bar {
		height: 55px;
	}
	.app .end {
		margin-left: auto;
	}
	.main {
		flex: 1;
	}
	.main ul {
		display: flex;
		justify-content: center;
		gap: 4px;
		list-style: none;
	}
	.main a,
	.account {
		position: relative;
		display: inline-flex;
		align-items: center;
		height: 32px;
		padding: 0 12px;
		border-radius: var(--cl-r-chip);
		color: var(--cl-text);
		font: var(--cl-body-strong);
		text-decoration: none;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.account {
		color: var(--cl-brand);
	}
	.main a:hover,
	.account:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	.main a[aria-current='page']::after,
	.account[aria-current='page']::after {
		content: '';
		position: absolute;
		right: 12px;
		bottom: -16px;
		left: 12px;
		height: 2px;
		background: var(--cl-brand);
	}
	.end {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		margin-left: auto;
	}
	.menu-btn {
		display: none;
		align-items: center;
		gap: 8px;
		height: 44px;
		min-width: 44px;
		margin-right: -12px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--cl-r-chip);
		background: transparent;
		color: var(--cl-text);
		font: var(--cl-body-strong);
		cursor: pointer;
	}
	/* The 44 px target reaches 12 px into the gutter, so its word stays on the grid next to the
	   wordmark; the hover tint is the quiet button's. */
	/* Menu and Close are the same quiet button: icon and word, a tint on hover, never an underline. */
	.menu-btn:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}

	.sheet {
		width: 100%;
		max-width: none;
		height: 100%;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: var(--cl-paper);
		color: var(--cl-text);
	}
	.sheet[open] {
		display: flex;
		flex-direction: column;
	}
	.sheet::backdrop {
		background: var(--cl-paper);
	}
	.sheet-bar {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		height: 56px;
		border-bottom: 1px solid var(--cl-border);
	}
	.sheet-bar .menu-btn {
		display: inline-flex;
	}
	.sheet-nav {
		flex: 1;
		padding-top: 8px;
	}
	.sheet-nav ul {
		list-style: none;
	}
	.sheet-nav a {
		display: flex;
		align-items: center;
		min-height: 48px;
		border-bottom: 1px solid var(--cl-border);
		color: var(--cl-text);
		font: var(--cl-body-lg);
		font-weight: 600;
		text-decoration: none;
	}
	.sheet-nav a[aria-current='page'] {
		color: var(--cl-brand);
	}
	.sheet-foot {
		flex: none;
		padding-block: 16px 24px;
	}

	@media (max-width: 1023px) {
		.bar {
			height: 55px;
		}
		.main,
		.account,
		.end :global(.install) {
			display: none;
		}
		.menu-btn {
			display: inline-flex;
		}
	}
	@media (max-width: 399px) {
		.app-title {
			display: none;
		}
	}
	@media (min-width: 1024px) {
		.sheet[open] {
			display: none;
		}
	}
	/* Forced colors drop backgrounds, so the current page's underline uses Highlight. */
	@media (forced-colors: active) {
		.main a[aria-current='page']::after,
		.account[aria-current='page']::after {
			background: Highlight;
			forced-color-adjust: none;
		}
	}
</style>
