<!--
@component Options: a sticky 232 px nav, one section at a time addressed by the URL hash (so the
popup and in-page notices can link to #reports or #platforms), and from 1200 px a 280 px rail
with the list status and links to the matching website pages; the content and rail center in
the room beside the nav. Lists shows the list status in its own Core list card, so the rail
leaves it out there. Below 800 px the nav becomes a Section select.
-->
<script lang="ts">
	import { ColanderMark } from '@colander/shared';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CreditCard from '@lucide/svelte/icons/credit-card';
	import Database from '@lucide/svelte/icons/database';
	import Eye from '@lucide/svelte/icons/eye';
	import Flag from '@lucide/svelte/icons/flag';
	import Heart from '@lucide/svelte/icons/heart';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import List from '@lucide/svelte/icons/list';
	import Lock from '@lucide/svelte/icons/lock';
	import Shield from '@lucide/svelte/icons/shield';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import type { Component } from 'svelte';
	import { SITE } from '../../lib/env';
	import { DEFAULT_STATUS, K, type Status } from '../../lib/settings';
	import ListStatus from '../../ui/ListStatus.svelte';
	import { stored } from '../../ui/store.svelte';
	import Appearance from './Appearance.svelte';
	import Data from './Data.svelte';
	import Lists from './Lists.svelte';
	import Plan from './Plan.svelte';
	import Platforms from './Platforms.svelte';
	import Plus from './Plus.svelte';
	import Privacy from './Privacy.svelte';
	import Reports from './Reports.svelte';
	import Strictness from './Strictness.svelte';

	type Section = { id: string; label: string; icon: Component<{ size?: number; 'aria-hidden'?: 'true' }>; view: Component; learn: [string, string][] };
	const SECTIONS: Section[] = [
		{ id: 'lists', label: 'Lists', icon: List, view: Lists, learn: [['How signing works', '/definition#signing'], ['Decision log', '/log']] },
		{ id: 'platforms', label: 'Platforms', icon: LayoutGrid, view: Platforms, learn: [['How it decides', '/definition']] },
		{ id: 'strictness', label: 'Strictness', icon: SlidersHorizontal, view: Strictness, learn: [['What each level does', '/definition#strictness']] },
		{ id: 'plus', label: 'Plus', icon: Lock, view: Plus, learn: [['Compare plans', '/plans']] },
		{ id: 'appearance', label: 'Appearance', icon: Eye, view: Appearance, learn: [['What the verdicts mean', '/definition']] },
		{ id: 'plan', label: 'Plan', icon: CreditCard, view: Plan, learn: [['Compare plans', '/plans'], ['Support our work', '/support']] },
		{ id: 'reports', label: 'My reports', icon: Flag, view: Reports, learn: [['Decision log', '/log'], ['How appeals work', '/definition#appeals']] },
		{ id: 'data', label: 'Data', icon: Database, view: Data, learn: [['Privacy policy', '/privacy']] },
		{ id: 'privacy', label: 'Privacy', icon: Shield, view: Privacy, learn: [['Privacy policy', '/privacy']] }
	];

	const status = stored<Status>(K.status, DEFAULT_STATUS);
	const version = chrome.runtime.getManifest().version;
	const current = () => SECTIONS.find((s) => s.id === location.hash.slice(1)) ?? SECTIONS[0]!;
	let active = $state(current());
	addEventListener('hashchange', () => {
		active = current();
		document.querySelector<HTMLElement>('#main')?.focus();
	});
	$effect(() => {
		document.title = `${active.label}, Colander options`;
	});
</script>

<div class="shell">
	<div class="navcol">
		<nav class="nav" aria-label="Options">
			<a class="brand" href="#lists"><ColanderMark size={24} /><span>Colander</span></a>
			<ul>
				{#each SECTIONS as s (s.id)}
					<li>
						<a href="#{s.id}" class:active={active.id === s.id} aria-current={active.id === s.id ? 'page' : undefined}>
							<s.icon size={16} aria-hidden="true" />
							<span>{s.label}</span>
							{#if s.id === 'reports' && (status.value.reportsUpdated || status.value.reportsClosed)}<span class="dot"></span><span class="cl-sr-only">, updated</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
			<div class="foot">
				<a class="uin-btn uin-btn-ghost uin-btn-md support" href="{SITE}/support" target="_blank" rel="noopener"><Heart size={16} aria-hidden="true" />Support our work</a>
				<p class="cl-figure version">Version {version}</p>
			</div>
		</nav>
	</div>

	<div class="pick">
		<label for="section" class="cl-sr-only">Section</label>
		<NativeSelect
			id="section"
			options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
			value={active.id}
			onchange={(e) => (location.hash = (e.currentTarget as HTMLSelectElement).value)}
		/>
	</div>

	<main id="main" tabindex="-1">
		{#key active.id}
			<active.view />
		{/key}
	</main>

	<aside class="rail" aria-label="List status and links">
		{#if active.id !== 'lists'}<ListStatus />{/if}
		<Card title="Learn more" headingLevel={2}>
			<ul class="learn">
				{#each active.learn as [label, path] (path)}
					<li><a class="cl-link" href="{SITE}{path}" target="_blank" rel="noopener">{label}<ArrowRight size={16} aria-hidden="true" /></a></li>
				{/each}
			</ul>
		</Card>
	</aside>
</div>

<style>
	.shell {
		display: grid;
		grid-template-columns: 232px minmax(0, 1fr);
		min-height: 100vh;
	}
	.navcol {
		border-right: 1px solid var(--cl-border);
	}
	.nav {
		position: sticky;
		top: 0;
		display: flex;
		flex-direction: column;
		height: 100vh;
		padding: 0 12px 16px;
	}
	.brand {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		height: 64px;
		padding: 0 12px;
		color: var(--cl-text);
		font: var(--cl-body-lg);
		font-weight: 600;
		text-decoration: none;
	}
	.nav ul {
		display: grid;
		gap: 2px;
	}
	.nav ul a {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 40px;
		padding: 0 12px;
		border-radius: var(--cl-r-chip);
		color: var(--cl-text);
		font: var(--cl-body-strong);
		text-decoration: none;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.nav ul a:hover:not(.active) {
		background: color-mix(in srgb, var(--cl-text) 6%, transparent);
	}
	.nav ul a.active {
		background: var(--cl-brand-tint);
		color: var(--cl-brand);
	}
	.dot {
		width: 8px;
		height: 8px;
		margin-left: auto;
		border-radius: 50%;
		background: currentColor;
	}
	.foot {
		display: grid;
		justify-items: start;
		gap: 8px;
		margin-top: auto;
	}
	.version {
		padding: 0 12px;
		color: var(--cl-text-muted);
	}
	.pick {
		display: none;
	}
	/* Focus lands on the section after the nav moves it, for screen readers; it is not a control, so no ring. */
	main {
		width: 100%;
		max-width: 784px;
		padding: 48px 32px 96px;
		outline: none;
	}
	main:focus-visible {
		box-shadow: none;
	}
	.rail {
		display: none;
	}
	.learn {
		display: grid;
		gap: 8px;
	}
	@media (min-width: 1200px) {
		/* The 784 content and the 312 rail (a 280 card and 32 of gutter) center beside the nav. */
		.shell {
			grid-template-columns: 232px minmax(0, 1fr) minmax(0, 784px) 312px minmax(0, 1fr);
		}
		main {
			grid-column: 3;
		}
		.rail {
			grid-column: 4;
			position: sticky;
			top: 0;
			display: grid;
			align-content: start;
			gap: 24px;
			height: 100vh;
			padding: 48px 32px 0 0;
		}
	}
	@media (max-width: 799px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
		}
		.navcol {
			display: none;
		}
		.pick {
			display: block;
			padding: 16px 16px 0;
		}
		main {
			padding: 32px 16px 64px;
		}
	}
</style>
