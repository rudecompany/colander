<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import {
		ACTION_DONE_WORD,
		ACTION_TABLE,
		ColanderMark,
		DEFINITION,
		DEMO_FEED,
		DEMO_POPUP,
		DEMO_THUMBS_NOTE,
		DotField,
		DotMeter,
		DotUnitChart,
		EvidenceCard,
		FeedDemo,
		ITEM_NOUN,
		LogRow,
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
import Lock from '@lucide/svelte/icons/lock';
	import Scale from '@lucide/svelte/icons/scale';
	import Tag from '@lucide/svelte/icons/tag';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Figure from '#lib/components/Figure.svelte';
	import SectionHead from '#lib/components/SectionHead.svelte';
	import SendToComputer from '#lib/components/SendToComputer.svelte';
	import { COMPARISON, COMPARISON_CHECKED, COMPARISON_SCOPE, FAQ, KAPWING, KAPWING_URL } from '#lib/content.ts';
	import { live } from '#lib/live.svelte.ts';

	/* Hero demo: one state drives the frame, the docked popup, the phone feed and the phone popup. */
	const PHONE = [3, 6, 1];
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
		// The phone popup counts the phone feed's items, so it agrees with that frame's badge.
		rows: paused
			? []
			: DEMO_FEED.filter((i) => PHONE.includes(i.id) && i.verdict && demoAction(i, level) !== 'allow').map((i) => ({
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
	const bentoEvidence = $derived(
		evidence({ verdict: 'likely_slop', hidden: true, rows: item6.evidence, listDate, platform: 'yt', sourceId: item6.handle, appealable: true, inertLinks: true })
	);
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

	// On phones the six steps scroll sideways; only then is the list a keyboard stop.
	let bento = $state<HTMLElement>();
	let bentoScrolls = $state(false);
	$effect(() => {
		const el = bento;
		if (!el) return;
		const ro = new ResizeObserver(() => (bentoScrolls = el.scrollWidth > el.clientWidth + 1));
		ro.observe(el);
		return () => ro.disconnect();
	});

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
				<span class="pill-t">{fmtNum(stats.decisions_7d)} verdict {stats.decisions_7d === 1 ? 'change' : 'changes'} published this week</span>
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
			<FeedDemo bind:platform bind:level bind:paused height={696} list={listInfo} {listDate} />
		</div>
		<div class="frame-phone" class:reserved={!phoneFeed}>
			{#if phoneFeed}
				<FeedDemo bind:platform bind:level bind:paused bind:open={openPhone} layout="list" items={PHONE} popup={false} {listDate} />
			{/if}
		</div>
		<noscript><style>.frame-desk{display:block!important}.frame-phone{display:none!important}</style></noscript>

		<div class="control">
			<span class="control-label" aria-hidden="true">Strictness</span>
			<StrictnessControl bind:value={level} size="xl" label="Strictness" hint={false} />
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
			Recreated feed, drawn with the components the extension ships. Pause Colander in the popup to see it without them.
			{DEMO_THUMBS_NOTE}
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
		<div class="plats">
			<p class="free"><InfinityIcon size={16} aria-hidden="true" />Free on all 4 platforms, on every surface below.</p>
			<ul class="platforms" aria-label="Platforms">
				{#each PLATFORMS as p (p)}
					<li>
						<span class="p-name">{PLATFORM_NAME[p]}</span>
						<span class="p-surf">{PLATFORM_SURFACES[p]}</span>
					</li>
				{/each}
			</ul>
		</div>
	</div>
</section>

<!-- 3. Why it exists -->
<section class="cl-section" aria-labelledby="why-title">
	<div class="cl-container why">
		<div class="why-head">
			<SectionHead
				id="why-title"
				eyebrow="Why it exists"
				title="Feeds are filling with slop,"
				title2="and no platform has an off switch."
				lead="Kapwing counted what new accounts were shown first."
			/>
			<p class="source">
				Source: <a href={KAPWING_URL} rel="noreferrer">Kapwing, The TikTok AI Slop Report</a>, data from May 2026. Kapwing classified videos
				by hand and counted only obvious cases, so treat these figures as indicative.
			</p>
		</div>
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
	</div>
</section>

<!-- 4. What counts as slop -->
<section class="cl-section cl-wash" aria-labelledby="def-title">
	<div class="cl-container">
		<div class="slop-top">
			<SectionHead id="def-title" eyebrow="What counts as slop" title="Slop is a production pattern," title2="not a tool." />
			<p class="cl-title-lg statement">{DEFINITION}</p>
		</div>
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
		<!-- The three tests, layers and safeguards, drawn as figures, live on /definition. -->
		<p class="decides"><ArrowLink href="/definition">Read how Colander decides</ArrowLink></p>
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
		<div class="after">
			<ArrowLink href="/definition#strictness">See the full table</ArrowLink>
			<p class="cl-caption muted thumbs-note">Recreated rows from the demo feed. {DEMO_THUMBS_NOTE}</p>
		</div>
	</div>
</section>

<!-- 6. Fair by design -->
<section class="cl-section cl-wash" aria-labelledby="fair-title">
	<div class="cl-container">
		<SectionHead id="fair-title" eyebrow="Fair by design" title="Nothing disappears silently." title2="Every action is explained and reversible." />
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<ol class="bento" bind:this={bento} tabindex={bentoScrolls ? 0 : undefined} aria-label={bentoScrolls ? 'Six steps, scroll sideways for more' : undefined}>
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
				<div class="vis vis-top" inert role="img" aria-label="The Why popover: two evidence layers agreed, the list it came from, Show, Always allow and Not slop, and links to the source page and its appeal.">
					<DotField class="vis-dots" />
					<div class="vis-in pop-demo"><EvidenceCard evidence={bentoEvidence} headingLevel={4} show={noop} allow={noop} notSlop={noop} /></div>
				</div>
				<h3>Every hide says why</h3>
				<p>The signals that agreed, the list and the date.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">04</span>
				<div class="vis" inert role="img" aria-label="A notice that says Skipped 1 slop video, with Undo.">
					<DotField class="vis-dots" />
					<div class="vis-in toast-demo">
						<Toast text="Skipped 1 slop video." verdict="slop" paused actions={[{ label: 'Undo', icon: Undo2, onClick: noop }]} />
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
		<p class="cl-caption muted bento-note">Tiles 01 and 02 show the demo feed. {DEMO_THUMBS_NOTE}</p>
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
					<Figure n={4} version={stats ? fmtListVersion(stats.list_sequence) : null} />
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
		<div class="privacy">
			<SectionHead
				id="privacy-title"
				eyebrow="Private by design"
				title="Matching happens on your device."
				title2="Your browsing stays there."
				lead="Colander never asks a server about the page you are viewing."
			/>
			<div class="privacy-facts">
				<PrivacyFacts compact />
				<p class="foot-line">
					This site sets no cookies, so there is no banner.
					<ArrowLink href="/privacy#permissions">Every permission, and why Colander asks</ArrowLink>
					<ArrowLink href="/privacy">Read the privacy policy</ArrowLink>
				</p>
			</div>
		</div>
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
					<tr>
						<th scope="col">What to check</th>
						<th scope="col">Common in AI blockers</th>
						<th scope="col" class="us"><span class="us-head"><ColanderMark size={16} />Colander</span></th>
					</tr>
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
			Based on {COMPARISON_SCOPE}, checked {fmtShortDate(COMPARISON_CHECKED)}.
			<ArrowLink href="/definition#comparison" size="sm">Sources</ArrowLink>
		</p>
	</div>
</section>

<!-- 10. Plans -->
<section class="cl-section" aria-labelledby="plans-title">
	<div class="cl-container">
		<div class="plans">
			<div class="plans-head">
				<SectionHead id="plans-title" eyebrow="Plans" title="Blocking is free for good." title2="Plus adds control, never influence." />
				<div class="plan-foot">
					<p class="trust">{PLAN_COPY.trust}</p>
					<ArrowLink href="/plans">Compare plans</ArrowLink>
					<ArrowLink href="/support">Support our work</ArrowLink>
				</div>
			</div>
			<div class="prices">
				<PriceCard plan="free" cta={{ href: PUBLIC_STORE_URL }} />
				<PriceCard plan="plus" cta={{ href: '/plans#trial' }} />
			</div>
		</div>
	</div>
</section>

<!-- 11. FAQ -->
<section class="cl-section faq-section" aria-labelledby="faq-title">
	<div class="cl-container faq-wrap">
		<h2 class="cl-display-lg faq-title" id="faq-title">Questions</h2>
		<!-- Two columns on desktop, each its own stack, so opening one question never reflows the other. -->
		<div class="faq">
			{#each [FAQ.slice(0, Math.ceil(FAQ.length / 2)), FAQ.slice(Math.ceil(FAQ.length / 2))] as col, i (i)}
				<div class="faq-col">
					{#each col as f (f.q)}
						<details>
							<summary>{f.q}<ChevronDown size={16} aria-hidden="true" /></summary>
							<p>{f.a}</p>
						</details>
					{/each}
				</div>
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
		padding-bottom: var(--cl-s8);
	}
	.hero-copy {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}
	/* 32 tall on one line; on the narrowest phones it grows to two lines rather than spill. */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 32px;
		padding: 5px 14px;
		line-height: 20px;
		border: 1px solid var(--cl-border-strong);
		border-radius: var(--cl-r-full);
		background: var(--cl-surface);
		color: var(--cl-text);
		font: var(--cl-body-strong);
		text-decoration: none;
	}
	.pill-t {
		text-wrap: balance;
	}
	.pill :global(svg) {
		flex: none;
	}
	.pill:hover {
		background: color-mix(in srgb, var(--cl-text) 6%, var(--cl-surface));
	}
	h1 {
		max-width: 800px;
		margin-top: 20px;
	}
	.lead {
		max-width: 640px;
		margin-top: 16px;
		color: var(--cl-text-muted);
	}
	.ctas {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 16px 24px;
		margin-top: 28px;
	}
	.phone {
		display: none;
	}
	.version {
		margin-top: 12px;
		color: var(--cl-text-muted);
	}
	.proof {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px 24px;
		margin-top: 12px;
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
		margin-top: 32px;
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
		margin-top: 20px;
	}
	.control-label {
		color: var(--cl-text-muted);
		font: var(--cl-body-strong);
		line-height: 44px;
	}
	.caption {
		max-width: 720px;
		margin-top: 12px;
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
	/* The docked popup shows while the frame is at least 900 wide (a 948 window); below that the
	   page shows the popup under the frame, and its control drives the feed. */
	@media (max-width: 947px) {
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
	.plats {
		display: grid;
		gap: 16px;
		padding-block: 24px;
		border-top: 1px solid var(--cl-border);
	}
	.free {
		display: flex;
		align-items: center;
		gap: 8px;
		font: var(--cl-body-strong);
	}
	.free :global(svg) {
		flex: none;
	}
	.platforms {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 24px;
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
		.plats {
			padding-block: 16px;
		}
		.platforms {
			gap: 16px 12px;
		}
	}

	/* 3. Why it exists: the head and its source beside the three charts on desktop. */
	.why {
		display: grid;
		grid-template-columns: 4fr 8fr;
		gap: 48px;
		align-items: start;
	}
	.why-head :global(.head) {
		margin-bottom: 0;
	}
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
		margin-top: 24px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 1023px) {
		.why {
			grid-template-columns: minmax(0, 1fr);
			gap: 32px;
		}
		.why-head :global(.head) {
			margin-bottom: 0;
		}
	}
	@media (max-width: 639px) {
		.charts {
			grid-template-columns: 1fr;
			gap: 32px;
		}
		.chart.first .chart-art :global(svg) {
			width: min(100%, 300px);
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
	.slop-top {
		display: grid;
		grid-template-columns: 5fr 7fr;
		gap: 24px;
		align-items: start;
		margin-bottom: 48px;
	}
	.slop-top :global(.head) {
		margin-bottom: 0;
	}
	.statement {
		padding-top: 28px;
		text-wrap: pretty;
	}
	@media (max-width: 1023px) {
		.slop-top {
			grid-template-columns: minmax(0, 1fr);
			gap: 24px;
			margin-bottom: 40px;
		}
		.statement {
			padding-top: 0;
		}
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
		width: 104px;
		height: 104px;
	}
	.specimen :global(.disc .dots) {
		background-image: radial-gradient(var(--cl-dot-strong) 1px, transparent 1.2px);
		background-size: 10px 10px;
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
		margin-top: 32px;
	}
	@media (max-width: 1023px) {
		.specimens {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			row-gap: 40px;
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
		padding: 20px;
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
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 24px;
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
		/* Phones: each level is a compact row, its name, what it does and its counts. */
		.level {
			gap: 4px;
			padding: 16px;
		}
		.level :global(.mini),
		.thumbs-note {
			display: none;
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
		grid-template-rows: auto 152px auto 1fr;
		align-content: start;
		gap: 12px;
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
	/* Each picture spans the tile's full width, so the notice in 04 stays on one line and the bar in
	   02 keeps "Hidden for you", as they do on a host page. */
	.vis {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		place-items: center;
		margin-inline: -24px;
		overflow: hidden;
		container-type: inline-size;
	}
	.vis :global(.vis-dots) {
		position: absolute;
		inset: 0;
	}
	/* Tile 03 shows the whole popover from its top and crops it with a fade, rather than trimming it. */
	.vis-top {
		place-items: start center;
		padding-top: 16px;
		mask-image: linear-gradient(to bottom, black calc(100% - 40px), transparent);
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
	.bento-note {
		margin-top: 16px;
	}
	/* Only tile 03's popover floats; the notice sits flat in its picture. */
	.toast-demo :global(.cl-toast) {
		max-width: 100%;
		margin-inline: auto;
		box-shadow: none;
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
	/* Phones: the six steps are one row that scrolls sideways and snaps to each tile, the next one
	   peeking in, with the perforated connector between their numbers. */
	@media (max-width: 639px) {
		.bento {
			grid-template-columns: none;
			grid-auto-columns: 86%;
			grid-auto-flow: column;
			gap: 12px;
			max-width: none;
			margin-inline: -16px;
			padding: 0 16px 4px;
			overflow-x: auto;
			overscroll-behavior-x: contain;
			scroll-snap-type: x mandatory;
			scroll-padding-inline: 16px;
			scrollbar-width: none;
		}
		.tile {
			grid-template-rows: auto 152px auto 1fr;
			gap: 8px;
			padding: 16px;
			scroll-snap-align: start;
		}
		.vis {
			margin-inline: -16px;
		}
		.tile:not(:last-child)::after {
			top: 24px;
			right: -13px;
			bottom: auto;
			left: auto;
			width: 12px;
			height: 3px;
			background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 8px 3px repeat-x;
		}
	}

	/* 7. Open by default */
	/* In dark the band is a lifted tone, and hairlines mark its edges beside the perforations. */
	.band {
		border-block: 1px solid var(--cl-band-line);
	}
	.band-edge {
		--cl-dot: var(--cl-dot-strong);
	}
	.band-in {
		padding-block: 80px;
	}
	.band-grid {
		display: grid;
		grid-template-columns: 4fr 8fr;
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
			padding-block: var(--cl-s8);
		}
		.band-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 639px) {
		.band-in {
			padding-block: var(--cl-s7);
		}
		.rows :global(.log:nth-child(n + 4)) {
			display: none;
		}
		.list-card .list-line {
			display: none;
		}
	}

	/* 8. Privacy: the head beside the facts on desktop. */
	.privacy {
		display: grid;
		grid-template-columns: 5fr 7fr;
		gap: 24px;
		align-items: start;
	}
	.privacy-facts {
		padding-top: 28px;
	}
	@media (max-width: 1023px) {
		.privacy {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		.privacy-facts {
			padding-top: 0;
		}
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

	/* 9. Comparison */
	.compare {
		overflow: hidden;
		padding-left: 24px;
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
		padding: 10px 16px 10px 0;
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
	.compare .us {
		padding-inline: 16px 24px;
		background: var(--cl-wash);
		color: var(--cl-text);
	}
	.us-head {
		display: inline-flex;
		align-items: center;
		gap: 6px;
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
		.compare .us {
			margin-top: 4px;
			padding: 4px 8px;
			border-radius: var(--cl-r-chip);
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

	/* 10. Plans: the head, the trust line and the links beside the two cards on desktop. */
	.plans {
		display: grid;
		grid-template-columns: 4fr 8fr;
		gap: 48px;
		align-items: start;
	}
	.plans-head :global(.head) {
		margin-bottom: 0;
	}
	@media (max-width: 1023px) {
		.plans {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		.plans-head {
			display: contents;
		}
		.plans-head :global(.head) {
			margin-bottom: var(--cl-s6);
		}
		.plan-foot {
			order: 3;
		}
	}
	.prices {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
	}
	.plan-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 32px;
		margin-top: 24px;
	}
	@media (max-width: 639px) {
		.plans-head :global(.head) {
			margin-bottom: var(--cl-s5);
		}
	}
	.trust {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 767px) {
		.prices {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* 11. FAQ */
	.faq-section {
		padding-top: 0;
	}
	/* The heading beside the questions on desktop. */
	.faq-wrap {
		display: grid;
		grid-template-columns: 4fr 8fr;
		gap: 48px;
		align-items: start;
	}
	@media (max-width: 1023px) {
		.faq-wrap {
			grid-template-columns: minmax(0, 1fr);
			gap: 24px;
		}
	}
	.faq {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 24px;
		align-items: start;
	}
	details {
		border-top: 1px solid var(--cl-border);
	}
	details:last-child {
		border-bottom: 1px solid var(--cl-border);
	}
	@media (max-width: 1023px) {
		.faq {
			grid-template-columns: minmax(0, 1fr);
		}
		.faq-col + .faq-col details:first-child {
			border-top: 0;
		}
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
