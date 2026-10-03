<script lang="ts">
	import { onMount } from 'svelte';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import {
		ACTION_TABLE,
		SIGNAL_TEXT,
		STRICTNESS,
		STRICTNESS_WORD,
		VerdictChip,
		VERDICTS,
		VERDICT_WORD,
		type Action,
		type Verdict
	} from '@colander/shared';
	import type { LogResponse, Stats } from '@colander/shared/api';
	import Plus from '@lucide/svelte/icons/plus';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Eye from '@lucide/svelte/icons/eye';
	import Info from '@lucide/svelte/icons/info';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import Tag from '@lucide/svelte/icons/tag';
	import Scale from '@lucide/svelte/icons/scale';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Check from '@lucide/svelte/icons/check';
	import Minus from '@lucide/svelte/icons/minus';
	import FeedDemo from '#lib/components/FeedDemo.svelte';
	import PerforatedDisc from '#lib/components/PerforatedDisc.svelte';
	import Thumb from '#lib/components/Thumb.svelte';
	import LogEntryView from '#lib/components/LogEntryView.svelte';
	import { ColanderMark } from '@colander/shared';
	import { api } from '#lib/api.ts';
	import { fmtNum } from '#lib/format.ts';

	const shares = [
		{ label: 'TikTok For You feed', note: 'first 500 videos', value: 59, text: '59%' },
		{ label: 'TikTok Kids category', note: '2,000 videos', value: 57.4, text: '57.4%' },
		{ label: 'TikTok Science and Education', note: '', value: 35, text: '35.0%' },
		{ label: 'TikTok Health', note: '', value: 33.8, text: '33.8%' },
		{ label: 'TikTok History', note: '', value: 33.5, text: '33.5%' },
		{ label: 'YouTube Shorts feed', note: 'first 500 videos', value: 21, text: '21%' }
	];

	const tests = [
		{ name: 'Low effort', q: 'Is there little sign of human authorship, such as original footage, commentary, editing judgment or fact-checking?' },
		{ name: 'Mass-produced', q: 'Does the source publish at a volume and sameness that points to an automated pipeline?' },
		{ name: 'Hollow', q: 'Does it look competent while carrying little information, containing errors, or existing mainly to hold attention or push a link?' }
	];

	const layers = [
		{ n: 1, name: 'Provenance', q: 'Is it AI-generated?', s: 'AI labels the platform shows, Content Credentials, the creator’s own statement, a visible generator watermark.' },
		{ n: 2, name: 'Source behavior', q: 'Is it mass-produced?', s: 'Uploads per day, the share of recent items with AI evidence, near-identical titles and thumbnails, link funnels.' },
		{ n: 3, name: 'Content rubric', q: 'Is it low effort and hollow?', s: 'Taggers answer three questions: is it useful, accurate and original. Plus checks for filler and repetition.' },
		{ n: 4, name: 'Community consensus', q: 'Do people who usually disagree both call it slop?', s: 'Tags and counter-tags, weighted by each tagger’s track record. Creator appeals count here too.' }
	];

	const verdictRows: { v: Verdict; evidence: string; action: string }[] = [
		{ v: 'slop', evidence: 'AI evidence, plus a mass-produced source, plus community consensus or staff review', action: 'Hide' },
		{ v: 'likely_slop', evidence: 'AI evidence, plus behavior or rubric signals, with consensus still forming', action: 'Collapse, with the reason shown' },
		{ v: 'ai_made', evidence: 'AI evidence only', action: 'Label' },
		{ v: 'disputed', evidence: 'Tags and counter-tags split, or an appeal is open', action: 'Show, with a disputed mark' },
		{ v: 'clear', evidence: '“Not slop” consensus or a successful appeal', action: 'Allow' }
	];

	const ACTION_WORD: Record<Action, string> = { hide: 'Hide', collapse: 'Collapse', label: 'Label', allow: 'Allow' };
	const ACTION_ICON = { hide: EyeOff, collapse: ChevronsDownUp, label: Tag, allow: Eye };

	let latest = $state<LogResponse['entries']>([]);
	let stats = $state<Stats | null>(null);

	onMount(() => {
		api<LogResponse>('/v1/log?limit=3').then((r) => (latest = r.entries.slice(0, 3)), () => {});
		api<Stats>('/v1/stats').then((s) => (stats = s), () => {});
	});

	const listed = $derived(stats ? VERDICTS.reduce((n, v) => n + (v === 'clear' ? 0 : stats!.sources[v]), 0) : 0);
</script>

<svelte:head>
	<title>Colander: drain the slop from your feed</title>
	<meta
		name="description"
		content="Colander is a Chrome extension that hides AI slop on YouTube, TikTok, Instagram and Facebook the way an ad blocker hides ads, from shared lists with public evidence, appeals and a decision log."
	/>
</svelte:head>

<section class="hero">
	<div class="wrap hero-grid">
		<div class="hero-copy">
			<p class="eyebrow">A Chrome extension for YouTube, TikTok, Instagram and Facebook</p>
			<h1 class="t-hero"><span>Drain the slop.</span> <span>Keep the substance.</span></h1>
			<p class="t-lede">
				Colander hides AI slop in your feeds the way an ad blocker hides ads. It works from shared, signed lists built
				from community tags, says why it acted, and lets any creator appeal.
			</p>
			<div class="cta">
				<a class="uin-btn uin-btn-primary btn-lg" href={PUBLIC_STORE_URL}>
					<Plus size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>Add to Chrome, free</span>
				</a>
				<a class="uin-btn uin-btn-outline btn-lg" href="/definition">
					<span>Read the definition</span>
					<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
				</a>
			</div>
			<p class="t-body muted">No account needed. Matching happens on your device.</p>
		</div>
		<div class="hero-demo">
			<PerforatedDisc size={640} class="hero-disc" />
			<FeedDemo />
		</div>
	</div>
</section>

<section class="section" id="why" aria-labelledby="why-title">
	<div class="wrap why-grid">
		<div class="section-head">
			<p class="eyebrow">Why it exists</p>
			<h2 class="t-display" id="why-title">Feeds are filling with slop, and no platform has an off switch.</h2>
			<p class="t-lede">
				Platform controls reduce AI content at best. The one place a person can enforce none is their own browser, and
				that takes a viewer-side tool that does not wait for a platform to decide slop breaks a rule.
			</p>
		</div>
		<figure class="chart card">
			<figcaption>
				<p class="t-title">Share of what a new account is shown that was AI slop</p>
			</figcaption>
			<table class="bars">
				<thead class="sr-only">
					<tr><th scope="col">Feed or category</th><th scope="col">Share that was AI slop</th></tr>
				</thead>
				<tbody>
					{#each shares as row (row.label)}
						<tr>
							<th scope="row">
								{row.label}{#if row.note}<span class="note">, {row.note}</span>{/if}
							</th>
							<td>
								<span class="track" aria-hidden="true"><span class="fill" style:width="{row.value}%"></span></span>
								<span class="value cl-num">{row.text}</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="source t-caption muted">
				Source: <a href="https://www.kapwing.com/resources/the-tiktok-ai-slop-report/" rel="noreferrer">Kapwing, The TikTok AI Slop Report</a>,
				data from May 2026. Kapwing sells video editing tools and classified videos by hand, counting only obvious cases,
				so treat these as indicative.
			</p>
		</figure>
	</div>
</section>

<section class="section" id="definition" aria-labelledby="def-title">
	<div class="wrap">
		<div class="section-head">
			<p class="eyebrow">What slop is</p>
			<h2 class="t-display" id="def-title">Slop is a production pattern, not a tool.</h2>
		</div>
		<blockquote class="definition">
			<p>
				AI slop is AI-generated content that is mass-produced with little human effort to capture attention or money, and
				that gives the viewer little in return. AI use alone never makes something slop.
			</p>
		</blockquote>
		<p class="tests-intro t-body-lg">An item or source is slop when it is AI-generated and meets at least two of three tests.</p>
		<ol class="tests">
			{#each tests as t, i (t.name)}
				<li class="card">
					<span class="num cl-num" aria-hidden="true">{i + 1}</span>
					<h3 class="t-title">{t.name}</h3>
					<p class="t-body muted">{t.q}</p>
				</li>
			{/each}
		</ol>
		<div class="not-slop card-raised">
			<h3 class="t-title">What is not slop</h3>
			<ul>
				<li>AI-assisted work with clear human authorship, such as AI used for editing, captions, dubbing or illustration.</li>
				<li>Openly artificial art, satire, parody and political expression.</li>
				<li>Low-quality human-made content. It may be bad, but it is out of scope.</li>
				<li>Deepfakes, fraud and abuse. These are harms beyond slop and belong with platform and legal reporting.</li>
			</ul>
			<a class="more" href="/definition">Read the full definition and tagging rubric <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
		</div>
	</div>
</section>

<section class="section" id="how" aria-labelledby="how-title">
	<div class="wrap">
		<div class="section-head">
			<p class="eyebrow">How it decides</p>
			<h2 class="t-display" id="how-title">Four layers of evidence. Two must agree before anything is hidden.</h2>
			<p class="t-lede">
				No AI detector acts as judge. Detectors lose about half their accuracy on real social media and flag the wrong
				people, so Colander weighs evidence that anyone can check.
			</p>
		</div>
		<ol class="layers">
			{#each layers as l (l.n)}
				<li class="layer card">
					<p class="layer-n cl-num">Layer {l.n}</p>
					<h3 class="t-title">{l.name}</h3>
					<p class="layer-q">{l.q}</p>
					<p class="t-body muted">{l.s}</p>
				</li>
			{/each}
		</ol>
		<ul class="rules">
			<li><strong>AI evidence is a gate.</strong> Without it, nothing can be rated slop, however low its quality.</li>
			<li><strong>Mixed sources are never hidden whole.</strong> Their AI items get item-level labels instead.</li>
			<li><strong>Large sources need staff review</strong> before a list-wide Slop verdict.</li>
			<li><strong>Verdicts expire.</strong> Sources are re-scored every 90 days, and at once when an appeal opens.</li>
		</ul>

		<div class="verdicts card">
			<h3 class="t-title">Five verdicts, and what each one does on Standard</h3>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead>
						<tr><th scope="col">Verdict</th><th scope="col">Evidence required</th><th scope="col">Default action</th></tr>
					</thead>
					<tbody>
						{#each verdictRows as r (r.v)}
							<tr>
								<th scope="row"><VerdictChip verdict={r.v} /></th>
								<td data-label="Evidence">{r.evidence}</td>
								<td data-label="On Standard">{r.action}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</div>
</section>

<section class="section" id="see" aria-labelledby="see-title">
	<div class="wrap">
		<div class="section-head">
			<p class="eyebrow">What you see</p>
			<h2 class="t-display" id="see-title">Nothing disappears silently.</h2>
			<p class="t-lede">
				Each verdict gets one of three treatments, set by the strictness you choose. Every one is counted, explained and
				one click away from undone.
			</p>
		</div>
		<div class="treatments">
			<article class="card treatment">
				<div class="specimen">
					<div class="spec-thumb">
						<Thumb art={2} />
						<span class="on-media"><VerdictChip verdict="ai_made" tone="ink" /></span>
					</div>
				</div>
				<h3 class="icon-line t-title"><Tag size={16} strokeWidth={1.75} aria-hidden="true" /> Label</h3>
				<p class="t-body muted">A small chip on the thumbnail, or beside the creator name in a swipe feed. Nothing is removed.</p>
			</article>
			<article class="card treatment">
				<div class="specimen">
					<div class="spec-bar">
						<VerdictChip verdict="likely_slop" />
						<span class="spec-reason">Mass-produced, AI-made</span>
						<span class="spec-link">Show</span>
						<span class="spec-link">Why</span>
					</div>
				</div>
				<h3 class="icon-line t-title"><ChevronsDownUp size={16} strokeWidth={1.75} aria-hidden="true" /> Collapse</h3>
				<p class="t-body muted">The card shrinks to one line with the verdict and the reason. In swipe feeds the video waits, paused, for Show or Skip.</p>
			</article>
			<article class="card treatment">
				<div class="specimen">
					<div class="spec-notice">
						<span>Skipped 1 slop video.</span>
						<span class="spec-link"><Undo2 size={14} strokeWidth={1.75} aria-hidden="true" /> Undo</span>
					</div>
				</div>
				<h3 class="icon-line t-title"><EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> Hide</h3>
				<p class="t-body muted">The card is removed and the grid closes up. The toolbar count goes up, and the popup lists it with Show beside it.</p>
			</article>
		</div>

		<div class="strictness card">
			<div class="strictness-head">
				<h3 class="t-title">Four strictness levels. You choose.</h3>
				<p class="t-body muted">Standard is preselected. The product never decides what an adult may see.</p>
			</div>
			<div class="table-scroll">
				<table class="plain levels stack-sm">
					<thead>
						<tr>
							<th scope="col">Level</th>
							<th scope="col"><VerdictChip verdict="slop" /></th>
							<th scope="col"><VerdictChip verdict="likely_slop" /></th>
							<th scope="col"><VerdictChip verdict="ai_made" /></th>
						</tr>
					</thead>
					<tbody>
						{#each STRICTNESS as s (s)}
							<tr class:default={s === 'standard'}>
								<th scope="row">{STRICTNESS_WORD[s]}{#if s === 'standard'}<span class="default-tag">Default</span>{/if}</th>
								{#each ['slop', 'likely_slop', 'ai_made'] as const as v (v)}
									{@const a = ACTION_TABLE[s][v]}
									{@const Icon = ACTION_ICON[a]}
									<td data-label={VERDICT_WORD[v]}><span class="icon-line"><Icon size={14} strokeWidth={1.75} aria-hidden="true" /> {ACTION_WORD[a]}</span></td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="t-caption muted">Disputed items are always shown with a mark, and Clear items are always allowed.</p>
		</div>
	</div>
</section>

<section class="section" id="fair" aria-labelledby="fair-title">
	<div class="wrap fair-grid">
		<div>
			<div class="section-head">
				<p class="eyebrow">Fair to creators</p>
				<h2 class="t-display" id="fair-title">Labels describe content, never people.</h2>
				<p class="t-lede">
					The gravest risk is hiding a real creator’s work by mistake, so most of the design exists to prevent it, and to
					fix it fast when it happens.
				</p>
			</div>
			<ul class="fair-list">
				<li>
					<span class="fair-icon"><Info size={16} strokeWidth={1.75} aria-hidden="true" /></span>
					<div><h3>Explained</h3><p>Every hidden item states which signals fired, and one click shows it.</p></div>
				</li>
				<li>
					<span class="fair-icon"><Undo2 size={16} strokeWidth={1.75} aria-hidden="true" /></span>
					<div>
						<h3>Reversible</h3>
						<p>Show reveals an item once. Always allow overrides every list for you. Not slop files a counter-tag.</p>
					</div>
				</li>
				<li>
					<span class="fair-icon"><Scale size={16} strokeWidth={1.75} aria-hidden="true" /></span>
					<div>
						<h3>Open to appeal</h3>
						<p>
							A creator proves the account is theirs with a short code in its description. The verdict changes to Disputed,
							and nothing from the source is hidden while staff review.
						</p>
					</div>
				</li>
				<li>
					<span class="fair-icon"><Check size={16} strokeWidth={1.75} aria-hidden="true" /></span>
					<div><h3>On the record</h3><p>The outcome and the reasoning are published in the decision log.</p></div>
				</li>
			</ul>
		</div>
		<div class="why-specimen cl-dots" aria-label="Example of the Why popover" role="figure">
			<div class="pop why-pop">
				<p class="why-pop-title">Why this is hidden</p>
				<p class="why-pop-chip"><VerdictChip verdict="slop" /></p>
				<ul>
					<li>{SIGNAL_TEXT.platform_label}</li>
					<li>{SIGNAL_TEXT.high_volume}</li>
					<li>{SIGNAL_TEXT.community_consensus}</li>
				</ul>
				<p class="why-pop-meta">Core list, updated 2 October 2026</p>
				<p class="why-pop-links"><span>Source page</span><span>Is this your channel? Appeal this verdict.</span></p>
			</div>
		</div>
	</div>
</section>

<section class="section" id="privacy" aria-labelledby="privacy-title">
	<div class="wrap">
		<div class="section-head">
			<p class="eyebrow">Private by design</p>
			<h2 class="t-display" id="privacy-title">Matching happens on your device.</h2>
			<p class="t-lede">
				Colander downloads a signed list and checks each card against it locally, like an ad blocker. It never asks a
				server about the page you are on, and blocking keeps working offline.
			</p>
		</div>
		<div class="privacy-grid">
			<div class="card">
				<h3 class="t-title">What leaves your device</h3>
				<ul class="ticks">
					<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>List downloads, which carry no identifier at all.</span></li>
					<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>Tags and reports you choose to send: the platform, the item or source, your verdict, and a random install ID.</span></li>
					<li><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>For Plus, a signed plan token and your synced settings.</span></li>
				</ul>
			</div>
			<div class="card">
				<h3 class="t-title">What never does</h3>
				<ul class="ticks never">
					<li><Minus size={16} strokeWidth={1.75} aria-hidden="true" /><span>The pages you visit, or their addresses.</span></li>
					<li><Minus size={16} strokeWidth={1.75} aria-hidden="true" /><span>Your account names on YouTube, TikTok, Instagram or Facebook.</span></li>
					<li><Minus size={16} strokeWidth={1.75} aria-hidden="true" /><span>Your watch history or browsing history.</span></li>
				</ul>
			</div>
		</div>
		<p class="after-link"><a href="/privacy">Read the privacy notice</a></p>
	</div>
</section>

<section class="section" id="open" aria-labelledby="open-title">
	<div class="wrap open-grid">
		<div class="section-head">
			<p class="eyebrow">Open list, open log</p>
			<h2 class="t-display" id="open-title">Every decision is public.</h2>
			<p class="t-lede">
				Each verdict change writes an entry to the decision log: what changed, who decided and which signals fired.
				Anyone can look up a source, read its evidence and audit the reasoning.
			</p>
			{#if stats}
				<dl class="open-stats">
					<div><dt>Sources with a verdict</dt><dd>{fmtNum(listed)}</dd></div>
					<div><dt>Decisions in the last 7 days</dt><dd>{fmtNum(stats.decisions_7d)}</dd></div>
				</dl>
			{/if}
			<p><a class="uin-btn uin-btn-outline btn-lg" href="/log"><span>Open the decision log</span><ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></a></p>
		</div>
		<div class="latest card" aria-label="Latest decisions">
			{#if latest.length}
				<p class="latest-head t-caption muted">Latest decisions</p>
				{#each latest as e (e.id)}<LogEntryView entry={e} />{/each}
			{:else}
				<div class="latest-empty cl-dots">
					<p class="t-body muted">The latest decisions appear here as they are made.</p>
				</div>
			{/if}
		</div>
	</div>
</section>

<section class="section" id="plans" aria-labelledby="plans-title">
	<div class="wrap">
		<div class="section-head">
			<p class="eyebrow">Plans</p>
			<h2 class="t-display" id="plans-title">Blocking is free for good.</h2>
			<p class="t-lede">
				Paying buys convenience and control, never influence. No creator, platform or advertiser can pay to leave a list
				or join an allowlist.
			</p>
		</div>
		<div class="plan-teaser">
			<div class="card">
				<p class="t-title">Free</p>
				<p class="price"><span class="amount">$0</span></p>
				<p class="t-body muted">
					Blocking on every supported platform with the core list, all four strictness levels, tagging, reporting and
					appeals.
				</p>
			</div>
			<div class="card">
				<p class="t-title">Plus</p>
				<p class="price"><span class="amount">$30</span> a year <span class="muted">or $3 a month</span></p>
				<p class="t-body muted">
					Everything in Free, plus sync across browsers, strictness per platform and topic, keyword and hashtag rules, and
					a weekly summary.
				</p>
			</div>
			<div class="plan-link">
				<a class="uin-btn uin-btn-outline btn-lg" href="/plans"><span>Compare plans</span><ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></a>
			</div>
		</div>
	</div>
</section>

<section class="section install" aria-labelledby="install-title">
	<div class="wrap">
		<div class="install-card">
			<div class="install-copy">
				<h2 class="t-display" id="install-title">Install once. Change nothing.</h2>
				<p class="t-lede">Standard is preselected. Open YouTube or TikTok and the toolbar starts counting within a minute.</p>
				<p>
					<a class="uin-btn uin-btn-primary btn-lg" href={PUBLIC_STORE_URL}>
						<Plus size={16} strokeWidth={1.75} aria-hidden="true" />
						<span>Add to Chrome, free</span>
					</a>
				</p>
				<p class="t-body muted">For Chrome on desktop. Native mobile apps are out of reach for any browser extension.</p>
			</div>
			<div class="install-art" aria-hidden="true">
				<PerforatedDisc size={360} rings={6} />
				<span class="install-mark"><ColanderMark size={56} /></span>
			</div>
		</div>
	</div>
</section>

<style>
	/* Hero */
	.hero {
		position: relative;
		overflow: hidden;
		padding-block: 72px 32px;
	}
	.hero-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 540px);
		gap: 64px;
		align-items: center;
	}
	.hero-copy {
		display: grid;
		gap: var(--cl-s5);
		align-content: center;
	}
	.hero-copy .t-hero span {
		display: block;
	}
	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s3);
		margin-top: var(--cl-s2);
	}
	.hero-demo {
		position: relative;
	}
	.hero-demo :global(.hero-disc) {
		position: absolute;
		right: -200px;
		top: -150px;
		z-index: 0;
		pointer-events: none;
		opacity: 0.7;
	}
	.hero-demo :global(.demo) {
		position: relative;
		z-index: 1;
	}

	/* Why */
	.why-grid {
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
		gap: 64px;
		align-items: start;
	}
	.why-grid .section-head {
		margin-bottom: 0;
	}
	.chart {
		display: grid;
		gap: var(--cl-s5);
		margin: 0;
	}
	.bars {
		width: 100%;
		border-collapse: collapse;
	}
	.bars th {
		text-align: left;
		font: 600 14px/20px var(--cl-font);
		padding: 0 0 6px;
	}
	.bars .note {
		font-weight: 400;
		color: var(--cl-text-muted);
	}
	.bars tr {
		display: grid;
		padding-block: 8px;
	}
	.bars td {
		display: flex;
		align-items: center;
		gap: var(--cl-s3);
		padding: 0;
	}
	.track {
		position: relative;
		flex: 1;
		height: 14px;
		background-image: radial-gradient(circle, var(--cl-border) 1.5px, transparent 1.9px);
		background-size: 8px 14px;
		background-position: left center;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--cl-text);
		border-radius: 0 3px 3px 0;
	}
	.value {
		width: 52px;
		text-align: right;
		font: 700 16px/24px var(--cl-font);
	}

	/* Definition */
	.definition {
		max-width: 920px;
		padding-left: var(--cl-s5);
		border-left: 3px solid var(--cl-text);
		font: 400 24px/36px var(--cl-font);
		letter-spacing: -0.005em;
		text-wrap: pretty;
	}
	.tests-intro {
		margin: var(--cl-s6) 0 var(--cl-s4);
		font-weight: 600;
	}
	.tests {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--cl-s4);
	}
	.tests li {
		display: grid;
		gap: var(--cl-s2);
		align-content: start;
	}
	.num {
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 1.5px solid var(--cl-text);
		font: 700 14px/1 var(--cl-font);
		margin-bottom: var(--cl-s2);
	}
	.not-slop {
		margin-top: var(--cl-s4);
		display: grid;
		gap: var(--cl-s3);
	}
	.not-slop ul {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s2) var(--cl-s6);
		padding-left: 20px;
		font: var(--cl-body);
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 600 14px/20px var(--cl-font);
		justify-self: start;
	}

	/* How */
	.layers {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--cl-s4);
	}
	.layer {
		display: grid;
		gap: var(--cl-s2);
		align-content: start;
		border-top: 3px solid var(--cl-text);
	}
	.layer-n {
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}
	.layer-q {
		font: 600 15px/22px var(--cl-font);
	}
	.rules {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--cl-s4);
		margin: var(--cl-s5) 0 var(--cl-s6);
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	.rules li {
		padding-top: var(--cl-s3);
		border-top: 1px dashed var(--w-control-border);
	}
	.rules strong {
		color: var(--cl-text);
		font-weight: 600;
	}
	.verdicts {
		display: grid;
		gap: var(--cl-s3);
	}
	.verdicts th[scope='row'] {
		width: 160px;
	}

	/* What you see */
	.treatments {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--cl-s4);
	}
	.treatment {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--cl-s2);
		align-content: start;
	}
	.specimen {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		place-items: center;
		height: 148px;
		margin-bottom: var(--cl-s3);
		border-radius: var(--cl-r-chip);
		background: var(--cl-paper);
		padding: var(--cl-s4);
	}
	.spec-thumb {
		position: relative;
		width: 176px;
		aspect-ratio: 16 / 9;
	}
	.on-media {
		position: absolute;
		left: 6px;
		top: 6px;
	}
	.spec-bar {
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 40px;
		padding: 0 10px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface-raised);
		font: var(--cl-caption);
	}
	.spec-reason {
		flex: 1;
		color: var(--cl-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.spec-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--cl-brand);
		font-weight: 600;
	}
	.spec-notice {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 10px 14px;
		border-radius: var(--cl-r-card);
		background: var(--cl-ink);
		color: #f2f0eb;
		font: var(--cl-body);
		/* Keeps the ink notice's edge visible on the dark theme too. */
		box-shadow: 0 0 0 1px rgb(242 240 235 / 0.16);
	}
	.spec-notice .spec-link {
		color: #8fb8f0;
	}
	.strictness {
		margin-top: var(--cl-s4);
		display: grid;
		gap: var(--cl-s3);
	}
	.strictness-head {
		display: grid;
		gap: 2px;
	}
	.levels {
		table-layout: fixed;
		min-width: 520px;
	}
	.levels thead th:first-child {
		width: 34%;
	}
	.levels th[scope='row'] {
		color: var(--cl-text);
		white-space: nowrap;
	}
	.levels tr.default th,
	.levels tr.default td {
		background: var(--cl-paper);
	}
	.levels th:first-child,
	.levels td:first-child {
		padding-left: 12px;
	}
	.default-tag {
		margin-left: 8px;
		padding: 1px 6px;
		border-radius: var(--cl-r-chip);
		border: 1px solid var(--w-control-border);
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}

	/* Fair */
	.fair-grid {
		display: grid;
		grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
		gap: 64px;
		align-items: center;
	}
	.fair-list {
		list-style: none;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s5);
	}
	.fair-list li {
		display: flex;
		gap: var(--cl-s3);
	}
	.fair-icon {
		flex: none;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
	}
	.fair-list h3 {
		font: 600 16px/24px var(--cl-font);
	}
	.fair-list p {
		font: var(--cl-body);
		color: var(--cl-text-muted);
		margin-top: 2px;
	}
	.why-specimen {
		display: grid;
		place-items: center;
		padding: 56px var(--cl-s6);
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
	}
	.why-pop {
		width: min(100%, 340px);
		padding: var(--cl-s4) var(--cl-s5);
		display: grid;
		gap: var(--cl-s2);
		font: var(--cl-body);
	}
	.why-pop-title {
		font-weight: 700;
	}
	.why-pop ul {
		padding-left: 18px;
		display: grid;
		gap: 2px;
	}
	.why-pop-meta {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.why-pop-links {
		display: grid;
		gap: 2px;
		padding-top: var(--cl-s2);
		border-top: 1px solid var(--cl-border);
		color: var(--cl-brand);
		font-weight: 600;
	}

	/* Privacy */
	.privacy-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s4);
	}
	.privacy-grid .card {
		display: grid;
		gap: var(--cl-s3);
		align-content: start;
	}
	.ticks {
		list-style: none;
		display: grid;
		gap: var(--cl-s3);
		font: var(--cl-body);
	}
	.ticks li {
		display: flex;
		gap: 10px;
	}
	.ticks :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.after-link {
		margin-top: var(--cl-s4);
		font: 600 14px/20px var(--cl-font);
	}

	/* Open */
	.open-grid {
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
		gap: 64px;
		align-items: start;
	}
	.open-grid .section-head {
		margin-bottom: 0;
	}
	.open-stats {
		display: flex;
		gap: var(--cl-s6);
		margin-block: var(--cl-s2);
	}
	.open-stats dt {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.open-stats dd {
		font: var(--cl-display);
	}
	.latest {
		padding-block: var(--cl-s3) 0;
	}
	.latest-head {
		padding-bottom: 4px;
	}
	.latest :global(.entry + .entry) {
		border-top: 1px solid var(--cl-border);
	}
	.latest :global(.entry) {
		grid-template-columns: 1fr;
		padding-block: var(--cl-s4);
	}
	.latest :global(.entry .when) {
		display: flex;
		gap: 8px;
	}
	.latest-empty {
		min-height: 240px;
		display: grid;
		place-items: center;
		margin: 0 calc(-1 * var(--cl-s5)) 0;
		padding: var(--cl-s5);
		border-radius: 0 0 var(--cl-r-card) var(--cl-r-card);
	}
	.latest-empty p {
		background: var(--cl-surface);
		padding: 6px 12px;
		border-radius: var(--cl-r-chip);
	}

	/* Plans */
	.plan-teaser {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: var(--cl-s4);
		align-items: stretch;
	}
	.plan-teaser .card {
		display: grid;
		gap: var(--cl-s2);
		align-content: start;
	}
	.price {
		font: 400 16px/24px var(--cl-font);
	}
	.price .amount {
		font: var(--cl-display);
		margin-right: 4px;
	}
	.plan-link {
		display: grid;
		align-content: center;
		padding-left: var(--cl-s4);
	}

	/* Install */
	.install-card {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		align-items: center;
		gap: var(--cl-s6);
		padding: var(--cl-s6) 56px;
		border-radius: var(--cl-r-card);
		border: 1px solid var(--cl-border);
		background: var(--cl-surface);
		overflow: hidden;
	}
	.install-copy {
		display: grid;
		gap: var(--cl-s4);
		justify-items: start;
	}
	.install-copy .t-lede {
		max-width: 520px;
	}
	.install-art {
		position: relative;
		display: grid;
		place-items: center;
	}
	.install-mark {
		position: absolute;
		display: grid;
		place-items: center;
		width: 104px;
		height: 104px;
		border-radius: 50%;
		background: var(--cl-surface);
		color: var(--cl-text);
	}

	@media (max-width: 1040px) {
		.hero-grid,
		.why-grid,
		.open-grid,
		.fair-grid {
			grid-template-columns: 1fr;
			gap: var(--cl-s6);
		}
		.hero-demo {
			max-width: 620px;
		}
		.layers,
		.rules {
			grid-template-columns: 1fr 1fr;
		}
	}
	@media (max-width: 760px) {
		.hero {
			padding-top: var(--cl-s6);
		}
		.tests,
		.treatments,
		.privacy-grid,
		.fair-list,
		.not-slop ul {
			grid-template-columns: 1fr;
		}
		.plan-teaser {
			grid-template-columns: 1fr;
		}
		.plan-link {
			padding-left: 0;
		}
		.install-card {
			grid-template-columns: 1fr;
		}
		.install-art {
			order: -1;
			justify-self: start;
		}
		.install-art :global(svg.disc) {
			width: 200px;
			height: 200px;
		}
		.install-mark {
			width: 64px;
			height: 64px;
		}
		.definition {
			font: 400 20px/30px var(--cl-font);
			padding-left: var(--cl-s4);
		}
		.why-specimen {
			padding: var(--cl-s2) 0;
		}
	}
	@media (max-width: 560px) {
		.layers,
		.rules {
			grid-template-columns: 1fr;
		}
		.levels tr.default {
			background: var(--cl-paper);
			padding-inline: 10px;
			margin-inline: -10px;
			border-radius: var(--cl-r-chip);
		}
		.verdicts th[scope='row'] {
			width: auto;
		}
		.install-card {
			padding: var(--cl-s5) var(--cl-s4);
		}
	}
</style>
