<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ACTION_DONE_WORD,
		ACTION_TABLE,
		ColanderMark,
		DEFINITION_PUBLIC,
		DEMO_FEED,
		DEMO_THUMBS_NOTE,
		DotField,
		DotMeter,
		DotUnitChart,
		EvidenceCard,
		FeedDemo,
		LogRow,
		PLATFORMS,
		PLATFORM_NAME,
		PLATFORM_SURFACES,
		PLAN_COPY,
		PlatformTag,
		PopupRows,
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
		VERDICT_WORD,
		fmtAgo,
		fmtDateTime,
		fmtListVersion,
		fmtNum,
		fmtShortDate,
		type Platform,
		type PopupRow,
		type Strictness
	} from '@colander/shared';
	import { demoAction, demoCounts } from '@colander/shared/inpage';
	import { evidence } from '@colander/shared/inpage/evidence.ts';
	import type { LogEntry } from '@colander/shared/api';
	import Tabs from '@colander/shared/components/ui/tabs/tabs.svelte';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import InfinityIcon from '@lucide/svelte/icons/infinity';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Lock from '@lucide/svelte/icons/lock';
	import Minus from '@lucide/svelte/icons/minus';
	import Scale from '@lucide/svelte/icons/scale';
	import Tag from '@lucide/svelte/icons/tag';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Figure from '#lib/components/Figure.svelte';
	import SectionHead from '#lib/components/SectionHead.svelte';
	import StoreNote from '#lib/components/StoreNote.svelte';
	import InstallButton from '#lib/components/InstallButton.svelte';
	import { BROWSERS } from '#lib/install.svelte.ts';
	import { COMPARISON, COMPARISON_CHECKED, COMPARISON_SCOPE, FAQ, KAPWING, KAPWING_URL } from '#lib/content.ts';
	import { live } from '#lib/live.svelte.ts';

	/* Hero demo: one state drives the frame, the phone feed and the popup each of them carries. The
	   phone feed has a fixed height, like the desktop frame, so the popup's control under it stays
	   put when a level hides items, and enough clear videos to fill it at every level. Phones show
	   this one list and no platform tabs, which would change nothing on the page there. */
	const PHONE = [6, 3, 1, 5, 7, 9, 10, 11];
	// At Standard the page ends where the third card starts, so the fade covers a thumbnail, not words.
	const PHONE_HEIGHT = 541;
	let platform = $state<Platform>('yt');
	let level = $state<Strictness>('standard');
	let paused = $state(false);
	let openPhone = $state<number | null>(3);

	const stats = $derived(live.stats);
	const listInfo = $derived({ sequence: stats?.list_sequence ?? null, updatedAt: stats?.list_updated_at ?? null });
	const listDate = $derived(stats?.list_updated_at ?? null);
	const release = __RELEASE__;

	/* Live strip. */
	const sources = $derived(stats ? VERDICTS.reduce((n, v) => n + stats.sources[v], 0) : null);

	/* Strictness cards, the specimen strip and the popup rows in tile 02. */
	const MINI = [2, 6, 3, 1].map((id) => DEMO_FEED.find((i) => i.id === id)!);
	const ACTION_ICON = { hide: EyeOff, label: Tag, allow: Eye };
	/** The popup's rows for what a level hides from the mini feed: each one stays listed, with Show. */
	const popupRows = (level: Strictness): PopupRow[] =>
		MINI.filter((i) => demoAction(i, level) === 'hide').map((i) => ({ id: i.id, verdict: i.verdict, title: i.title, action: 'hide' }));
	const HIDDEN_ROWS = popupRows('standard');

	/* Bento. */
	const item6 = DEMO_FEED.find((i) => i.id === 6)!;
	// Tile 03 is the compact popover: the two layers that agreed and the list's date, whole.
	const bentoEvidence = $derived(evidence({ verdict: 'likely_slop', hidden: true, rows: item6.evidence?.filter((r) => r.agreed), listDate }));
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
			<span class="install"><InstallButton free block={false} caption /></span>
			<ArrowLink href="/definition" size="lg">See how it decides</ArrowLink>
		</div>
		<p class="cl-figure version">
			Version {release.version}{#if release.released}, released {fmtShortDate(release.released)}{/if}. For {BROWSERS} on desktop. <StoreNote />
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

		<!-- Each frame shows its own popup under it when the popup does not dock, so the popup always
		     lists the feed above it. -->
		{#snippet popupBelow(popup: import('svelte').Snippet)}
			<div class="popup-phone">
				<p class="cl-eyebrow">The popup in your toolbar</p>
				<div class="popup-box">{@render popup()}</div>
			</div>
		{/snippet}
		<!-- 742 tall: the docked popup fits, and the page ends 48 px into the fourth row's thumbnails, so
		     the fade covers pictures, never words. -->
		<div class="frame-desk">
			<FeedDemo bind:platform bind:level bind:paused height={742} list={listInfo} {listDate} below={popupBelow} />
		</div>
		<div class="frame-phone" class:reserved={!phoneFeed}>
			{#if phoneFeed}
				<FeedDemo
					platform="yt"
					bind:level
					bind:paused
					layout="list"
					items={PHONE}
					bind:open={openPhone}
					popup={false}
					height={PHONE_HEIGHT}
					list={listInfo}
					{listDate}
					below={popupBelow}
				/>
			{/if}
		</div>
		<noscript><style>.frame-desk{display:block!important}.frame-phone{display:none!important}</style></noscript>

		<div class="control">
			<span class="control-label" aria-hidden="true">Strictness</span>
			<StrictnessControl bind:value={level} size="xl" label="Strictness" hint={false} />
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
			<p class="cl-title-lg statement">{DEFINITION_PUBLIC}</p>
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
				{@const rows = popupRows(l)}
				<li class="level" class:std={l === 'standard'}>
					<h3 class="level-name">{STRICTNESS_WORD[l]}{#if l === 'standard'}<span class="uin-badge uin-badge-lg">Default</span>{/if}</h3>
					<p class="level-hint">{STRICTNESS_HINT[l]}</p>
					<div class="level-feed">
						<FeedDemo variant="mini" level={l} />
						<!-- What the level hides leaves the feed, and the popup lists it with Show. -->
						{#if rows.length}
							<div class="in-popup" role="img" aria-label="In the popup: {rows.map((r) => `${r.verdict ? VERDICT_WORD[r.verdict] : ''}, ${r.title}`).join('; ')}. Each with Show.">
								<div inert>
									<p class="in-popup-head">In the popup</p>
									<PopupRows {rows} />
								</div>
							</div>
						{/if}
					</div>
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
		<ol class="bento">
			<li class="tile">
				<span class="cl-figure step">01</span>
				<div class="vis" role="img" aria-label="A thumbnail with the ink chip AI-made in its corner.">
					<DotField class="vis-dots" />
					<div inert class="vis-in thumb-demo"><Thumb scene="tide-pool" /><span class="on-thumb"><VerdictChip verdict="ai_made" tone="ink" /></span></div>
				</div>
				<h3>Labeled where you see it</h3>
				<p>AI-made items stay visible at Standard, with a label.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">02</span>
				<div class="vis" role="img" aria-label="The popup's On this page list: a Slop video and a Likely slop video, each with Show.">
					<DotField class="vis-dots" />
					<div inert class="vis-in rows-demo">
						<p class="rows-head">On this page</p>
						<PopupRows rows={HIDDEN_ROWS} />
					</div>
				</div>
				<h3>Hidden for you, not for everyone</h3>
				<p>Slop leaves no gap, the way an ad blocker hides an ad. The popup lists it with Show.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">03</span>
				<div class="vis" role="img" aria-label="The Why popover: two evidence layers agreed, and the list and its date.">
					<DotField class="vis-dots" />
					<div inert class="vis-in pop-demo"><EvidenceCard evidence={bentoEvidence} headingLevel={4} /></div>
				</div>
				<h3>Every hide says why</h3>
				<p>The signals that agreed, the list and the date.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">04</span>
				<div class="vis" role="img" aria-label="A notice that says Shown again, with Undo.">
					<DotField class="vis-dots" />
					<div inert class="vis-in toast-demo">
						<Toast text="Shown again." paused actions={[{ label: 'Undo', icon: Undo2, onClick: noop }]} />
					</div>
				</div>
				<h3>One click to undo</h3>
				<p>Show brings an item back. Undo hides it again.</p>
			</li>
			<li class="tile">
				<span class="cl-figure step">05</span>
				<div class="vis" role="img" aria-label="A source page banner: Disputed, unhidden while staff review.">
					<DotField class="vis-dots" />
					<div inert class="vis-in banner-demo">
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
				<div class="vis" role="img" aria-label="A decision log entry from 2 Oct 2026: Likely slop changed to Clear.">
					<DotField class="vis-dots" />
					<div inert class="vis-in log-demo"><LogRow entry={bentoLog} time="date" /></div>
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
		<SectionHead id="open-title" eyebrow="Open by default" title="Every change in public." title2="A signed list and a public log." />
		<div class="band-grid">
			<div class="band-left">
				<figure class="fig4">
					<Figure n={4} />
					<figcaption class="fig-cap">The signed list, your device, your feed.</figcaption>
				</figure>
				<div class="list-card">
					<p class="list-title">Core list{#if stats}{' '}{fmtListVersion(stats.list_sequence)}{/if}</p>
					{#if stats?.list_updated_at}<p class="cl-caption muted">Updated {fmtAgo(stats.list_updated_at, live.now ?? undefined)}</p>{/if}
					<p class="list-line">Colander checks the signature on every copy of the list before it uses it.</p>
					<ArrowLink href="/definition#signing">How signing works</ArrowLink>
				</div>
			</div>
			<div class="band-right">
				<h3 class="cl-title">Latest decisions</h3>
				<div class="rows">
					<!-- Nothing until the log is read: "no entries" only after the log said so. -->
					{#if live.log}{#each live.log as e (e.id)}<LogRow entry={e} time="stamp" />{:else}<p class="muted none">The decision log has no entries yet.</p>{/each}{/if}
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
					This site sets no cookies until you sign in, so there is no banner.
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
						<th scope="col"><span class="col-head"><Minus size={16} aria-hidden="true" />Common in AI blockers</span></th>
						<th scope="col" class="us"><span class="col-head"><ColanderMark size={16} />Colander</span></th>
					</tr>
				</thead>
				<tbody>
					{#each COMPARISON as row (row.check)}
						<tr>
							<th scope="row">{row.check}</th>
							<td><span class="cmp"><Minus size={16} aria-hidden="true" /><span><span class="k" aria-hidden="true">Common: </span>{row.common}</span></span></td>
							<td class="us"><span class="cmp"><Check size={16} aria-hidden="true" /><span><span class="k" aria-hidden="true">Colander: </span>{row.colander}</span></span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="compare-cap">
			<span>Based on {COMPARISON_SCOPE}, checked {fmtShortDate(COMPARISON_CHECKED)}. A dash marks what is common in AI blockers, a check what Colander does.</span>
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
				<PriceCard plan="free">
					{#snippet action()}<InstallButton variant="secondary" size="xl" />{/snippet}
				</PriceCard>
				<PriceCard plan="plus" cta={{ href: '/plans#trial' }} />
			</div>
		</div>
	</div>
</section>

<!-- 11. FAQ -->
<section class="cl-section faq-section" aria-labelledby="faq-title">
	<div class="cl-container faq-wrap">
		<SectionHead id="faq-title" eyebrow="Questions" title="Good questions." title2="Plain answers." />
		<!-- One column, so the hairlines line up and opening an answer moves only what is under it. -->
		<div class="faq">
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
	/* Tight enough that the frame starts near y 540 at 1440, so its first row of chips, the open
	   popover and the popup's counts are in the first view. */
	.hero {
		padding-top: 48px;
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
		margin-top: 16px;
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
		margin-top: 24px;
	}
	.install {
		display: grid;
	}
	@media (max-width: 1023px) {
		.install {
			width: min(100%, 360px);
		}
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
		margin-top: 8px;
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
		margin-top: 20px;
		container: demo / inline-size;
	}
	.tabs {
		display: flex;
		justify-content: center;
		margin-bottom: 8px;
	}
	.frame-desk,
	.frame-phone {
		width: 100%;
	}
	.frame-phone,
	.popup-phone {
		display: none;
	}
	/* Until the phone feed mounts, its frame (541) and the popup under it keep their place. */
	.reserved {
		min-height: 1167px;
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
	/* The popup docks in the frame while the frame is at least 1200 wide; narrower, the page shows the
	   popup under the frame, and its control drives the feed. */
	@container demo (max-width: 1199px) {
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
		.install {
			width: 100%;
		}
		/* Stacked, each icon sits on its item's first line, so the icon column stays straight. */
		.proof {
			flex-direction: column;
			align-items: flex-start;
		}
		.proof li {
			align-items: flex-start;
		}
		.proof :global(svg) {
			margin-top: 2px;
		}
		.demo {
			justify-items: stretch;
		}
		.tabs {
			display: none;
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
		grid-template-columns: repeat(3, minmax(0, 1fr));
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
	.level-feed {
		display: grid;
		align-content: start;
		gap: 12px;
	}
	/* Under the rows a level keeps: the rows it hides, as the popup lists them, each with Show. */
	.in-popup {
		padding-top: 8px;
		border-top: 1px solid var(--cl-border);
	}
	.in-popup-head {
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	/* The rows' own 8 px inset lines their chips up with the thumbnails above. */
	.in-popup :global(.rows) {
		margin: 0 -8px -4px;
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
			gap: 16px;
		}
		.level {
			padding: 16px;
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
		/* Phones: each level is its name, what it does, its rows on one line each, and its counts. */
		.level {
			gap: 8px;
			padding: 16px;
		}
		.in-popup {
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
		grid-template-rows: auto minmax(160px, auto) auto 1fr;
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
	/* A perforated rule runs from the step number to the tile's padding, toward the next step in
	   the row; it never crosses the tile's border. */
	.tile:not(:nth-child(3n))::after {
		content: '';
		position: absolute;
		top: 30px;
		right: 24px;
		left: 56px;
		height: 3px;
		background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 8px 3px repeat-x;
	}
	/* Each picture spans the tile's full width, so the notice in 04 stays on one line, as it does on
	   a host page. Every picture is whole: none is cropped. */
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
	/* The popup's On this page card, as PopupView draws it: a 36 header and its rows. */
	.rows-demo {
		width: calc(100% - 48px);
		padding: 0 4px 4px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.tile .rows-head {
		display: flex;
		align-items: center;
		height: 36px;
		padding-left: 8px;
		color: var(--cl-text);
		font: var(--cl-body-strong);
	}
	.pop-demo :global(.cl-pop) {
		width: 312px;
		max-width: 100%;
	}
	.pop-demo {
		max-width: calc(100% - 32px);
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
		width: calc(100% - 48px);
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
		width: calc(100% - 48px);
		padding: 0 12px 4px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.log-demo :global(.log) {
		border-top: 0;
	}
	/* The whole entry, its reason in 2 lines, fits the picture. */
	.log-demo :global(.row) {
		row-gap: 2px;
		padding-block: 8px;
	}
	.tile h3 {
		font: var(--cl-title);
	}
	.tile p {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	/* Too narrow for three: two to a row, so the popup rows in 02 keep their titles. */
	@media (min-width: 1024px) and (max-width: 1279px) {
		.bento {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.bento .tile:nth-child(odd)::after {
			content: '';
			position: absolute;
			top: 30px;
			right: 24px;
			left: 56px;
			height: 3px;
			background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 8px 3px repeat-x;
		}
		.bento .tile:nth-child(even)::after {
			content: none;
		}
	}
	@media (max-width: 1023px) {
		.bento {
			grid-template-columns: 1fr;
			max-width: 560px;
		}
		.tile::after {
			display: none;
		}
	}
	/* Phones: one column. The step numbers sit in a rail on the left, joined from tile to tile by a
	   vertical perforated rule, and each picture takes the height it needs. */
	@media (max-width: 639px) {
		.bento {
			gap: 16px;
			max-width: none;
		}
		.tile {
			grid-template-columns: 24px minmax(0, 1fr);
			grid-template-rows: auto auto 1fr;
			gap: 8px 12px;
			padding: 16px;
		}
		.step {
			grid-row: 1 / -1;
			grid-column: 1;
			line-height: 20px;
		}
		.tile > :not(.step) {
			grid-column: 2;
		}
		.tile:not(:last-child)::after {
			content: '';
			position: absolute;
			display: block;
			top: 44px;
			right: auto;
			bottom: -28px;
			left: 23px;
			z-index: 1;
			width: 3px;
			height: auto;
			background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 3px 8px repeat-y;
		}
		.vis {
			margin-inline: 0;
			padding-block: 12px;
			border-radius: var(--cl-r-chip);
		}
		.thumb-demo {
			width: min(224px, calc(100% - 32px));
		}
		.rows-demo,
		.pop-demo,
		.banner-demo,
		.log-demo {
			width: calc(100% - 16px);
			max-width: none;
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
	.fig-cap {
		color: var(--cl-text-muted);
		font: var(--cl-body);
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
	.col-head {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.us .col-head {
		color: var(--cl-text);
	}
	/* A check beside what Colander does, a dash beside what is common: the icons sit on the first line. */
	.cmp {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.cmp :global(svg) {
		flex: none;
		margin-top: 2px;
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
		justify-content: space-between;
		gap: 4px 24px;
		margin-top: 16px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	@media (max-width: 639px) {
		.compare {
			padding: 0 16px;
		}
		/* The check and the dash tell the two lines apart, so the Colander line needs no box. */
		.compare .us {
			padding: 2px 0;
			background: none;
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
			padding-block: 12px;
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

	/* 11. FAQ: the heading beside one column of questions, like the sections above it. */
	.faq-section {
		padding-top: 0;
	}
	.faq-wrap {
		display: grid;
		grid-template-columns: 4fr 8fr;
		gap: 48px;
		align-items: start;
	}
	.faq-wrap :global(.head) {
		margin-bottom: 0;
	}
	@media (max-width: 1023px) {
		.faq-wrap {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		.faq-wrap :global(.head) {
			margin-bottom: var(--cl-s6);
		}
	}
	.faq {
		max-width: 720px;
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
