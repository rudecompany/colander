<!--
The admin console on the admin host (admin.getcolander.com): Cloudflare Access with the staff
identity in front, staff and admin authority inside. The tabs lead to the review queue with full
authority, people and roles, and for admins the audit log.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import AuthCard from '#lib/components/AuthCard.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import { admin, loadMe, may } from '#lib/admin.svelte.ts';

	let { children } = $props();
	onMount(loadMe);

	const tabs = $derived([
		{ href: '/admin', label: 'Review' },
		{ href: '/admin/people', label: 'People' },
		...(may('audit.read') ? [{ href: '/admin/audit', label: 'Audit log' }] : [])
	]);
	const current = (href: string) => (href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href));
</script>

<svelte:head>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if admin.status === 'loading'}
	<AuthCard eyebrow="Admin console" title="Admin console"><Loading label="Checking your staff identity" /></AuthCard>
{:else if admin.status === 'error'}
	<AuthCard eyebrow="Admin console" title={admin.code === 'not_staff' ? 'Not a staff account' : 'Sign in through Access'}>
		<div class="gate">
			<p class="cl-title icon-line"><ShieldAlert size={16} aria-hidden="true" />{admin.message}</p>
			<p class="cl-muted">
				{admin.code === 'not_staff'
					? 'The admin console is for Colander staff. Curators review on the main site.'
					: 'The admin console opens after Cloudflare Access checks your staff identity and security key.'}
			</p>
			<a href="https://getcolander.com/console">Open the review console for curators</a>
		</div>
	</AuthCard>
{:else}
	<nav class="cl-container admin-nav" aria-label="Admin console">
		<ul>
			{#each tabs as t (t.href)}
				<li><a href={t.href} aria-current={current(t.href) ? 'page' : undefined}>{t.label}</a></li>
			{/each}
		</ul>
		<p class="cl-caption cl-muted">
			{admin.me?.account.email} · {admin.me?.authority === 'admin' ? 'Admin' : 'Staff'}
		</p>
	</nav>
	{@render children()}
{/if}

<style>
	.gate {
		display: grid;
		gap: 12px;
	}
	.admin-nav {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 24px;
		padding-top: 16px;
	}
	.admin-nav ul {
		display: flex;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.admin-nav a {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 12px;
		border-radius: var(--cl-r-chip);
		color: var(--cl-text-muted);
		font: var(--cl-body);
		font-weight: 600;
		text-decoration: none;
	}
	.admin-nav a:hover {
		color: var(--cl-text);
	}
	.admin-nav a[aria-current='page'] {
		background: var(--cl-brand-tint);
		color: var(--cl-text);
	}
	.admin-nav p {
		overflow-wrap: anywhere;
	}
</style>
