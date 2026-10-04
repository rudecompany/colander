<script lang="ts">
	import { page } from '$app/state';
	import {
		ACTION_DONE_WORD,
		ACTION_TABLE,
		CopyButton,
		DotMeter,
		EVIDENCE_TITLE,
		EvidenceCard,
		Lifecycle,
		LiveBadge,
		LogRow,
		PerforatedDisc,
		PlatformTag,
		PLATFORM_NAME,
		SLOP_TYPE_HINT,
		SLOP_TYPE_WORD,
		SOURCE_NOUN,
		STRICTNESS,
		TagTally,
		STRICTNESS_WORD,
		TEST_HINT,
		TEST_WORD,
		VerdictChip,
		VERDICT_PLAIN,
		appealPath,
		canAppeal,
		fmtNum,
		fmtPct,
		fmtShortDate,
		middleTruncate,
		platformSourceUrl,
		plural,
		type Platform,
		type Verdict
	} from '@colander/shared';
	import { evidence } from '@colander/shared/inpage/evidence.ts';
	import type { SourceResponse } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Scale from '@lucide/svelte/icons/scale';
	import Tag from '@lucide/svelte/icons/tag';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { live } from '#lib/live.svelte.ts';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	const platform = $derived(page.params.platform as Platform);
	const id = $derived(page.params.id ?? '');
	const noun = $derived(SOURCE_NOUN[platform]);

	let state = $state<{ kind: 'loading' } | { kind: 'ok'; data: SourceResponse } | { kind: 'not_rated' } | { kind: 'error'; message: string }>({
		kind: 'loading'
	});

	async function load(p: Platform, sourceId: string) {
		state = { kind: 'loading' };
		try {
			const data = await api<SourceResponse>(`/v1/sources/${p}/${encodeURIComponent(sourceId)}`);
			state = { kind: 'ok', data };
		} catch (e) {
			state = e instanceof ApiError && e.status === 404 ? { kind: 'not_rated' } : { kind: 'error', message: errorText(e) };
		}
	}

	$effect(() => {
		load(platform, id);
	});

	const source = $derived(state.kind === 'ok' ? state.data.source : null);
	const verdict = $derived(source?.verdict ?? null);
	const name = $derived(source?.name ?? id);
	const appealable = $derived(canAppeal(source));
	const ACTION_ICON = { hide: EyeOff, label: Tag, allow: Eye };

	/** What Standard, the default, does with this source, from the strictness table. */
	function summary(v: Verdict): string {
		const a = ACTION_TABLE.standard[v];
		if (v === 'disputed') return 'Shown to everyone, with a disputed mark.';
		if (v === 'clear') return 'Allowed for everyone, at every strictness level.';
		if (a === 'label') return 'Labeled AI-made for people on Standard, the default level.';
		return `${ACTION_DONE_WORD[a]} for people on Standard, the default level.`;
	}

	const why = $derived(
		source
			? {
					...evidence({ verdict: source.verdict, hidden: false, signals: source.signals }),
					title: EVIDENCE_TITLE
				}
			: null
	);
	/** History without entries where nothing changed. */
	const history = $derived(state.kind === 'ok' ? state.data.history.filter((e) => e.from !== e.to) : []);
	const tags = $derived(source?.evidence.tags);
	const tagTotal = $derived(tags ? tags.slop + tags.ai_fine + tags.not_slop : 0);
</script>

<svelte:head>
	<title>{name} on {PLATFORM_NAME[platform]} · Colander</title>
	<meta name="description" content="The Colander verdict for {name} on {PLATFORM_NAME[platform]}, with its evidence and decision history." />
</svelte:head>

<div class="cl-container page-top head">
	<p class="eyebrow"><PlatformTag {platform} size="lg" /><span>{PLATFORM_NAME[platform]} {noun}</span></p>
	<h1 class="cl-display">{name}</h1>
	<p class="raw">
		<span class="cl-figure cl-muted" title={source?.id ?? id}>{middleTruncate(source?.id ?? id, 28)}</span>
		<CopyButton text={source?.id ?? id} label="Copy" />
	</p>
</div>

<div class="cl-container page-body">
	{#if state.kind === 'loading'}
		<Loading />
	{:else if state.kind === 'error'}
		<div class="error-box">
			<Notice tone="error" title="This page could not load"><p>{state.message}</p></Notice>
			<Button variant="secondary" size="xl" onclick={() => load(platform, id)}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
		</div>
	{:else if state.kind === 'not_rated' || !verdict}
		<section class="banner uin-card uin-card-lg uin-card-pad not-rated" aria-labelledby="status-title">
			<div class="banner-main">
				<h2 class="sr-only" id="status-title">Status</h2>
				<VerdictChip verdict={null} size="lg" />
				<p class="cl-title">Colander has no verdict for this {noun}.</p>
				<p class="cl-muted">
					Nothing from it is hidden or labeled by the shared list. Verdicts need AI evidence first, and two layers of
					evidence must agree before anything is hidden.
				</p>
				<p class="links">
					<a href={platformSourceUrl(platform, id)} rel="noreferrer" class="icon-line">View on {PLATFORM_NAME[platform]}<ExternalLink size={16} aria-hidden="true" /></a>
					<ArrowLink href="/definition">How verdicts are made</ArrowLink>
				</p>
			</div>
			<PerforatedDisc size={160} mark={64} />
		</section>
		{#if history.length}
			<section class="block" aria-labelledby="history-title">
				<h2 class="cl-title" id="history-title">History</h2>
				<div class="rows">{#each history as e (e.id)}<LogRow entry={e} time="date" full />{/each}</div>
			</section>
		{/if}
	{:else if source && why}
		<div class="layout">
			<div class="main">
				<section class="banner uin-card uin-card-lg uin-card-pad" aria-labelledby="status-title">
					<div class="banner-main">
						<h2 class="sr-only" id="status-title">Verdict</h2>
						<p class="chip-line"><VerdictChip {verdict} size="lg" /><span class="cl-muted">{VERDICT_PLAIN[verdict]}</span></p>
						<p class="cl-title">{summary(verdict)}</p>
						{#if source.appeal_open}
							<p class="open">Unhidden while staff review</p>
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
							<p class="cl-muted small">
								The {noun} is shown to everyone while staff review the appeal, and nothing from it is hidden. The outcome is published in the
								decision log.
							</p>
						{/if}
					</div>
					<div class="banner-actions">
						{#if appealable}
							<Button variant="primary" size="xl" href={appealPath(platform, id)}><Scale size={16} aria-hidden="true" />Appeal this verdict</Button>
						{/if}
						<a class="icon-line ext" href={platformSourceUrl(platform, source.id)} rel="noreferrer">View on {PLATFORM_NAME[platform]}<ExternalLink size={16} aria-hidden="true" /></a>
					</div>
				</section>

				<section class="block" aria-labelledby="levels-title">
					<h2 class="cl-title" id="levels-title">At each strictness level</h2>
					<ul class="levels">
						{#each STRICTNESS as s (s)}
							{@const a = ACTION_TABLE[s][verdict]}
							{@const Icon = ACTION_ICON[a]}
							<li class:current={s === 'standard'}>
								<span class="lvl">{STRICTNESS_WORD[s]}{#if s === 'standard'}<span class="uin-badge uin-badge-md">Default</span>{/if}</span>
								<span class="act"><Icon size={16} aria-hidden="true" />{ACTION_DONE_WORD[a]}</span>
							</li>
						{/each}
					</ul>
					<p class="cl-muted small">People choose their own level, and can show any item or always allow this {noun}.</p>
				</section>

				<section class="block" aria-labelledby="evidence-title">
					<h2 class="sr-only" id="evidence-title">Evidence</h2>
					<EvidenceCard evidence={why} variant="full" headingLevel={2} />
					{#if source.slop_type || source.tests.length}
						<dl class="kv">
							{#if source.slop_type}
								<dt>Type</dt>
								<dd><strong>{SLOP_TYPE_WORD[source.slop_type]}.</strong> {SLOP_TYPE_HINT[source.slop_type]}.</dd>
							{/if}
							{#if source.tests.length}
								<dt>Tests met</dt>
								<dd>
									<ul class="dots-list">
										{#each source.tests as t (t)}<li><strong>{TEST_WORD[t]}.</strong> {TEST_HINT[t]}.</li>{/each}
									</ul>
								</dd>
							{/if}
						</dl>
					{/if}
				</section>

				<section class="block" aria-labelledby="numbers-title">
					<h2 class="cl-title" id="numbers-title">The numbers behind it</h2>
					<div class="numbers uin-card uin-card-lg uin-card-pad">
						<div class="num">
							<h3>Community tags</h3>
							{#if tags && tagTotal > 0}
								<TagTally {tags} />
								<p class="cl-caption cl-muted">From {plural(source.evidence.taggers, 'tagger')}, each weighted by their track record.</p>
							{:else}
								<p class="cl-muted small">No community tags yet.</p>
							{/if}
						</div>
						<div class="num">
							<h3>Recent items with AI evidence</h3>
							{#if source.evidence.ai_item_share !== null && source.evidence.items_seen > 0}
								{@const share = source.evidence.ai_item_share}
								<DotMeter value={Math.round(share * 100)} max={100} />
								<p class="small">
									<strong>{fmtPct(share)}</strong> of {plural(source.evidence.items_seen, 'recent item')}. {share >= 0.8 ? 'Above' : 'Below'} the 80% bar
									for a source that is mostly AI.{#if share < 0.8 && source.evidence.items_seen >= 5}{' '}A mixed source is never hidden as a whole.{/if}
								</p>
							{:else}
								<p class="cl-muted small">Not enough items seen yet.</p>
							{/if}
						</div>
						<div class="num">
							<h3>Audience size</h3>
							{#if source.large}
								<p class="small"><strong>Large.</strong> A Slop verdict on it needs staff review.</p>
							{:else}
								<p class="cl-muted small">Not known. A large {noun} needs staff review before a Slop verdict.</p>
							{/if}
						</div>
					</div>
				</section>

				<section class="block" aria-labelledby="history-title">
					<h2 class="cl-title" id="history-title">History</h2>
					{#if history.length}
						<div class="rows">{#each history as e (e.id)}<LogRow entry={e} time="date" full />{/each}</div>
					{:else}
						<p class="cl-muted small">No decisions are logged for this {noun} yet.</p>
					{/if}
				</section>
			</div>

			<aside class="side" aria-label="Record">
				<dl class="facts">
					{#if source.updated_at}<div><dt>Verdict since</dt><dd>{fmtShortDate(source.updated_at)}</dd></div>{/if}
					<div>
						<dt>Re-scoring</dt>
						<dd>Re-scored every 90 days.{#if source.rescore_at}{' '}Next: {fmtShortDate(source.rescore_at)}{/if}</dd>
					</div>
					{#if source.aliases.length > 1}
						<div><dt>Also known as</dt><dd>{#each source.aliases.filter((a) => a !== source.id) as a (a)}<span class="cl-figure alias">{a}</span>{/each}</dd></div>
					{/if}
					{#if live.stats}<div><dt>List</dt><dd><LiveBadge sequence={live.stats.list_sequence} updatedAt={live.stats.list_updated_at} now={live.now ?? undefined} /></dd></div>{/if}
				</dl>
			</aside>
		</div>
	{/if}
</div>

<style>
	.head {
		display: grid;
		justify-items: start;
		gap: 12px;
	}
	.eyebrow {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	h1 {
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.raw {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 280px;
		gap: 48px;
		align-items: start;
	}
	.main {
		display: grid;
		gap: 48px;
		min-width: 0;
	}
	.block {
		display: grid;
		gap: 16px;
	}
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
	}
	.banner-main {
		display: grid;
		justify-items: start;
		gap: 12px;
		max-width: 620px;
	}
	.chip-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
	}
	.open {
		font: var(--cl-body-strong);
	}
	.banner-main :global(.lc) {
		width: min(440px, 100%);
	}
	.banner-actions {
		display: grid;
		justify-items: end;
		gap: 12px;
	}
	.ext {
		font: var(--cl-body-strong);
	}
	.not-rated {
		align-items: center;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
		font: var(--cl-body-strong);
	}
	.small {
		font: var(--cl-body);
	}
	.levels {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		list-style: none;
	}
	.levels li {
		display: grid;
		gap: 8px;
		padding: 16px;
	}
	.levels li + li {
		border-left: 1px solid var(--cl-border);
	}
	.levels .current {
		background: var(--cl-brand-tint);
	}
	.lvl {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--cl-text-muted);
		font: var(--cl-body-strong);
	}
	.current .lvl {
		color: var(--cl-text);
	}
	.act {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.numbers {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px;
	}
	.num {
		display: grid;
		align-content: start;
		gap: 8px;
		min-width: 0;
	}
	.num h3 {
		font: var(--cl-body-strong);
	}
	.rows {
		border-bottom: 1px solid var(--cl-border);
	}
	.side {
		position: sticky;
		top: 88px;
	}
	.facts {
		display: grid;
		gap: 16px;
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		font: var(--cl-body);
	}
	.facts dt {
		margin-bottom: 4px;
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	.alias {
		display: block;
		overflow-wrap: anywhere;
	}
	.error-box {
		display: grid;
		justify-items: start;
		gap: 12px;
		max-width: 560px;
	}
	@media (max-width: 1023px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
		.side {
			position: static;
		}
		.numbers {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 639px) {
		/* Phones: one row per level, its name beside what it does. */
		.levels {
			grid-template-columns: minmax(0, 1fr);
		}
		.levels li {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 8px 16px;
			padding: 12px 16px;
		}
		.levels li + li {
			border-top: 1px solid var(--cl-border);
			border-left: 0;
		}
		.banner-actions {
			justify-items: start;
		}
	}
</style>
