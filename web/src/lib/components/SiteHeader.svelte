<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import Menu from '@lucide/svelte/icons/menu';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Wordmark from './Wordmark.svelte';

	const links = [
		{ href: '/definition', label: 'How it decides' },
		{ href: '/log', label: 'Decision log' },
		{ href: '/plans', label: 'Plans' },
		{ href: '/transparency', label: 'Transparency' }
	];

	let open = $state(false);
	afterNavigate(() => (open = false));

	const wide = $derived(page.url.pathname.startsWith('/console'));
	const current = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(href + '/');
</script>

<header class="site-header">
	<div class="wrap bar" class:wrap-wide={wide}>
		<a class="home" href="/" aria-label="Colander, home"><Wordmark /></a>

		<nav class="nav-main" aria-label="Main">
			<ul>
				{#each links as l (l.href)}
					<li><a href={l.href} aria-current={current(l.href) ? 'page' : undefined}>{l.label}</a></li>
				{/each}
			</ul>
		</nav>

		<div class="actions">
			<a class="account" href="/account" aria-current={current('/account') ? 'page' : undefined}>
				<UserRound size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>Account</span>
			</a>
			<a class="uin-btn uin-btn-primary uin-btn-md install" href={PUBLIC_STORE_URL}>
				<Plus size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>Add to Chrome</span>
			</a>
			<button
				type="button"
				class="uin-btn uin-btn-outline uin-btn-md menu-btn"
				aria-expanded={open}
				aria-controls="site-menu"
				onclick={() => (open = !open)}
			>
				{#if open}<X size={16} strokeWidth={1.75} aria-hidden="true" />{:else}<Menu size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
				<span>Menu</span>
			</button>
		</div>
	</div>

	{#if open}
		<nav id="site-menu" class="menu wrap" aria-label="Menu">
			<ul>
				{#each links as l (l.href)}
					<li><a href={l.href} aria-current={current(l.href) ? 'page' : undefined}>{l.label}</a></li>
				{/each}
				<li><a href="/account" aria-current={current('/account') ? 'page' : undefined}>Account</a></li>
			</ul>
			<a class="uin-btn uin-btn-primary btn-lg menu-install" href={PUBLIC_STORE_URL}>
				<Plus size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>Add to Chrome</span>
			</a>
		</nav>
	{/if}
</header>

<style>
	.site-header {
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-paper);
	}
	.bar {
		display: flex;
		align-items: center;
		gap: var(--cl-s5);
		height: 72px;
	}
	.home {
		text-decoration: none;
		border-radius: var(--cl-r-chip);
		flex: none;
	}
	.nav-main {
		flex: 1;
	}
	.nav-main ul {
		display: flex;
		list-style: none;
		gap: var(--cl-s1);
	}
	.nav-main a,
	.account {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 10px;
		border-radius: var(--cl-r-chip);
		color: var(--cl-text);
		text-decoration: none;
		font: 600 14px/20px var(--cl-font);
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.nav-main a:hover,
	.account:hover {
		background: var(--w-ink-soft);
	}
	.nav-main a[aria-current='page'],
	.account[aria-current='page'] {
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 8px;
		text-decoration-color: var(--cl-text);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: var(--cl-s2);
		margin-left: auto;
	}
	.menu-btn {
		display: none;
	}
	.menu {
		padding-bottom: var(--cl-s5);
	}
	.menu ul {
		list-style: none;
		border-top: 1px solid var(--cl-border);
		margin-bottom: var(--cl-s4);
	}
	.menu li a {
		display: flex;
		align-items: center;
		min-height: 48px;
		border-bottom: 1px solid var(--cl-border);
		color: var(--cl-text);
		text-decoration: none;
		font: 600 16px/24px var(--cl-font);
	}
	.menu li a[aria-current='page'] {
		color: var(--cl-brand);
	}
	.menu-install {
		width: 100%;
	}

	@media (max-width: 960px) {
		.nav-main,
		.account {
			display: none;
		}
		.menu-btn {
			display: inline-flex;
		}
	}
	@media (max-width: 520px) {
		.install {
			display: none;
		}
		.bar {
			height: 64px;
		}
	}
</style>
