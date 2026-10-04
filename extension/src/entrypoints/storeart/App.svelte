<!--
@component Chrome Web Store art, built only into the end-to-end variant and captured by
scripts/make-store-art.ts: five 1280 by 800 screenshots, the 440 by 280 promo tile and the
1400 by 560 marquee. Every picture of Colander here is a shipped component rendered live from
demo values (DEMO_FEED and DEMO_POPUP), never live counts. ?frame=1 to 5, tile or marquee.
-->
<script lang="ts">
	import { BrowserFrame, ColanderMark, DotField, InPage, Lifecycle, LogRow, PlatformTag, PopupView, VerdictChip, type PopupState } from '@colander/shared';
	import type { LogEntry } from '@colander/shared/api';
	import { DEMO_FEED, DEMO_POPUP, PRIVACY_HEADINGS, PRIVACY_NEVER, TAGLINE } from '@colander/shared/copy';
	import { DEMO_CSS, demoAction, demoFeed, demoHiddenCount, type InpageContext } from '@colander/shared/inpage';
	import { STRICTNESS, type Verdict } from '@colander/shared/verdicts';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import LevelCard from '../../ui/LevelCard.svelte';

	const frame = new URLSearchParams(location.search).get('frame') ?? '1';
	const noop = () => {};
	const handlers = { show: noop, why: noop, allow: noop, notSlop: noop, skip: noop };
	const item = (id: number) => DEMO_FEED.find((i) => i.id === id)!;

	const COPY: Record<string, { title: string; title2?: string; lead: string }> = {
		'1': { title: TAGLINE.first, title2: TAGLINE.second, lead: 'Hides AI slop on YouTube, TikTok, Instagram and Facebook, the way an ad blocker hides ads.' },
		'2': { title: 'Every hide comes with a reason.', lead: 'Why shows which signals agreed, the list and the date. Show, Always allow and Not slop are one click away.' },
		'3': { title: 'You choose how strict.', lead: 'Label, Standard, Strict or No AI. Standard hides slop and labels other AI-made videos.' },
		'4': { title: 'Every verdict change is public.', lead: 'Creators can appeal and are unhidden while staff review. Every outcome goes in the decision log.' },
		'5': { title: 'Matched on your device.', title2: 'No account needed.', lead: 'Colander never asks a server about the page you are viewing.' },
		marquee: { title: TAGLINE.first, title2: TAGLINE.second, lead: 'Hides AI slop on YouTube, TikTok, Instagram and Facebook, the way an ad blocker hides ads.' }
	};
	const copy = COPY[frame] ?? COPY['1']!;

	// The popup as it reads on youtube.com at Standard over the demo feed.
	const popup: PopupState = {
		status: 'active',
		domain: 'youtube.com',
		strictness: 'standard',
		hiddenToday: DEMO_POPUP.hiddenToday,
		noun: 'video',
		rows: DEMO_FEED.filter((i) => i.verdict && demoAction(i, 'standard') !== 'allow').map((i) => ({ id: i.id, verdict: i.verdict, title: i.title, action: demoAction(i, 'standard') }))
	};

	// Frame 1: the grid in two columns, so the left one shows beside the docked popup.
	const GRID_CSS = `${DEMO_CSS}.feed-grid{grid-template-columns:repeat(2,172px)}`;
	const grid = (ctx: InpageContext) => demoFeed(ctx, { layout: 'grid', level: 'standard', items: [3, 1, 6, 7, 9, 5].map(item) }, handlers);

	// Frame 2: a list with the collapsed bar, its Why open and floating, as on a host page.
	const why = (ctx: InpageContext) => {
		const feed = demoFeed(ctx, { layout: 'list', level: 'standard', items: [5, 6, 7].map(item), open: 6 }, handlers);
		feed.querySelector('.cl-pop')?.classList.remove('cl-flat');
		return feed;
	};

	// Frame 4: demo log entries for invented sources from the demo feed.
	const LOG: LogEntry[] = [
		{ id: 'l1', at: '2026-10-02T14:02:00Z', platform: 'yt', target_type: 'source', target_id: '@coin.lectures', source_id: '@coin.lectures', source_name: '@coin.lectures', from: 'likely_slop', to: 'disputed', reason: 'The creator appealed and verified the channel. Unhidden while staff review.', signals: ['open_appeal'], actor: 'appeal', actor_name: null },
		{ id: 'l2', at: '2026-10-01T09:40:00Z', platform: 'yt', target_type: 'source', target_id: '@romefacts.minute', source_id: '@romefacts.minute', source_name: '@romefacts.minute', from: 'likely_slop', to: 'slop', reason: 'About 30 uploads a day on one title template, with AI evidence.', signals: ['high_volume', 'templated', 'platform_label'], actor: 'staff', actor_name: null },
		{ id: 'l3', at: '2026-09-30T16:15:00Z', platform: 'yt', target_type: 'source', target_id: '@workbench.notes', source_id: '@workbench.notes', source_name: '@workbench.notes', from: 'likely_slop', to: 'clear', reason: 'Made by hand. The early tags were mistaken.', signals: [], actor: 'community', actor_name: null }
	];
	const TILE_CHIPS: Verdict[] = ['slop', 'likely_slop', 'ai_made'];
</script>

{#if frame === 'tile'}
	<div class="tile">
		<DotField class="tile-dots" mask="linear-gradient(to left, black 30%, transparent)" />
		<span class="tile-mark"><ColanderMark size={40} /></span>
		<p class="tile-h">{TAGLINE.first}<br /><span class="cl-tone2">{TAGLINE.second}</span></p>
		<p class="tile-chips">{#each TILE_CHIPS as v (v)}<VerdictChip verdict={v} size="lg" />{/each}</p>
	</div>
{:else}
	<div class="canvas" class:marquee={frame === 'marquee'} data-frame={frame}>
		<DotField class="bg-dots" mask="linear-gradient(to left, black 35%, transparent)" />
		<div class="seam cl-perf-v" aria-hidden="true"></div>
		<div class="copy">
			<h1 class="h">{copy.title}{#if copy.title2}<br /><span class="cl-tone2">{copy.title2}</span>{/if}</h1>
			<p class="lead">{copy.lead}</p>
		</div>
		<p class="brand"><ColanderMark size={24} /><span>Colander</span></p>

		<div class="ui">
			{#if frame === '1' || frame === 'marquee'}
				<div class="f1">
					<BrowserFrame count={demoHiddenCount('standard')} height={680}>
						{#snippet docked()}<PopupView state={popup} />{/snippet}
						<InPage kind="demo" css={GRID_CSS} build={grid} />
					</BrowserFrame>
				</div>
			{:else if frame === '2'}
				<div class="f2"><InPage kind="demo" css={DEMO_CSS} build={why} /></div>
			{:else if frame === '3'}
				<div class="f3" role="radiogroup" aria-label="Strictness">
					{#each STRICTNESS as level (level)}<LevelCard {level} on={level === 'standard'} />{/each}
				</div>
			{:else if frame === '4'}
				<div class="f4">
					<Card>
						<p class="eyebrow"><PlatformTag platform="yt" /><span>YouTube channel</span></p>
						<h2 class="name">@coin.lectures</h2>
						<p class="status"><VerdictChip verdict="disputed" size="lg" /><span>Unhidden while staff review</span></p>
						<Lifecycle
							direction="horizontal"
							label="Appeal"
							steps={[
								{ label: 'Code', state: 'done' },
								{ label: 'Verify', state: 'done' },
								{ label: 'Under review', state: 'current' },
								{ label: 'Decision', state: 'later' }
							]}
						/>
					</Card>
					<Card>
						<h2 class="log-h">Decision log</h2>
						{#each LOG as e (e.id)}<LogRow entry={e} time="date" />{/each}
					</Card>
				</div>
			{:else if frame === '5'}
				<div class="f5">
					<div class="pop"><PopupView state={popup} /></div>
					<Card>
						<h2 class="never-h">{PRIVACY_HEADINGS.never}</h2>
						<ul class="never">{#each PRIVACY_NEVER as n (n)}<li>{n}</li>{/each}</ul>
					</Card>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	:global(body) {
		margin: 0;
		overflow: hidden;
	}
	.canvas {
		position: relative;
		width: 1280px;
		height: 800px;
		overflow: hidden;
		background: var(--cl-paper);
	}
	.canvas.marquee {
		width: 1400px;
		height: 560px;
	}
	.canvas :global(.bg-dots) {
		position: absolute;
		inset: 0 0 0 40%;
	}
	.seam {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 520px;
	}
	.copy {
		position: absolute;
		top: 96px;
		left: 80px;
		width: 440px;
	}
	.marquee .copy {
		top: 72px;
	}
	.h {
		max-width: 440px;
		font: 600 56px/60px var(--cl-font);
		letter-spacing: -0.02em;
	}
	.lead {
		max-width: 420px;
		margin-top: 24px;
		color: var(--cl-text-muted);
		font: var(--cl-lead);
	}
	.brand {
		position: absolute;
		top: 712px;
		left: 80px;
		display: flex;
		align-items: center;
		gap: 8px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.marquee .brand {
		top: 480px;
	}
	.ui {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 560px;
		width: 640px;
		display: grid;
		align-content: center;
	}
	/* Frame 1 is a crop: the window reaches the right edge and runs off the bottom. */
	.f1 {
		position: absolute;
		top: 60px;
		left: 0;
		width: 576px;
		zoom: 1.25;
	}
	.marquee .f1 {
		top: 48px;
	}
	.f2 {
		zoom: 1.5;
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
	}
	.f3 {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.f4 {
		display: grid;
		gap: 12px;
		zoom: 1.25;
	}
	.eyebrow,
	.status {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.eyebrow span {
		color: var(--cl-text-muted);
		font: var(--cl-body-strong);
	}
	.name {
		margin: 8px 0 12px;
		font: var(--cl-title-lg);
	}
	.status {
		margin-bottom: 16px;
		font: var(--cl-body-strong);
	}
	.log-h {
		margin-bottom: 8px;
		font: var(--cl-title);
	}
	/* Two components side by side need the whole width at 1:1. */
	.f5 {
		display: grid;
		grid-template-columns: 360px minmax(0, 1fr);
		align-items: center;
		gap: 16px;
	}
	.never-h {
		margin-bottom: 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	/* The privacy list's own look: 6 px dot bullets, as PrivacyFacts draws them. */
	.never {
		display: grid;
		gap: 12px;
	}
	.never li {
		position: relative;
		padding-left: 18px;
		font: var(--cl-body-strong);
	}
	.never li::before {
		content: '';
		position: absolute;
		top: 7px;
		left: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
	.pop {
		border-radius: var(--cl-r-card);
		box-shadow: var(--cl-shadow-pop);
	}
	.tile {
		position: relative;
		width: 440px;
		height: 280px;
		overflow: hidden;
		background: var(--cl-paper);
	}
	.tile :global(.tile-dots) {
		position: absolute;
		inset: 0 0 0 50%;
	}
	.tile-mark {
		position: absolute;
		top: 32px;
		left: 32px;
	}
	.tile-h {
		position: absolute;
		top: 96px;
		left: 32px;
		font: 600 36px/40px var(--cl-font);
		letter-spacing: -0.02em;
	}
	.tile-chips {
		position: absolute;
		top: 212px;
		left: 32px;
		display: flex;
		gap: 8px;
	}
</style>
