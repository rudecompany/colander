<!--
@component First run, in 3 steps: strictness on the recreated feed, the platforms (the browser asks
for site access to those only, straight from the Continue click), and pinning the toolbar icon,
told the way this browser does it. A sticky bar holds Back and Continue; Done opens the first
platform, and the last card links to connecting Plus with a code.
-->
<script lang="ts">
	import { ColanderMark, DotField, FeedDemo, Lifecycle, StrictnessControl, type LifecycleStep } from '@colander/shared';
	import { DEFINITION_PUBLIC, DEMO_THUMBS_NOTE, PLATFORM_SURFACES, TAGLINE } from '@colander/shared/copy';
	import { fmtList } from '@colander/shared/format';
	import { TOOLBAR } from '@colander/shared/glyphs';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { PLATFORMS, PLATFORM_NAME, type Platform, type Strictness } from '@colander/shared/verdicts';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Eye from '@lucide/svelte/icons/eye';
	import Pin from '@lucide/svelte/icons/pin';
	import Settings from '@lucide/svelte/icons/settings';
	import Puzzle from '@lucide/svelte/icons/puzzle';
	import { MediaQuery } from 'svelte/reactivity';
	import { fade } from 'svelte/transition';
	import type { AdapterConfig } from '../../adapters/schema';
	import { HOME, offered } from '../../lib/platforms';
	import { isPlus, K, type Entitlement } from '../../lib/settings';
	import { enablePlatforms } from '../../ui/platforms';
	import { send, stored } from '../../ui/store.svelte';
	import { browser } from 'wxt/browser';

	const config = stored<AdapterConfig | undefined>(K.adapterConfig, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	// Early access platforms are offered only with Plus.
	const available = $derived(PLATFORMS.filter((p) => offered(p, config.value, isPlus(entitlement.value))));

	const STEPS = ['Strictness', 'Platforms', 'Pin Colander'];
	// Pinning, as each build's browser shows it. The Chrome build also runs in Brave and Opera, which pin the same way.
	const PIN = import.meta.env.FIREFOX
		? { icon: Settings, where: "Firefox's toolbar", step: 'Choose the gear beside Colander, then Pin to Toolbar.', keeps: 'the gear menu pins Colander to the toolbar' }
		: import.meta.env.EDGE
			? { icon: Eye, where: "Edge's toolbar", step: 'Choose the eye beside Colander to show it in the toolbar.', keeps: 'the eye shows Colander in the toolbar' }
			: { icon: Pin, where: "your browser's toolbar", step: 'Choose the pin beside Colander.', keeps: 'the pin keeps Colander in the toolbar' };
	let step = $state(0);
	let strictness = $state<Strictness>('standard');
	let chosen = $state<Platform[]>(['yt']);
	let error = $state('');
	let busy = $state(false);
	let done = $state(false);
	const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
	// On a phone-width window (or at high zoom) the recreated feed is a list, as the website shows it there.
	const phone = new MediaQuery('max-width: 639px');
	const lifecycle = $derived<LifecycleStep[]>(STEPS.map((label, i) => ({ label, state: done || i < step ? 'done' : i === step ? 'current' : 'later' })));

	function togglePlatform(p: Platform) {
		chosen = chosen.includes(p) ? chosen.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || chosen.includes(x));
		error = '';
	}

	async function next() {
		error = '';
		if (step === 0) {
			await send({ type: 'settings', patch: { strictness } });
			step = 1;
		} else if (step === 1) {
			chosen = chosen.filter((p) => available.includes(p));
			if (!chosen.length) {
				error = 'Choose at least one platform.';
				return;
			}
			busy = true;
			// The permission request must come first, straight from the click.
			const ok = await enablePlatforms(chosen);
			busy = false;
			if (!ok) {
				error = 'Your browser did not grant site access, so Colander cannot run there yet. Choose Continue again to allow it.';
				return;
			}
			step = 2;
		} else {
			busy = true;
			await send({ type: 'settings', patch: { strictness, onboarded: true } });
			busy = false;
			done = true;
			await browser.tabs.create({ url: HOME[chosen[0] ?? 'yt'] });
		}
		scrollTo({ top: 0 });
	}
</script>

<div class="page">
	<header class="hero">
		<DotField class="field" mask="linear-gradient(to bottom, black, transparent)" />
		<div class="col">
			<ColanderMark size={48} />
			<p class="cl-eyebrow">{TAGLINE.first} {TAGLINE.second}</p>
			<h1 class="cl-display-lg">Set up Colander in 3 steps.</h1>
			<!-- The same header on every step, so the progress strip and the step heading never move. -->
			<p class="cl-lead def">{DEFINITION_PUBLIC}</p>
		</div>
	</header>

	<main class="col">
		<Lifecycle steps={lifecycle} direction="horizontal" label="Setup progress" />

		{#key done ? 'done' : step}
			<div class="step" in:fade={{ duration: reduced ? 0 : 200 }}>
				{#if done}
					<section class="card" aria-labelledby="done-title">
						<h2 id="done-title" class="cl-title">You are set</h2>
						<p class="muted">Colander now runs on {fmtList(chosen.map((p) => PLATFORM_NAME[p]))}. The toolbar icon counts what it hides on each page, and every hidden item can be shown again.</p>
						<p class="links">
							<a class="cl-link" href="options.html#platforms">Change platforms<ArrowRight size={16} aria-hidden="true" /></a>
							<a class="cl-link" href="options.html#strictness">Change strictness<ArrowRight size={16} aria-hidden="true" /></a>
							<a class="cl-link" href="options.html#plan">Have Plus? Connect it with a code<ArrowRight size={16} aria-hidden="true" /></a>
						</p>
					</section>
				{:else if step === 0}
					<section aria-labelledby="s1">
						<h2 id="s1" class="cl-title">How strict should it be?</h2>
						<p class="muted lede">Change the level and watch the recreated feed below. You can change it any time from the toolbar.</p>
						<!-- The one control on the step comes first, so nobody moves on without seeing it. -->
						<div class="control">
							<StrictnessControl bind:value={strictness} size="xl" label="How strict should it be?" />
							<span class="rec" aria-hidden="true"><span class="uin-badge uin-badge-md">Recommended</span></span>
						</div>
						<figure class="wide demo">
							<!-- Two grid rows; the frame fades out below them, so a third row never reads as cut. -->
							<FeedDemo variant="full" platform="yt" layout={phone.current ? 'list' : undefined} bind:level={strictness} popup={false} height={560} open={null} />
							<figcaption class="caption">{DEMO_THUMBS_NOTE}</figcaption>
						</figure>
					</section>
				{:else if step === 1}
					<section aria-labelledby="s2">
						<h2 id="s2" class="cl-title">Where should it work?</h2>
						<div class="platforms" role="group" aria-labelledby="s2">
							{#each available as p (p)}
								{@const on = chosen.includes(p)}
								<button type="button" role="checkbox" aria-checked={on} class="platform" class:on onclick={() => togglePlatform(p)}>
									<span class="pt">
										<span class="pw">{PLATFORM_NAME[p]}</span>
										<span class="state" aria-hidden="true">{#if on}<Check size={16} />On{/if}</span>
									</span>
									<span class="caption">{PLATFORM_SURFACES[p]}</span>
								</button>
							{/each}
						</div>
						<p class="note">Your browser will ask for access to the sites you choose. Colander reads feed cards there and matches them on this device.</p>
					</section>
				{:else}
					<section aria-labelledby="s3">
						<h2 id="s3" class="cl-title">Pin Colander</h2>
						<p class="muted lede">Pin Colander so you can see counts and pause.</p>
						<div class="toolbar" role="img" aria-label="The browser toolbar: the puzzle piece opens Extensions, {PIN.keeps}">
							<span class="address"></span>
							<span class="tb"><Puzzle size={16} aria-hidden="true" /></span>
							<span class="tb"><PIN.icon size={16} aria-hidden="true" /></span>
							<span class="tb" style:color={TOOLBAR.mark}><ColanderMark size={16} /></span>
						</div>
						<ol class="pin-steps">
							<li><Puzzle size={16} aria-hidden="true" />Choose the puzzle piece in {PIN.where}.</li>
							<li><PIN.icon size={16} aria-hidden="true" />{PIN.step}</li>
						</ol>
						<ul class="states" aria-label="The toolbar icon" style:--cl-paper={TOOLBAR.dot} style:--cl-ink={TOOLBAR.ring}>
							<li><span class="ic" style:color={TOOLBAR.mark}><ColanderMark size={32} /></span>Active</li>
							<li><span class="ic" style:color={TOOLBAR.paused}><ColanderMark size={32} outline /></span>Paused</li>
							<li><span class="ic" style:color={TOOLBAR.mark}><ColanderMark size={32} attention /></span>Needs attention</li>
						</ul>
						<p class="links">
							{#each chosen as p (p)}<a class="cl-link" href={HOME[p]} target="_blank" rel="noopener">Open {PLATFORM_NAME[p]}<ArrowRight size={16} aria-hidden="true" /></a>{/each}
						</p>
					</section>
				{/if}
			</div>
		{/key}
		{#if error}<p class="error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>{/if}
	</main>

	{#if !done}
		<div class="bar">
			<div class="bar-in">
				<span class="cl-figure">Step {step + 1} of 3</span>
				{#if step > 0}<Button variant="secondary" size="xxl" onclick={() => ((step -= 1), (error = ''))}>Back</Button>{/if}
				<Button variant="primary" size="xxl" onclick={next} loading={busy}>{step === 2 ? 'Done' : 'Continue'}</Button>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(html) {
		scroll-padding-bottom: 88px;
	}
	.page {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
	.col {
		width: 100%;
		max-width: calc(720px + 2 * 24px);
		margin: 0 auto;
		padding: 0 24px;
	}
	.hero {
		position: relative;
		min-height: 200px;
		padding: 48px 0 32px;
	}
	.hero :global(.field) {
		position: absolute;
		inset: 0 0 auto;
		height: 200px;
	}
	.hero .col {
		position: relative;
		display: grid;
		justify-items: start;
		gap: 12px;
	}
	.hero h1 {
		margin-top: 4px;
	}
	.def {
		margin-top: 4px;
		color: var(--cl-text-muted);
	}
	main {
		flex: 1;
		display: grid;
		align-content: start;
		gap: 32px;
		padding-bottom: 48px;
	}
	/* Step 1's frame is 960 wide, centered on the 720 column. */
	.wide {
		margin-inline: calc((min(720px, 100vw - 48px) - min(960px, 100vw - 48px)) / 2);
	}
	section {
		display: grid;
		gap: 16px;
	}
	.lede {
		margin-top: -8px;
	}
	.muted,
	.caption {
		color: var(--cl-text-muted);
	}
	.caption {
		font: var(--cl-caption);
	}
	/* One column as wide as the page, so the 560 px control and its badge row shrink with a narrow
	   window instead of widening the page; centered inside it. */
	.control {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
	}
	.control :global(.sc) {
		justify-items: center;
	}
	.control :global(.uin-seg) {
		width: min(560px, 100%);
	}
	.rec {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		justify-self: center;
		order: -1;
		width: min(560px, 100%);
	}
	.rec .uin-badge {
		grid-column: 2;
		justify-self: center;
	}
	.demo {
		display: grid;
		gap: 12px;
		margin-top: 8px;
	}
	.demo figcaption {
		text-align: center;
	}
	.platforms {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.platform {
		display: grid;
		align-content: start;
		gap: 4px;
		min-height: 88px;
		padding: 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		color: var(--cl-text);
		text-align: left;
		cursor: pointer;
		transition: border-color var(--cl-fast) var(--cl-ease);
	}
	.platform:hover:not(.on) {
		border-color: var(--cl-border-strong);
	}
	.platform.on {
		border-color: var(--cl-brand);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	.pt {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.pw {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--cl-brand);
		font: var(--cl-body-strong);
	}
	.note {
		padding: 12px 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.card {
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 4px;
		height: 48px;
		padding: 0 8px 0 12px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
	}
	.address {
		flex: 1;
		height: 28px;
		margin-right: 8px;
		border-radius: var(--cl-r-full);
		background: var(--cl-surface);
	}
	.tb {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		color: var(--cl-text-muted);
	}
	.pin-steps {
		display: grid;
		gap: 8px;
	}
	.pin-steps li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.states {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.states li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		font: var(--cl-body-strong);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
	}
	.links .cl-link {
		font: var(--cl-body-strong);
	}
	.error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.error :global(svg) {
		margin-top: 2px;
	}
	.bar {
		position: sticky;
		bottom: 0;
		z-index: 5;
		border-top: 1px solid var(--cl-border);
		background: var(--cl-paper);
	}
	.bar-in {
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: calc(720px + 2 * 24px);
		height: 72px;
		margin: 0 auto;
		padding: 0 24px;
	}
	.bar-in .cl-figure {
		margin-right: auto;
		color: var(--cl-text-muted);
	}
	@media (max-width: 639px) {
		.platforms {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
