<!--
@component The options page: a calm left nav and one section at a time, addressed by the URL hash
so the popup and in-page notices can link straight to a section (#reports, #platforms).
-->
<script lang="ts">
	import { ColanderMark } from '@colander/shared';
	import Heart from '@lucide/svelte/icons/heart';
	import List from '@lucide/svelte/icons/list';
	import Globe from '@lucide/svelte/icons/globe';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import BadgePlus from '@lucide/svelte/icons/badge-plus';
	import Type from '@lucide/svelte/icons/type';
	import Wallet from '@lucide/svelte/icons/wallet';
	import Flag from '@lucide/svelte/icons/flag';
	import Database from '@lucide/svelte/icons/database';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import type { Component } from 'svelte';
	import { SITE } from '../../lib/env';
	import { DEFAULT_STATUS, K, type Status } from '../../lib/settings';
	import { stored } from '../../ui/store.svelte';
	import Lists from './Lists.svelte';
	import Platforms from './Platforms.svelte';
	import Strictness from './Strictness.svelte';
	import Plus from './Plus.svelte';
	import Appearance from './Appearance.svelte';
	import Plan from './Plan.svelte';
	import Reports from './Reports.svelte';
	import Data from './Data.svelte';
	import Privacy from './Privacy.svelte';

	const SECTIONS: { id: string; label: string; icon: Component<{ size?: number; strokeWidth?: number }>; view: Component }[] = [
		{ id: 'lists', label: 'Lists', icon: List, view: Lists },
		{ id: 'platforms', label: 'Platforms', icon: Globe, view: Platforms },
		{ id: 'strictness', label: 'Strictness', icon: SlidersHorizontal, view: Strictness },
		{ id: 'plus', label: 'Plus', icon: BadgePlus, view: Plus },
		{ id: 'appearance', label: 'Appearance', icon: Type, view: Appearance },
		{ id: 'plan', label: 'Plan', icon: Wallet, view: Plan },
		{ id: 'reports', label: 'My reports', icon: Flag, view: Reports },
		{ id: 'data', label: 'Data', icon: Database, view: Data },
		{ id: 'privacy', label: 'Privacy', icon: ShieldCheck, view: Privacy }
	];

	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const current = () => SECTIONS.find((s) => s.id === location.hash.slice(1)) ?? SECTIONS[0]!;
	let active = $state(current());
	addEventListener('hashchange', () => {
		active = current();
		document.querySelector<HTMLElement>('#main')?.focus();
	});
	$effect(() => {
		document.title = `${active.label} · Colander`;
	});
</script>

<div class="shell">
	<nav class="nav" aria-label="Options">
		<a class="brand" href="#lists" aria-label="Colander options">
			<ColanderMark size={28} />
			<span>Colander</span>
		</a>
		<ul>
			{#each SECTIONS as s (s.id)}
				<li>
					<a href="#{s.id}" class:active={active.id === s.id} aria-current={active.id === s.id ? 'page' : undefined}>
						<s.icon size={16} strokeWidth={1.75} />
						<span>{s.label}</span>
						{#if s.id === 'reports' && (status.value.reportsUpdated || status.value.reportsClosed)}<span class="dot" aria-label="Updated"></span>{/if}
					</a>
				</li>
			{/each}
		</ul>
		<a class="support" href="{SITE}/support" target="_blank" rel="noopener"><Heart size={16} strokeWidth={1.75} />Support our work</a>
	</nav>
	<main id="main" tabindex="-1">
		{#key active.id}
			<active.view />
		{/key}
	</main>
</div>

<style>
	:global(body) {
		background: var(--cl-paper);
	}
	.shell {
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
		min-height: 100vh;
	}
	.nav {
		position: sticky;
		top: 0;
		display: flex;
		flex-direction: column;
		gap: 24px;
		height: 100vh;
		padding: 24px 16px;
		border-right: 1px solid var(--cl-border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 8px;
		color: var(--cl-text);
		text-decoration: none;
		font: var(--cl-title);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	ul a,
	.support {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 36px;
		padding: 0 12px;
		border-radius: var(--cl-r-chip);
		color: var(--cl-text-muted);
		text-decoration: none;
		transition: background-color var(--cl-fast) var(--cl-ease), color var(--cl-fast) var(--cl-ease);
	}
	ul a:hover,
	.support:hover {
		background: var(--uin-mat-hover);
		color: var(--cl-text);
	}
	ul a.active {
		background: var(--cl-surface);
		color: var(--cl-text);
		font-weight: 600;
		box-shadow: inset 0 0 0 1px var(--cl-border);
	}
	.dot {
		width: 8px;
		height: 8px;
		margin-left: auto;
		border-radius: 50%;
		background: var(--cl-brand);
	}
	.support {
		margin-top: auto;
	}
	main {
		width: 100%;
		max-width: 784px;
		padding: 48px 32px 64px;
		outline: none;
	}
	@media (max-width: 720px) {
		.shell {
			grid-template-columns: 1fr;
		}
		.nav {
			position: static;
			height: auto;
			border-right: 0;
			border-bottom: 1px solid var(--cl-border);
		}
		ul {
			flex-direction: row;
			flex-wrap: wrap;
		}
		.support {
			margin-top: 0;
		}
	}
</style>
