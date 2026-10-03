<!-- @component Platforms: switching one on asks Chrome for site access to that platform only. -->
<script lang="ts">
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { PLATFORMS, PLATFORM_NAME, type Platform } from '@colander/shared/verdicts';
	import { K, withDefaults, type Settings } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { disablePlatform, enablePlatforms, granted } from '../../ui/platforms';
	import { stored } from '../../ui/store.svelte';

	const HOSTS: Record<Platform, string> = { yt: 'youtube.com', tt: 'tiktok.com', ig: 'instagram.com', fb: 'facebook.com' };
	const SURFACES: Record<Platform, string> = {
		yt: 'Home, search, watch page suggestions, Shorts, subscriptions and channel pages',
		tt: 'For You, search and profiles',
		ig: 'Feed, Reels and Explore',
		fb: 'Feed, Reels and suggested posts'
	};
	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	let access = $state<Record<Platform, boolean>>({ yt: false, tt: false, ig: false, fb: false });
	let note = $state('');

	async function refresh() {
		for (const p of PLATFORMS) access[p] = await granted(p);
	}
	void refresh();
	chrome.permissions.onAdded.addListener(refresh);
	chrome.permissions.onRemoved.addListener(refresh);

	async function toggle(p: Platform, on: boolean) {
		note = '';
		if (on) {
			const ok = await enablePlatforms([p]);
			if (!ok) note = `Chrome did not grant access to ${HOSTS[p]}, so ${PLATFORM_NAME[p]} stays off.`;
		} else await disablePlatform(p);
		await refresh();
	}
</script>

<Section id="platforms" title="Platforms" description="Colander asks Chrome for site access only for the platforms you switch on, and runs nowhere else.">
	<Card>
		<ul class="rows">
			{#each PLATFORMS as p (p)}
				{@const on = settings.platforms[p] && access[p]}
				<li>
					<div class="what">
						<span id="pf-{p}" class="name">{PLATFORM_NAME[p]}</span>
						<span class="t-caption muted">{SURFACES[p]}</span>
						{#if settings.platforms[p] && !access[p]}<span class="t-caption warn">Site access for {HOSTS[p]} was removed. Switch it on again to grant it.</span>{/if}
					</div>
					<Switch checked={on} aria-labelledby="pf-{p}" onCheckedChange={(v) => toggle(p, v)} />
				</li>
			{/each}
		</ul>
		{#if note}<p class="warn" role="alert">{note}</p>{/if}
	</Card>
	<p class="t-caption muted">Pages that are already open start using Colander after a reload.</p>
</Section>

<style>
	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
	}
	.rows li + li {
		border-top: 1px solid var(--cl-border);
	}
	.what {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.name {
		font-weight: 600;
	}
	.warn {
		color: var(--cl-slop);
	}
</style>
