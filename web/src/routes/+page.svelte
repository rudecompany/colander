<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import {
		ACTION_DONE_WORD,
		ACTION_TABLE,
		DEFINITION,
		DEMO_FEED,
		DEMO_POPUP,
		DotField,
		DotMeter,
		DotUnitChart,
		EvidenceCard,
		FeedDemo,
		ITEM_NOUN,
		LogRow,
		PermissionsTable,
		PLATFORMS,
		PLATFORM_DOMAIN,
		PLATFORM_NAME,
		PLATFORM_SURFACES,
		PLAN_COPY,
		PlatformTag,
		PopupView,
		PriceCard,
		PrivacyFacts,
		StatCell,
		STRICTNESS,
		STRICTNESS_HINT,
		STRICTNESS_WORD,
		StrictnessControl,
		Thumb,
		Toast,
		VerdictChip,
		VerdictGlyph,
		VERDICTS,
		VERDICT_PLAIN,
		fmtAgo,
		fmtDateTime,
		fmtListVersion,
		fmtNum,
		fmtShortDate,
		type Platform,
		type PopupState,
		type Strictness
	} from '@colander/shared';
	import { demoAction, demoCounts } from '@colander/shared/inpage';
	import { evidence } from '@colander/shared/inpage/evidence.ts';
	import type { LogEntry } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Tabs from '@colander/shared/components/ui/tabs/tabs.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import InfinityIcon from '@lucide/svelte/icons/infinity';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Info from '@lucide/svelte/icons/info';
	import Lock from '@lucide/svelte/icons/lock';
	import Scale from '@lucide/svelte/icons/scale';
	import Tag from '@lucide/svelte/icons/tag';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Figure from '#lib/components/Figure.svelte';
	import SectionHead from '#lib/components/SectionHead.svelte';
	import SendToComputer from '#lib/components/SendToComputer.svelte';
	import { COMPARISON, COMPARISON_CHECKED, FAQ, KAPWING } from '#lib/content.ts';
	import { live } from '#lib/live.svelte.ts';

	/* Hero demo: one state drives the frame, the docked popup, the phone feed and the phone popup. */
	let platform = $state<Platform>('yt');
	let level = $state<Strictness>('standard');
	let paused = $state(false);
	let openPhone = $state<number | null>(6);

	const stats = $derived(live.stats);
	const listInfo = $derived({ sequence: stats?.list_sequence ?? null, updatedAt: stats?.list_updated_at ?? null });
	const listDate = $derived(stats?.list_updated_at ?? null);
	const release = __RELEASE__;

	const popupState = $derived<PopupState>({
		status: paused ? 'paused' : 'active',
		domain: PLATFORM_DOMAIN[platform],
		pausedScope: 'site',
		strictness: level,
		hiddenToday: DEMO_POPUP.hiddenToday,
		noun: ITEM_NOUN[platform],
		rows: paused
			? []
			: DEMO_FEED.filter((i) => i.verdict && demoAction(i, level) !== 'allow').map((i) => ({
					id: i.id,
					verdict: i.verdict,
					title: i.title,
					action: demoAction(i, level)
				})),
		list: listInfo
	});

	/* Live strip. */
	const sources = $derived(stats ? VERDICTS.reduce((n, v) => n + stats.sources[v], 0) : null);

	/* Strictness cards and the specimen strip. */
	const MINI = [2, 6, 3, 1].map((id) => DEMO_FEED.find((i) => i.id === id)!);
	const ACTION_ICON = { hide: EyeOff, collapse: ChevronsDownUp, label: Tag, allow: Eye };

	/* Bento. */
	const item6 = DEMO_FEED.find((i) => i.id === 6)!;
	const bentoEvidence = $derived(evidence({ verdict: 'likely_slop', hidden: true, rows: item6.evidence, listDate }));
	const bentoLog: LogEntry = {
		id: 'demo',
		at: '2026-10-02T14:02:00Z',
		platform: 'yt',
		target_type: 'source',
		target_id: '@coin.lectures',
		source_id: '@coin.lectures',
		source_name: '@coin.lectures',
		from: 'likely_slop',
		to: 'clear',
		reason: 'Appeal upheld. Original lectures, with AI used only for captions.',
		signals: [],
		actor: 'appeal',
		actor_name: null
	};
	const noop = () => {};

	// The phone feed is built in the browser, so the prerendered hero ships one feed (the 40 KB
	// budget); its space is reserved until then. Without JavaScript, phones get the desktop feed.
	let phoneFeed = $state(false);
	onMount(() => (phoneFeed = true));
</script>

<svelte:head>
	<title>Colander: drain the slop from your feed</title>
	<meta
		name="description"
		content="Colander hides AI slop on YouTube, TikTok, Instagram and Facebook the way an ad blocker hides ads, and shows its work for every item. Blocking is free, forever."
	/>
</svelte:head>

<!-- 1. Hero and live demo -->
<section class="hero" aria-labelledby="hero-title">
	<div class="cl-container hero-copy">
		<a class="pill" href="/log">
			{#if stats && stats.decisions_7d > 0}
				<span>{fmtNum(stats.decisions_7d)} verdict {stats.decisions_7d === 1 ? 'change' : 'changes'} published this week</span>
			{:else}
				Read the public decision log
			{/if}
			<ArrowRight size={16} aria-hidden="true" />
		</a>
		<h1 class="cl-display-xl" id="hero-title">Drain the slop.{' '}<br /><span class="cl-tone2">Keep the substance.</span></h1>
		<p class="cl-lead lead">
			Colander hides AI slop on YouTube, TikTok, Instagram and Facebook the way an ad blocker hides ads, and shows its work for
			every item.
		</p>
		<div class="ctas">
			<span class="desk"><Button variant="primary" size="xxl" href={PUBLIC_STORE_URL}>Add to Chrome, free</Button></span>
			<span class="phone"><SendToComputer /></span>
			<ArrowLink href="/definition" size="lg">See how it decides</ArrowLink>
		</div>
		<p class="cl-figure version">
			Version {release.version}{#if release.released}, released {fmtShortDate(release.released)}{/if}. Chrome on desktop, also Edge and Brave.
		</p>
		<ul class="proof">
			<li><Lock size={16} aria-hidden="true" />Matched on your device. No account needed.</li>
			<li><Scale size={16} aria-hidden="true" />Every verdict change is public, and creators can appeal.</li>
			<li><InfinityIcon size={16} aria-hidden="true" />Blocking is free, forever.</li>
		</ul>
	</div>

	<div class="cl-container demo">
		<div class="tabs">
			<Tabs
				direction="horizontal"
				ariaLabel="Platform"
				tabs={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))}
				bind:value={platform}
			/>
		</div>
		<div class="tabs-select field">
			<label class="field-label" for="hero-platform">Platform</label>
			<NativeSelect id="hero-platform" size="lg" options={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))} bind:value={platform} />
		</div>

		<div class="frame-desk">
			<FeedDemo bind:platform bind:level bind:paused height={680} list={listInfo} {listDate} />
		</div>
		<div class="frame-phone" class:reserved={!phoneFeed}>
			{#if phoneFeed}
				<FeedDemo bind:platform bind:level bind:paused bind:open={openPhone} layout="list" items={[3, 6, 1]} popup={false} {listDate} />
			{/if}
		</div>
		<noscript><style>.frame-desk{display:block!important}.frame-phone{display:none!important}</style></noscript>

		<div class="control">
			<span class="control-label" aria-hidden="true">Strictness</span>
			<StrictnessControl bind:value={level} size="xl" label="Strictness" />
		</div>
		<div class="popup-phone">
			<p class="cl-eyebrow">The popup in your toolbar</p>
			<div class="popup-box">
				<PopupView
					state={popupState}
					actions={{
						strictness: (l) => (level = l),
						pause: () => (paused = true),
						resume: () => (paused = false),
						why: (r) => (openPhone = Number(r.id))
					}}
				/>
			</div>
		</div>
		<p class="cl-figure caption">
			Recreated feed. The chips, bars, popover and popup are the components the extension ships. Change the strictness, or pause
			Colander in the popup to see the feed without it.
		</p>
	</div>
</section>

<!-- 2. Live strip and platforms -->
<section class="strip cl-wash" aria-labelledby="strip-title">
	<div class="cl-container">
		<div class="cells">
			<div class="cell label-cell">
				<h2 id="strip-title">The list, right now</h2>
				{#if live.asOf}<p class="cl-figure muted">As of {fmtDateTime(live.asOf)}</p>{/if}
			</div>
			<div class="cell"><StatCell size="lg" label="Sources on the list" value={sources ?? ''} reserve={6} /></div>
			<div class="cell">
				<StatCell size="lg" label="Verdict changes in the last 7 days" value={stats ? stats.decisions_7d : ''} zero={stats ? 'None this week' : undefined} reserve={5} />
			</div>
			<div class="cell">
				<StatCell size="lg" label="Appeals open" value={stats ? stats.appeals.open : ''} zero={stats ? 'No open appeals' : undefined} reserve={4} />
			</div>
			<div class="cell">
				<StatCell
					size="lg"
					label="Median days to decide an appeal"
					value={stats ? stats.appeals.median_days : ''}
					zero={stats ? 'No appeals decided yet' : undefined}
					reserve={4}
				/>
			</div>
		</div>
		<p class="strip-link"><ArrowLink href="/transparency">Read the transparency report</ArrowLink></p>
		<ul class="platforms" aria-label="Platforms">
			{#each PLATFORMS as p (p)}
				<li>
					<span class="p-name">{PLATFORM_NAME[p]}</span>
					<span class="p-surf">{PLATFORM_SURFACES[p]}</span>
					<span class="uin-badge uin-badge-lg">Free</span>
				</li>
			{/each}
		</ul>
	</div>
</section>

<!-- 3. Why it exists -->
<section class="cl-section" aria-labelledby="why-title">
	<div class="cl-container">
		<SectionHead
			id="why-title"
			eyebrow="Why it exists"
			title="Feeds are filling with slop,"
			title2="and no platform has an off switch."
			lead="Kapwing counted what new accounts were shown first."
		/>
		<div class="charts">
			{#each KAPWING as k, i (k.number)}
				<figure class="chart" class:first={i === 0}>
					<div class="chart-art">
						<DotUnitChart cols={k.cols} rows={k.rows} filled={k.filled} pitch={k.pitch} dot={k.dot} label={k.label} />
					</div>
					<div class="chart-meter"><DotMeter value={k.share} max={100} /></div>
					<p class="cl-stat-lg">{k.number}</p>
					<figcaption>{k.caption}</figcaption>
				</figure>
			{/each}
		</div>
		<p class="source">
			Source: <a href="https://www.kapwing.com/resources/the-tiktok-ai-slop-report/" rel="noreferrer">Kapwing, The TikTok AI Slop Report</a>, data from May
			2026. Kapwing classified videos by hand and counted only obvious cases, so treat these figures as indicative.
		</p>
	</div>
</section>

<!-- 4. What counts as slop -->
<section class="cl-section cl-wash" aria-labelledby="def-title">
	<div class="cl-container">
		<SectionHead id="def-title" eyebrow="What counts as slop" title="Slop is a production pattern," title2="not a tool." />
		<p class="cl-title-lg statement">{DEFINITION}</p>
		<ul class="specimens" aria-label="The five verdicts">
			{#each VERDICTS as v (v)}
				{@const a = ACTION_TABLE.standard[v]}
				{@const Icon = ACTION_ICON[a]}
				<li class="specimen">
					<DotField round class="disc" mask="radial-gradient(closest-side, black 70%, transparent)">
						<span class="glyph"><VerdictGlyph verdict={v} size={56} /></span>
					</DotField>
					<div class="spec-text">
						<VerdictChip verdict={v} />
						<p class="spec-plain">{VERDICT_PLAIN[v]}</p>
						<p class="spec-act"><Icon size={16} aria-hidden="true" />{ACTION_DONE_WORD[a]}<span class="sr-only"> at Standard</span></p>
						{#if v === 'ai_made'}<p class="spec-note">Stays visible at Standard</p>{/if}
					</div>
				</li>
			{/each}
		</ul>
		<div class="decides">
			<h3 class="cl-title-lg">How Colander decides</h3>
			<div class="figs">
				<figure>
					<Figure n={1} />
					<figcaption>
						<span class="cl-figure muted">Fig. 1</span>
						<span class="fig-title">AI evidence is a gate</span>
						<span class="fig-copy">Without AI evidence, nothing can be rated slop, however low its quality.</span>
					</figcaption>
				</figure>
				<figure>
					<Figure n={2} />
					<figcaption>
						<span class="cl-figure muted">Fig. 2</span>
						<span class="fig-title">Two layers must agree</span>
						<span class="fig-copy">Nothing is hidden by default until two of the four evidence layers agree.</span>
					</figcaption>
				</figure>
				<figure>
					<Figure n={3} />
					<figcaption>
						<span class="cl-figure muted">Fig. 3</span>
						<span class="fig-title">Tags alone never make anything Slop</span>
						<span class="fig-copy">Slop needs AI evidence, a mass-produced source, and consensus or staff review.</span>
					</figcaption>
				</figure>
			</div>
			<p><ArrowLink href="/definition">Read how Colander decides</ArrowLink></p>
		</div>
	</div>
</section>

<!-- 5. Strictness -->
<section class="cl-section" aria-labelledby="strict-title">
	<div class="cl-container">
		<SectionHead id="strict-title" eyebrow="Your choice" title="You set the strictness." title2="Colander never decides what an adult may see." />
		<ul class="levels">
			{#each STRICTNESS as l (l)}
				<li class="level" class:std={l === 'standard'}>
					<h3 class="level-name">{STRICTNESS_WORD[l]}{#if l === 'standard'}<span class="uin-badge uin-badge-lg">Default</span>{/if}</h3>
					<p class="level-hint">{STRICTNESS_HINT[l]}</p>
					<FeedDemo variant="mini" level={l} />
					<p class="cl-figure muted">{demoCounts(l, MINI)}</p>
				</li>
			{/each}
		</ul>
		<p class="after"><ArrowLink href="/definition#strictness">See the full table</ArrowLink></p>
	</div>
</section>

<!-- 6. Fair by design -->
<section class="cl-section cl-wash" aria-labelledby="fair-title">
	<div class="cl-container">
		<SectionHead id="fair-title" eyebrow="Fair by design" title="Nothing disappears silently." title2="Every action is explained and reversible." />
		<ol class="bento">
			<li class="tile">
				<span class="cl-figure step">01</span>
				<div class="vis" inert role="img" aria-label="A thumbnail with the ink chip AI-made in its corner.">
					<DotField class="vis-dots" />
					<div class="vis-in thumb-demo"><Thumb scene="tide-pool" /><span class="on-thumb"><VerdictChip verdict="ai_made" tone="ink" /></span></div>
				</div>
				<h3>Labeled where you see it</h3>
				<p>AI-made items stay visible at Standard, with a label.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">02</span>
				<div class="vis" inert role="img" aria-label="A list where one item is collapsed to a single line: Likely slop, hidden for you, with Show and Why.">
					<DotField class="vis-dots" />
					<div class="vis-in list-demo"><FeedDemo variant="mini" items={[5, 6, 9]} /></div>
				</div>
				<h3>Hidden for you, not for everyone</h3>
				<p>Likely slop collapses to one line. Show brings it back.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">03</span>
				<div class="vis" inert role="img" aria-label="The Why popover: two evidence layers agreed, and the list it came from.">
					<DotField class="vis-dots" />
					<div class="vis-in pop-demo"><EvidenceCard evidence={bentoEvidence} headingLevel={4} /></div>
				</div>
				<h3>Every hide says why</h3>
				<p>The signals that agreed, the list and the date.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">04</span>
				<div class="vis" inert role="img" aria-label="A notice that says Skipped 1 slop video, with Undo and Why.">
					<DotField class="vis-dots" />
					<div class="vis-in toast-demo">
						<Toast
							text="Skipped 1 slop video."
							verdict="slop"
							paused
							actions={[
								{ label: 'Undo', icon: Undo2, onClick: noop },
								{ label: 'Why', icon: Info, onClick: noop }
							]}
						/>
					</div>
				</div>
				<h3>One click to undo</h3>
				<p>Undo is here and in the popup.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">05</span>
				<div class="vis" inert role="img" aria-label="A source page banner: Disputed, unhidden while staff review.">
					<DotField class="vis-dots" />
					<div class="vis-in banner-demo">
						<span class="banner-top"><PlatformTag platform="yt" /><span class="banner-name">@coin.lectures</span></span>
						<VerdictChip verdict="disputed" size="lg" />
						<span class="banner-line">Unhidden while staff review</span>
					</div>
				</div>
				<h3>Creators can appeal</h3>
				<p>An appeal unhides the source while staff review it.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">06</span>
				<div class="vis" inert role="img" aria-label="A decision log entry from 2 Oct 2026: Likely slop changed to Clear.">
					<DotField class="vis-dots" />
					<div class="vis-in log-demo"><LogRow entry={bentoLog} time="date" /></div>
				</div>
				<h3>Every change is public</h3>
				<p>The outcome and the reason go in the decision log.</p>
			</li>
		</ol>
	</div>
</section>

<!-- 7. Open by default -->
<section class="band cl-band" aria-labelledby="open-title">
	<div class="cl-perf band-edge" aria-hidden="true"></div>
	<div class="cl-container band-in">
		<SectionHead id="open-title" eyebrow="Open by default" title="Matched on your device." title2="Every change in public." />
		<div class="band-grid">
			<div class="band-left">
				<figure class="fig4">
					<Figure n={4} list={stats ? `Core list ${fmtListVersion(stats.list_sequence)}` : 'Core list'} />
					<figcaption class="cl-figure muted">Fig. 4</figcaption>
				</figure>
				<div class="list-card">
					<p class="list-title">Core list{#if stats}{' '}{fmtListVersion(stats.list_sequence)}{/if}</p>
					{#if stats?.list_updated_at}<p class="cl-caption muted">Updated {fmtAgo(stats.list_updated_at, live.now ?? undefined)}</p>{/if}
					<p class="list-line">Colander never asks a server about the page you are viewing.</p>
					<ArrowLink href="/definition#signing">How signing works</ArrowLink>
				</div>
			</div>
			<div class="band-right">
				<h3 class="cl-title">Latest decisions</h3>
				<div class="rows">
					{#each live.log as e (e.id)}<LogRow entry={e} />{:else}<p class="muted none">The decision log has no entries yet.</p>{/each}
				</div>
				<p><ArrowLink href="/log">Open the decision log</ArrowLink></p>
			</div>
		</div>
	</div>
	<div class="cl-perf band-edge" aria-hidden="true"></div>
</section>

<!-- 8. Privacy -->
<section class="cl-section" aria-labelledby="privacy-title">
	<div class="cl-container">
		<SectionHead
			id="privacy-title"
			eyebrow="Private by design"
			title="Matching happens on your device."
			title2="Colander never asks a server about the page you are viewing."
		/>
		<div class="privacy">
			<PrivacyFacts />
			<PermissionsTable />
		</div>
		<p class="foot-line">This site sets no cookies, so there is no banner. <ArrowLink href="/privacy">Read the privacy policy</ArrowLink></p>
	</div>
</section>

<!-- 9. Comparison -->
<section class="cl-section cl-wash" aria-labelledby="compare-title">
	<div class="cl-container">
		<SectionHead id="compare-title" eyebrow="How it compares" title="Built to hide slop," title2="not everything made with AI." />
		<div class="compare">
			<table>
				<caption class="sr-only">Colander compared with what is common in AI blockers</caption>
				<thead>
					<tr><th scope="col">What to check</th><th scope="col">Common in AI blockers</th><th scope="col">Colander</th></tr>
				</thead>
				<tbody>
					{#each COMPARISON as row (row.check)}
						<tr>
							<th scope="row">{row.check}</th>
							<td><span class="k" aria-hidden="true">Common: </span>{row.common}</td>
							<td class="us"><span class="k" aria-hidden="true">Colander: </span>{row.colander}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="compare-cap">
			Based on the most-installed AI content blockers in the Chrome Web Store, checked {fmtShortDate(COMPARISON_CHECKED)}.
			<ArrowLink href="/definition#comparison" size="sm">Sources</ArrowLink>
		</p>
	</div>
</section>

<!-- 10. Plans -->
<section class="cl-section" aria-labelledby="plans-title">
	<div class="cl-container">
		<SectionHead id="plans-title" eyebrow="Plans" title="Blocking is free for good." title2="Plus adds control, never influence." />
		<div class="prices">
			<PriceCard plan="free" cta={{ href: PUBLIC_STORE_URL }} />
			<PriceCard plan="plus" cta={{ href: '/plans#trial' }} />
		</div>
		<p class="trust">{PLAN_COPY.trust}</p>
		<p class="plan-links">
			<ArrowLink href="/plans">Compare plans</ArrowLink>
			<ArrowLink href="/support">Support our work</ArrowLink>
		</p>
	</div>
</section>

<!-- 11. FAQ -->
<section class="cl-section faq-section" aria-labelledby="faq-title">
	<div class="cl-container">
		<div class="faq">
			<h2 class="cl-display-lg" id="faq-title">Questions</h2>
			{#each FAQ as f (f.q)}
				<details>
					<summary>{f.q}<ChevronDown size={16} aria-hidden="true" /></summary>
					<p>{f.a}</p>
				</details>
			{/each}
		</div>
	</div>
</section>

<style>
	.muted {
		color: var(--cl-text-muted);
	}

	/* 1. Hero */
	.hero {
		padding-top: 72px;
		padding-bottom: var(--cl-s9);
	}
	.hero-copy {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 14px;
		border: 1px solid var(--cl-border-strong);
		border-radius: var(--cl-r-full);
		background: var(--cl-surface);
		color: var(--cl-text);
		font: var(--cl-body-strong);
		text-decoration: none;
	}
	.pill:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, var(--cl-surface));
	}
	h1 {
		max-width: 800px;
		margin-top: 24px;
	}
	.lead {
		max-width: 640px;
		margin-top: 20px;
		color: var(--cl-text-muted);
	}
	.ctas {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 16px 24px;
		margin-top: 32px;
	}
	.phone {
		display: none;
	}
	.version {
		margin-top: 16px;
		color: var(--cl-text-muted);
	}
	.proof {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px 24px;
		margin-top: 16px;
		list-style: none;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.proof li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.proof :global(svg) {
		flex: none;
		color: var(--cl-text);
	}
	.demo {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		justify-items: center;
		margin-top: 40px;
	}
	.tabs {
		display: flex;
		justify-content: center;
		margin-bottom: 12px;
	}
	.tabs-select {
		display: none;
	}
	.frame-desk,
	.frame-phone {
		width: 100%;
	}
	.frame-phone,
	.popup-phone {
		display: none;
	}
	.reserved {
		min-height: 565px;
	}
	.control {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 16px;
		margin-top: 24px;
	}
	.control-label {
		color: var(--cl-text-muted);
		font: var(--cl-body-strong);
		line-height: 44px;
	}
	.caption {
		max-width: 720px;
		margin-top: 16px;
		color: var(--cl-text-muted);
		text-align: center;
	}
	.popup-phone {
		width: 100%;
		margin-top: 32px;
	}
	.popup-box {
		max-width: 360px;
		margin-top: 12px;
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		box-shadow: var(--cl-shadow-pop);
	}
	@media (max-width: 899px) {
		.control {
			display: none;
		}
		.popup-phone {
			display: block;
		}
	}
	@media (max-width: 639px) {
		.hero {
			padding-top: 32px;
			padding-bottom: var(--cl-s8);
		}
		.hero-copy {
			align-items: flex-start;
			text-align: left;
		}
		.ctas {
			flex-direction: column;
			align-items: stretch;
			width: 100%;
			gap: 16px;
		}
		.ctas :global(.arrow) {
			align-self: flex-start;
		}
		.desk {
			display: none;
		}
		.phone {
			display: block;
		}
		.proof {
			flex-direction: column;
			align-items: flex-start;
		}
		.demo {
			justify-items: stretch;
		}
		.tabs {
			justify-content: flex-start;
		}
		.frame-desk {
			display: none;
		}
		.frame-phone {
			display: block;
		}
		.caption {
			text-align: left;
		}
	}
	@media (max-width: 379px) {
		.tabs {
			display: none;
		}
		.tabs-select {
			display: grid;
			margin-bottom: 12px;
		}
	}

	/* 2. Live strip */
	.strip {
		border-block: 1px solid var(--cl-border);
	}
	.cells {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}
	.cell {
		padding: 24px;
		border-left: 1px solid var(--cl-border);
	}
	.cell:first-child {
		padding-left: 0;
		border-left: 0;
	}
	.cell :global(.label) {
		min-height: 40px;
	}
	.label-cell h2 {
		margin-bottom: 4px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.strip-link {
		padding-bottom: 24px;
	}
	.platforms {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 24px;
		padding-block: 24px;
		border-top: 1px solid var(--cl-border);
		list-style: none;
	}
	.platforms li {
		display: grid;
		align-content: start;
		justify-items: start;
		gap: 4px;
	}
	.p-name {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.p-surf {
		margin-bottom: 4px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 1023px) {
		.cells {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.label-cell {
			grid-column: 1 / -1;
		}
		.cell {
			padding: 16px 16px 16px 0;
			border-left: 0;
			border-top: 1px solid var(--cl-border);
		}
		.cell:nth-child(odd):not(:first-child) {
			padding-left: 16px;
			border-left: 1px solid var(--cl-border);
		}
		.cell:first-child {
			border-top: 0;
		}
		.platforms {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 639px) {
		.cell:nth-child(even) {
			padding-right: 12px;
		}
		.cell:nth-child(odd):not(:first-child) {
			padding-left: 12px;
		}
		.platforms {
			grid-template-columns: 1fr;
			gap: 0;
			padding-block: 0;
		}
		.platforms li {
			padding-block: 16px;
		}
		.platforms li + li {
			border-top: 1px solid var(--cl-border);
		}
	}

	/* 3. Why it exists */
	.charts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px;
	}
	.chart {
		display: grid;
		align-content: start;
		gap: 8px;
	}
	.chart-art {
		margin-bottom: 16px;
	}
	.chart-meter {
		display: none;
	}
	.chart figcaption {
		max-width: 32ch;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.source {
		max-width: 880px;
		margin-top: 48px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 639px) {
		.charts {
			grid-template-columns: 1fr;
			gap: 32px;
		}
		.chart.first .chart-art :global(svg) {
			width: 100%;
		}
		.chart:not(.first) .chart-art {
			display: none;
		}
		.chart:not(.first) .chart-meter {
			display: block;
			order: 3;
		}
	}

	/* 4. What counts as slop */
	.statement {
		max-width: 880px;
		margin-bottom: 64px;
		text-wrap: pretty;
	}
	.specimens {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 20px;
		list-style: none;
	}
	.specimen {
		display: grid;
		justify-items: center;
		align-content: start;
		gap: 16px;
		text-align: center;
	}
	.specimen :global(.disc) {
		width: 120px;
		height: 120px;
	}
	.glyph {
		display: grid;
		place-items: center;
		color: var(--cl-text);
	}
	.spec-text {
		display: grid;
		justify-items: center;
		gap: 8px;
	}
	.spec-plain {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.spec-act {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--cl-body-strong);
	}
	.spec-note {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.decides {
		margin-top: 64px;
		padding-top: 48px;
		border-top: 1px solid var(--cl-border);
	}
	.figs {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px;
		margin-block: 32px;
	}
	.figs figure {
		display: grid;
		align-content: start;
		gap: 16px;
	}
	.figs figcaption {
		display: grid;
		gap: 4px;
	}
	.fig-title {
		font: var(--cl-title);
	}
	.fig-copy {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 1023px) {
		.specimens {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			row-gap: 40px;
		}
		.figs {
			grid-template-columns: 1fr;
			max-width: 480px;
		}
	}
	@media (max-width: 639px) {
		.specimens {
			grid-template-columns: 1fr;
			gap: 16px;
		}
		.specimen {
			grid-template-columns: 72px 1fr;
			justify-items: start;
			align-items: center;
			text-align: left;
		}
		.specimen :global(.disc) {
			width: 72px;
			height: 72px;
		}
		.glyph :global(.cl-glyph) {
			width: 32px;
			height: 32px;
		}
		.spec-text {
			justify-items: start;
			gap: 4px;
		}
	}

	/* 5. Strictness */
	.levels {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 24px;
		list-style: none;
	}
	.level {
		display: grid;
		grid-template-rows: auto auto 1fr auto;
		gap: 12px;
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.level.std {
		border-color: var(--cl-border-strong);
	}
	.level-name {
		display: flex;
		align-items: center;
		gap: 8px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.level-hint {
		min-height: 40px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.after {
		margin-top: 32px;
	}
	@media (max-width: 1023px) {
		.levels {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 639px) {
		.levels {
			grid-template-columns: 1fr;
			gap: 16px;
		}
		.level-hint {
			min-height: 0;
		}
	}

	/* 6. Fair by design */
	.bento {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px;
		list-style: none;
	}
	.tile {
		position: relative;
		display: grid;
		grid-template-rows: auto 200px auto 1fr;
		align-content: start;
		gap: 16px;
		min-height: 360px;
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.step {
		color: var(--cl-text-muted);
	}
	/* The perforated connector runs from each step number to the next across a row. */
	.tile:not(:nth-child(3n))::after,
	.tile:not(:nth-child(3n + 1))::before {
		content: '';
		position: absolute;
		top: 30px;
		height: 3px;
		background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 8px 3px repeat-x;
	}
	.tile:not(:nth-child(3n))::after {
		right: -25px;
		left: 56px;
	}
	.tile:not(:nth-child(3n + 1))::before {
		left: -1px;
		width: 16px;
	}
	.vis {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		place-items: center;
		overflow: hidden;
		border-radius: var(--cl-r-chip);
		container-type: inline-size;
	}
	.vis :global(.vis-dots) {
		position: absolute;
		inset: 0;
	}
	.vis-in {
		position: relative;
	}
	.thumb-demo {
		width: 240px;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: var(--cl-r-card);
	}
	.on-thumb {
		position: absolute;
		top: 8px;
		left: 8px;
	}
	.list-demo {
		width: calc(100% - 24px);
		padding: 12px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.pop-demo :global(.cl-pop) {
		width: 312px;
		max-width: 100%;
	}
	.toast-demo {
		width: calc(100% - 16px);
	}
	.toast-demo :global(.cl-toast) {
		max-width: 100%;
		margin-inline: auto;
	}
	.banner-demo {
		display: grid;
		justify-items: start;
		gap: 10px;
		width: calc(100% - 32px);
		padding: 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.banner-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.banner-name {
		font: var(--cl-title);
	}
	.banner-line {
		font: var(--cl-body-strong);
	}
	.log-demo {
		width: calc(100% - 24px);
		padding: 0 12px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.log-demo :global(.log) {
		border-top: 0;
	}
	.tile h3 {
		font: var(--cl-title);
	}
	.tile p {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 1023px) {
		.bento {
			grid-template-columns: 1fr;
			max-width: 560px;
		}
		.tile::before,
		.tile::after {
			display: none;
		}
		.tile:not(:last-child)::after {
			display: block;
			top: auto;
			right: auto;
			bottom: -25px;
			left: 31px;
			width: 3px;
			height: 24px;
			background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 3px 8px repeat-y;
		}
	}
	@media (max-width: 639px) {
		.tile {
			grid-template-rows: auto 180px auto 1fr;
			min-height: 0;
			padding: 16px;
		}
		.tile:not(:last-child)::after {
			left: 23px;
		}
	}

	/* 7. Open by default */
	.band-edge {
		--cl-dot: var(--cl-dot-strong);
	}
	.band-in {
		padding-block: var(--cl-s10);
	}
	.band-grid {
		display: grid;
		grid-template-columns: 5fr 7fr;
		gap: 48px;
	}
	.band-left {
		display: grid;
		align-content: start;
		gap: 32px;
	}
	.fig4 {
		display: grid;
		gap: 8px;
	}
	.list-card {
		display: grid;
		justify-items: start;
		gap: 4px;
		padding: 24px;
		border: 1px solid var(--cl-band-line);
		border-radius: var(--cl-r-card);
		background: var(--cl-band-card);
	}
	.list-title {
		font: var(--cl-title);
		font-variant-numeric: tabular-nums;
	}
	.list-line {
		margin-block: 8px 12px;
		font: var(--cl-body);
	}
	.band-right {
		display: grid;
		align-content: start;
		gap: 16px;
	}
	.rows {
		border-bottom: 1px solid var(--cl-border);
	}
	.none {
		padding-block: 16px;
	}
	@media (max-width: 1023px) {
		.band-in {
			padding-block: var(--cl-s9);
		}
		.band-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 639px) {
		.band-in {
			padding-block: var(--cl-s8);
		}
		.rows :global(.log:nth-child(n + 4)) {
			display: none;
		}
	}

	/* 8. Privacy */
	.privacy {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
		align-items: start;
	}
	.foot-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
		margin-top: 32px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 1023px) {
		.privacy {
			grid-template-columns: 1fr;
		}
	}

	/* 9. Comparison */
	.compare {
		padding: 4px 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.compare table {
		width: 100%;
		border-collapse: collapse;
		font: var(--cl-body);
	}
	.compare th,
	.compare td {
		padding: 16px 16px 16px 0;
		text-align: left;
		vertical-align: top;
	}
	.compare thead th {
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	.compare tbody tr {
		border-top: 1px solid var(--cl-border);
	}
	.compare tbody th {
		width: 24%;
		font: var(--cl-body-strong);
	}
	.compare td {
		color: var(--cl-text-muted);
	}
	.compare td.us {
		color: var(--cl-text);
	}
	.k {
		display: none;
		margin-right: 0.3em;
		color: var(--cl-text-muted);
		font-weight: 600;
	}
	.compare-cap {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin-top: 16px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 639px) {
		.compare {
			padding: 0 16px;
		}
		.compare thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		.compare tr,
		.compare th,
		.compare td {
			display: block;
			width: auto;
		}
		.compare tbody tr {
			padding-block: 16px;
		}
		.compare tbody tr:first-child {
			border-top: 0;
		}
		.compare th,
		.compare td {
			padding: 2px 0;
		}
		.compare tbody th {
			width: auto;
			margin-bottom: 4px;
		}
		.k {
			display: inline;
		}
	}

	/* 10. Plans */
	.prices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 480px));
		justify-content: center;
		gap: 24px;
	}
	.trust {
		max-width: 640px;
		margin: 32px auto 0;
		color: var(--cl-text-muted);
		font: var(--cl-body);
		text-align: center;
	}
	.plan-links {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 12px 32px;
		margin-top: 16px;
	}
	@media (max-width: 1023px) {
		.prices {
			grid-template-columns: minmax(0, 480px);
		}
	}

	/* 11. FAQ */
	.faq-section {
		padding-top: 0;
	}
	.faq {
		max-width: 720px;
		margin-inline: auto;
	}
	.faq h2 {
		margin-bottom: 32px;
		text-align: center;
	}
	details {
		border-top: 1px solid var(--cl-border);
	}
	details:last-child {
		border-bottom: 1px solid var(--cl-border);
	}
	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 64px;
		padding-block: 16px;
		font: var(--cl-body-lg);
		font-weight: 600;
		list-style: none;
		cursor: pointer;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary :global(svg) {
		flex: none;
		transition: transform var(--cl-fast) var(--cl-ease);
	}
	details[open] summary :global(svg) {
		transform: rotate(180deg);
	}
	details p {
		max-width: 68ch;
		padding-bottom: 20px;
		color: var(--cl-text-muted);
	}
</style>
