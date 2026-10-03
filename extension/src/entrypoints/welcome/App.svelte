<!--
@component First run: the definition of slop in two sentences, the four strictness levels with
Standard preselected, and a platform picker. Chrome asks for site access only for the chosen
platforms; finishing opens the first one.
-->
<script lang="ts">
	import { ColanderMark } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { PLATFORMS, PLATFORM_NAME, STRICTNESS, STRICTNESS_HINT, STRICTNESS_WORD, type Platform, type Strictness } from '@colander/shared/verdicts';
	import Check from '@lucide/svelte/icons/check';
	import type { AdapterConfig } from '../../adapters/schema';
	import { HOME, offered } from '../../lib/platforms';
	import { isPlus, K, type Entitlement } from '../../lib/settings';
	import { enablePlatforms } from '../../ui/platforms';
	import { send, stored } from '../../ui/store.svelte';

	const config = stored<AdapterConfig | undefined>(K.adapterConfig, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	// Early access platforms are offered only with Plus.
	const available = $derived(PLATFORMS.filter((p) => offered(p, config.value, isPlus(entitlement.value))));

	let strictness = $state<Strictness>('standard');
	let chosen = $state<Platform[]>(['yt']);
	let error = $state('');
	let done = $state(false);
	let busy = $state(false);

	const SURFACES: Record<Platform, string> = {
		yt: 'Home, search, Shorts and more',
		tt: 'For You, search and profiles',
		ig: 'Feed, Reels and Explore',
		fb: 'Feed, Reels and suggestions'
	};

	function togglePlatform(p: Platform) {
		chosen = chosen.includes(p) ? chosen.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || chosen.includes(x));
		error = '';
	}

	async function finish() {
		error = '';
		chosen = chosen.filter((p) => available.includes(p));
		if (!chosen.length) {
			error = 'Choose at least one platform.';
			return;
		}
		busy = true;
		// The permission request must come first, straight from the click.
		const ok = await enablePlatforms(chosen);
		if (!ok) {
			busy = false;
			error = 'Chrome did not grant site access, so Colander cannot run there yet. Choose Start again to allow it.';
			return;
		}
		await send({ type: 'settings', patch: { strictness, onboarded: true } });
		busy = false;
		done = true;
		await chrome.tabs.create({ url: HOME[chosen[0]!] });
	}
</script>

<div class="page">
	<div class="drain dots" aria-hidden="true"></div>
	<main>
		<header class="hero">
			<span class="mark"><ColanderMark size={56} /></span>
			<p class="tag t-body-lg muted">Drain the slop. Keep the substance.</p>
			<h1 class="t-display">Welcome to Colander</h1>
			<p class="def t-body-lg">
				AI slop is AI-made content that is mass-produced with little human effort to capture attention or money, and gives you little in return.
				AI use alone never makes something slop.
			</p>
		</header>

		{#if done}
			<section class="card done" aria-live="polite">
				<span class="ok"><Check size={20} strokeWidth={1.75} /></span>
				<div>
					<h2 class="t-title">You are set</h2>
					<p class="muted">Colander now runs on {chosen.map((p) => PLATFORM_NAME[p]).join(', ')}. The toolbar icon counts what it hides on each page, and every hidden item can be shown again.</p>
					<p class="links"><a href="options.html#platforms">Change platforms</a> · <a href="options.html#strictness">Change strictness</a></p>
				</div>
			</section>
		{:else}
			<section class="card" aria-labelledby="s1">
				<h2 id="s1" class="t-title"><span class="step">1</span>How strict should it be?</h2>
				<div class="levels" role="radiogroup" aria-labelledby="s1">
					{#each STRICTNESS as s (s)}
						<button type="button" role="radio" aria-checked={strictness === s} class="level" class:on={strictness === s} onclick={() => (strictness = s)}>
							<span class="lh"><span class="lw">{STRICTNESS_WORD[s]}</span>{#if s === 'standard'}<span class="rec">Recommended</span>{/if}</span>
							<span class="t-caption muted">{STRICTNESS_HINT[s]}</span>
						</button>
					{/each}
				</div>
				<p class="t-caption muted">You can change this any time from the toolbar.</p>
			</section>

			<section class="card" aria-labelledby="s2">
				<h2 id="s2" class="t-title"><span class="step">2</span>Where should it work?</h2>
				<div class="platforms" role="group" aria-labelledby="s2">
					{#each available as p (p)}
						<button type="button" role="checkbox" aria-checked={chosen.includes(p)} class="platform" class:on={chosen.includes(p)} onclick={() => togglePlatform(p)}>
							<span class="box" aria-hidden="true">{#if chosen.includes(p)}<Check size={14} strokeWidth={2.25} />{/if}</span>
							<span class="pt"><span class="pw">{PLATFORM_NAME[p]}</span><span class="t-caption muted">{SURFACES[p]}</span></span>
						</button>
					{/each}
				</div>
				<p class="t-caption muted">Chrome will ask for access to the sites you choose, and only those. Nothing about what you watch leaves this device.</p>
			</section>

			<div class="finish">
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				<Button variant="primary" onclick={finish} aria-busy={busy}>Start using Colander</Button>
			</div>
		{/if}
	</main>
</div>

<style>
	:global(body) {
		background: var(--cl-paper);
	}
	.page {
		position: relative;
		min-height: 100vh;
		overflow: hidden;
	}
	.drain {
		position: absolute;
		inset: 0 0 auto 0;
		height: 360px;
		mask-image: linear-gradient(to bottom, rgb(0 0 0 / 0.9), transparent);
		pointer-events: none;
	}
	main {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 24px;
		max-width: 720px;
		margin: 0 auto;
		padding: 64px 24px 96px;
	}
	.hero {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		margin-bottom: 8px;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 88px;
		height: 88px;
		margin-bottom: 8px;
		border-radius: 24px;
		background: var(--cl-surface);
		color: var(--cl-ink);
		box-shadow: 0 0 0 1px var(--cl-border);
	}
	@media (prefers-color-scheme: dark) {
		.mark {
			color: var(--cl-text);
		}
	}
	.def {
		max-width: 60ch;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	h2 {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.step {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--cl-brand-tint);
		color: var(--cl-brand);
		font: var(--cl-body);
		font-weight: 700;
	}
	.levels,
	.platforms {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}
	.level,
	.platform {
		display: flex;
		gap: 12px;
		min-height: 72px;
		padding: 12px 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		color: var(--cl-text);
		text-align: left;
		cursor: pointer;
		transition: border-color var(--cl-fast) var(--cl-ease), background-color var(--cl-fast) var(--cl-ease);
	}
	.level {
		flex-direction: column;
		gap: 4px;
	}
	.level:hover,
	.platform:hover {
		border-color: var(--uin-line-strong);
	}
	.level.on,
	.platform.on {
		border-color: var(--cl-brand);
		background: var(--cl-brand-tint);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	.level:focus-visible,
	.platform:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	.lh {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.lw,
	.pw {
		font-weight: 600;
	}
	.rec {
		padding: 2px 8px;
		border-radius: var(--cl-r-full);
		background: var(--cl-brand);
		color: var(--cl-brand-fg);
		font: var(--cl-chip);
	}
	.platform {
		align-items: center;
	}
	.box {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		border: 1px solid var(--cl-text-muted);
		border-radius: 4px;
		background: var(--cl-surface);
	}
	.platform.on .box {
		border-color: var(--cl-brand);
		background: var(--cl-brand);
		color: var(--cl-brand-fg);
	}
	.pt {
		display: flex;
		flex-direction: column;
	}
	.finish {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 16px;
	}
	.finish :global(.uin-btn) {
		height: 40px;
		padding: 0 20px;
		font-size: 16px;
	}
	.error {
		color: var(--cl-slop);
	}
	.done {
		flex-direction: row;
		align-items: flex-start;
	}
	.ok {
		display: grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--cl-clear-tint);
		color: var(--cl-clear);
	}
	.done div {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	@media (max-width: 560px) {
		.levels,
		.platforms {
			grid-template-columns: 1fr;
		}
	}
</style>
