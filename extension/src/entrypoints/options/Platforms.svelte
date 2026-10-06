<!-- @component Platforms: switching one on asks the browser for site access to that platform only. -->
<script lang="ts">
	import { PageHeader, PlusTag, SettingRow } from '@colander/shared';
	import { PLATFORM_DOMAIN, PLATFORM_SURFACES } from '@colander/shared/copy';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { PLATFORMS, PLATFORM_NAME, type Platform } from '@colander/shared/verdicts';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import type { AdapterConfig } from '../../adapters/schema';
	import { offered, platformConfig } from '../../lib/platforms';
	import { isPlus, K, withDefaults, type Entitlement, type Settings } from '../../lib/settings';
	import { disablePlatform, enablePlatforms, granted } from '../../ui/platforms';
	import { stored } from '../../ui/store.svelte';
	import { browser } from 'wxt/browser';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	const config = stored<AdapterConfig | undefined>(K.adapterConfig, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const plus = $derived(isPlus(entitlement.value));
	let access = $state<Record<Platform, boolean>>({ yt: false, tt: false, ig: false, fb: false });
	let note = $state('');

	async function refresh() {
		for (const p of PLATFORMS) access[p] = await granted(p);
	}
	void refresh();
	browser.permissions.onAdded.addListener(refresh);
	browser.permissions.onRemoved.addListener(refresh);

	async function toggle(p: Platform, on: boolean) {
		note = '';
		if (on) {
			const ok = await enablePlatforms([p]);
			if (!ok) note = `Your browser did not grant access to ${PLATFORM_DOMAIN[p]}, so ${PLATFORM_NAME[p]} stays off.`;
		} else await disablePlatform(p);
		await refresh();
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Platforms" lede="Colander asks your browser for site access only for the platforms you switch on, and runs nowhere else." />

<div class="cards">
	<Card>
		{#each PLATFORMS as p (p)}
			{@const early = !!platformConfig(config.value, p).early_access}
			{#if offered(p, config.value, plus)}
				<SettingRow title={PLATFORM_NAME[p]} description={PLATFORM_SURFACES[p]}>
					{#if early}<span class="uin-badge uin-badge-md early">Early access</span>{/if}
					{#if settings.platforms[p] && !access[p]}
						<span class="warn"><CircleAlert size={16} aria-hidden="true" />Your browser no longer grants site access to {PLATFORM_DOMAIN[p]}. Switch it on again to grant it.</span>
					{/if}
					{#snippet control({ labelledby, describedby })}
						<Switch checked={settings.platforms[p] && access[p]} aria-labelledby={labelledby} aria-describedby={describedby} onCheckedChange={(v) => toggle(p, v)} />
					{/snippet}
				</SettingRow>
			{:else}
				<SettingRow as="div" title={PLATFORM_NAME[p]} description="Early access to new platforms is part of Plus.">
					{#snippet control()}<PlusTag />{/snippet}
				</SettingRow>
			{/if}
		{/each}
		{#if note}<p class="warn" role="alert"><CircleAlert size={16} aria-hidden="true" />{note}</p>{/if}
	</Card>
	<p class="caption">Pages that are already open start using Colander after a reload.</p>

	<Card>
		<SettingRow as="div" title="Early access to new platforms" description="New platforms arrive here first for Plus, while their adapters are checked.">
			{#snippet control()}
				{#if plus}
					<span class="uin-badge uin-badge-md">Included in your plan</span>
				{:else}
					<span class="gate"><PlusTag /><a class="cl-link" href="#plus">See Plus<ArrowRight size={16} aria-hidden="true" /></a></span>
				{/if}
			{/snippet}
		</SettingRow>
	</Card>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.cards > :global(.uin-card) {
		padding-block: 0;
	}
	.early {
		justify-self: start;
		margin-top: 4px;
	}
	.warn {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font: var(--cl-caption);
	}
	.warn :global(svg) {
		width: 14px;
		height: 14px;
		margin-top: 1px;
	}
	p.warn {
		padding: 12px 0;
		border-top: 1px solid var(--cl-border);
		font: var(--cl-body);
	}
	.caption {
		margin-top: -12px;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.gate {
		display: inline-flex;
		align-items: center;
		gap: 12px;
	}
</style>
