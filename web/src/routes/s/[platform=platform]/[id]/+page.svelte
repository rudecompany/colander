<script lang="ts">
	import { page } from '$app/state';
	import {
		ACTION_TABLE,
		PLATFORM_NAME,
		SIGNAL_TEXT,
		SLOP_TYPE_HINT,
		SLOP_TYPE_WORD,
		SOURCE_NOUN,
		STRICTNESS,
		STRICTNESS_WORD,
		TEST_HINT,
		TEST_WORD,
		VERDICT_PLAIN,
		type Action,
		type Platform,
		type Verdict
	} from '@colander/shared';
	import type { SourceResponse } from '@colander/shared/api';
	import Scale from '@lucide/svelte/icons/scale';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Eye from '@lucide/svelte/icons/eye';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import Tag from '@lucide/svelte/icons/tag';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { ColanderMark } from '@colander/shared';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { appealPath, fmtDate, fmtNum, fmtPct, platformSourceUrl, plural } from '#lib/format.ts';
	import { groupSignals } from '#lib/layers.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import VerdictOrNone from '#lib/components/VerdictOrNone.svelte';
	import LogEntryView from '#lib/components/LogEntryView.svelte';

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

	const ACTION_WORD: Record<Action, string> = { hide: 'Hidden', collapse: 'Collapsed', label: 'Labeled', allow: 'Allowed' };
	const ACTION_ICON = { hide: EyeOff, collapse: ChevronsDownUp, label: Tag, allow: Eye };

	const SUMMARY: Record<Verdict, string> = {
		slop: 'Hidden for people on Standard, the default level.',
		likely_slop: 'Collapsed to one line for people on Standard, with the reason shown.',
		ai_made: 'Labeled AI-made. Nothing from it is hidden on Standard.',
		disputed: 'Shown to everyone, with a disputed mark.',
		clear: 'Allowed for everyone, at every strictness level.'
	};

	const evidenceLine = $derived.by(() => {
		if (!source) return '';
		const e = source.evidence;
		const parts: string[] = [];
		if (e.taggers > 0) parts.push(plural(e.taggers, 'tagger'));
		if (e.items_seen > 0) parts.push(plural(e.items_seen, 'recent item'));
		return parts.length ? `Based on ${parts.join(' and ')}.` : '';
	});

	const tagTotal = $derived(source ? source.evidence.tags.slop + source.evidence.tags.ai_fine + source.evidence.tags.not_slop : 0);
</script>

<svelte:head>
	<title>{name} on {PLATFORM_NAME[platform]} · Colander</title>
	<meta name="description" content="The Colander verdict for {name} on {PLATFORM_NAME[platform]}, with its evidence and decision history." />
</svelte:head>

<div class="wrap">
	<header class="head">
		<p class="eyebrow">{PLATFORM_NAME[platform]} {noun}</p>
		<h1 class="t-display">{name}</h1>
		{#if source && (source.aliases.length > 1 || source.aliases[0] !== name)}
			<p class="ids">
				{#each source.aliases as a (a)}<span class="mono">{a}</span>{/each}
			</p>
		{/if}
	</header>

	{#if state.kind === 'loading'}
		<Loading label="Loading this {noun}'s record" />
	{:else if state.kind === 'error'}
		<div class="error-box">
			<Notice tone="error" title="This page could not load">
				<p>{state.message}</p>
			</Notice>
			<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={() => load(platform, id)}>
				<RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Try again
			</button>
		</div>
	{:else if state.kind === 'not_rated' || !verdict}
		<section class="banner not-rated" aria-labelledby="status-title">
			<div class="banner-main">
				<h2 class="sr-only" id="status-title">Status</h2>
				<p><VerdictOrNone verdict={null} size="lg" /></p>
				<p class="t-title">Colander has no verdict for this {noun}.</p>
				<p class="t-body muted">
					Nothing from it is hidden, collapsed or labeled by the shared list. Verdicts need AI evidence first, and two layers
					of evidence must agree before anything is hidden.
				</p>
				<p class="links">
					<a href={platformSourceUrl(platform, id)} rel="noreferrer" class="icon-line">
						View on {PLATFORM_NAME[platform]} <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
					</a>
					<a href="/definition">How verdicts are made</a>
				</p>
			</div>
			<div class="banner-art cl-dots" aria-hidden="true">
				<span class="art-mark"><ColanderMark size={40} outline /></span>
			</div>
		</section>
		{#if state.kind === 'ok' && state.data.history.length}
			<section class="block history" aria-labelledby="history-title">
				<h2 class="t-title" id="history-title">Decision history</h2>
				<ol class="timeline">
					{#each state.data.history as e (e.id)}<li><LogEntryView entry={e} showSource={false} /></li>{/each}
				</ol>
			</section>
		{/if}
	{:else if source && state.kind === 'ok'}
		<section class="banner" aria-labelledby="status-title">
			<div class="banner-main">
				<h2 class="sr-only" id="status-title">Verdict</h2>
				<p class="chip-line"><VerdictOrNone {verdict} size="lg" /><span class="plain muted">{VERDICT_PLAIN[verdict]}</span></p>
				<p class="t-title">{SUMMARY[verdict]}</p>
				{#if evidenceLine}<p class="t-body muted">{evidenceLine} Verdict since {source.updated_at ? fmtDate(source.updated_at) : 'an earlier list'}.</p>{/if}
			</div>
			<div class="banner-actions">
				<a class="uin-btn uin-btn-primary btn-lg" href={appealPath(platform, id)}>
					<Scale size={16} strokeWidth={1.75} aria-hidden="true" /> Appeal
				</a>
				<a class="icon-line ext" href={platformSourceUrl(platform, source.id)} rel="noreferrer">
					View on {PLATFORM_NAME[platform]} <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
				</a>
			</div>
		</section>

		{#if source.appeal_open}
			<div class="notice-wrap">
				<Notice title="An appeal is open">
					<p>While staff review it, this {noun} is shown to everyone as Disputed, and nothing from it is hidden.</p>
				</Notice>
			</div>
		{/if}

		<div class="grid">
			<div class="main">
				<section class="block" aria-labelledby="effect-title">
					<h2 class="t-title" id="effect-title">What the extension does with it</h2>
					<ul class="effects">
						{#each STRICTNESS as s (s)}
							{@const a = ACTION_TABLE[s][verdict]}
							{@const Icon = ACTION_ICON[a]}
							<li class:current={s === 'standard'}>
								<span class="lvl">{STRICTNESS_WORD[s]}{s === 'standard' ? ' (default)' : ''}</span>
								<span class="icon-line act"><Icon size={14} strokeWidth={1.75} aria-hidden="true" /> {ACTION_WORD[a]}</span>
							</li>
						{/each}
					</ul>
					<p class="t-body muted">Viewers choose their own level, and can show any item or always allow this {noun}.</p>
				</section>

				<section class="block" aria-labelledby="signals-title">
					<h2 class="t-title" id="signals-title">Signals, in plain words</h2>
					{#if source.signals.length}
						<div class="signal-groups">
							{#each groupSignals(source.signals) as g (g.key)}
								<div class="signal-group">
									<h3>{g.word}</h3>
									<ul>
										{#each g.signals as s (s)}<li>{SIGNAL_TEXT[s]}</li>{/each}
									</ul>
								</div>
							{/each}
						</div>
					{:else}
						<p class="t-body muted">No signals are recorded for this {noun}.</p>
					{/if}
					{#if source.slop_type || source.tests.length}
						<dl class="kv type-tests">
							{#if source.slop_type}
								<dt>Type</dt>
								<dd><strong>{SLOP_TYPE_WORD[source.slop_type]}.</strong> {SLOP_TYPE_HINT[source.slop_type]}.</dd>
							{/if}
							{#if source.tests.length}
								<dt>Tests met</dt>
								<dd>
									<ul class="tests">
										{#each source.tests as t (t)}<li><strong>{TEST_WORD[t]}.</strong> {TEST_HINT[t]}.</li>{/each}
									</ul>
								</dd>
							{/if}
						</dl>
					{/if}
				</section>

				<section class="block" aria-labelledby="evidence-title">
					<h2 class="t-title" id="evidence-title">Evidence</h2>

					<div class="evidence">
						<h3>Community tags</h3>
						{#if tagTotal > 0}
							{@const t = source.evidence.tags}
							<div class="stack-bar" aria-hidden="true">
								<span class="seg seg-slop" style:flex-grow={t.slop}></span>
								<span class="seg seg-fine" style:flex-grow={t.ai_fine}></span>
								<span class="seg seg-not" style:flex-grow={t.not_slop}></span>
							</div>
							<ul class="legend">
								<li><span class="key key-slop" aria-hidden="true"></span>Slop <strong class="cl-num">{fmtNum(t.slop)}</strong></li>
								<li><span class="key key-fine" aria-hidden="true"></span>AI-made but fine <strong class="cl-num">{fmtNum(t.ai_fine)}</strong></li>
								<li><span class="key key-not" aria-hidden="true"></span>Not slop <strong class="cl-num">{fmtNum(t.not_slop)}</strong></li>
							</ul>
							<p class="t-caption muted">From {plural(source.evidence.taggers, 'tagger')}, each weighted by their track record. Only each tagger's latest tag counts.</p>
						{:else}
							<p class="t-body muted">No community tags yet.</p>
						{/if}
					</div>

					<div class="evidence">
						<h3>Share of recent items with AI evidence</h3>
						{#if source.evidence.ai_item_share !== null && source.evidence.items_seen > 0}
							{@const share = source.evidence.ai_item_share}
							<div class="meter" aria-hidden="true">
								<span class="meter-fill" style:width={fmtPct(share)}></span>
								<span class="meter-bar"><span class="meter-bar-label">80%</span></span>
							</div>
							<p class="t-body">
								<strong class="cl-num">{fmtPct(share)}</strong> of {plural(source.evidence.items_seen, 'recent item')} carry AI evidence.
								{share >= 0.8 ? 'That is above' : 'That is below'} the 80% bar for a source that is mostly AI.
								{#if share < 0.8 && source.evidence.items_seen >= 5}A mixed source is never hidden as a whole.{/if}
							</p>
						{:else}
							<p class="t-body muted">Not enough items seen yet.</p>
						{/if}
					</div>

					<div class="evidence">
						<h3>Posting volume</h3>
						{#if source.evidence.uploads_per_day !== null}
							<p class="t-body"><strong class="cl-num">{source.evidence.uploads_per_day}</strong> uploads a day, from public channel data.</p>
						{:else}
							<p class="t-body muted">No upload data for this {noun}. Volume data comes from YouTube's public channel data only.</p>
						{/if}
					</div>
				</section>

				<section class="block history" aria-labelledby="history-title">
					<h2 class="t-title" id="history-title">Decision history</h2>
					{#if state.data.history.length}
						<ol class="timeline">
							{#each state.data.history as e (e.id)}<li><LogEntryView entry={e} showSource={false} /></li>{/each}
						</ol>
					{:else}
						<p class="t-body muted">No decisions are logged for this {noun} yet.</p>
					{/if}
				</section>
			</div>

			<aside class="side">
				<section class="card appeal-card" aria-labelledby="appeal-title">
					<h2 class="t-title" id="appeal-title">Is this your {noun}? Appeal this verdict.</h2>
					{#if source.appeal_open}
						<p class="t-body muted">
							An appeal is already open. If you started it, follow it from the link in your email. The outcome is published
							in the decision log.
						</p>
					{:else}
						<p class="t-body muted">
							Prove the {noun} is yours with a short code, and tell us why the verdict is wrong. Nothing from it is hidden
							while staff review, and the outcome is published in the decision log.
						</p>
					{/if}
					<a class="uin-btn uin-btn-outline uin-btn-md" href={appealPath(platform, id)}>
						<Scale size={16} strokeWidth={1.75} aria-hidden="true" /> Start an appeal
					</a>
				</section>

				<section class="card" aria-labelledby="facts-title">
					<h2 class="facts-title" id="facts-title">Record</h2>
					<dl class="facts">
						<div><dt>Verdict</dt><dd><VerdictOrNone {verdict} /></dd></div>
						{#if source.updated_at}<div><dt>Since</dt><dd>{fmtDate(source.updated_at)}</dd></div>{/if}
						{#if source.rescore_at}<div><dt>Re-scored by</dt><dd>{fmtDate(source.rescore_at)}, or at once if an appeal opens</dd></div>{/if}
						<div><dt>Large audience</dt><dd>{source.large ? 'Yes. A Slop verdict needs staff review.' : 'No'}</dd></div>
						{#if source.imported}<div><dt>Origin</dt><dd>Imported from {source.attribution ?? 'a seed list'}. {source.signals.includes('staff_review') ? 'Reviewed since.' : 'Until reviewed, it can be Likely slop at most.'}</dd></div>{/if}
					</dl>
				</section>

				<section class="card-quiet" aria-labelledby="wrong-title">
					<h2 class="facts-title" id="wrong-title">Not the creator?</h2>
					<p class="t-body muted">
						If you think this is wrong, tag an item Not slop in the extension. Enough counter-tags move a verdict to Disputed.
					</p>
				</section>
			</aside>
		</div>
	{/if}
</div>

<style>
	.head {
		display: grid;
		gap: var(--cl-s2);
		padding: 56px 0 var(--cl-s5);
	}
	.head .t-display {
		overflow-wrap: anywhere;
	}
	.ids {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--cl-s5);
		padding: var(--cl-s5);
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
	}
	.banner-main {
		display: grid;
		gap: var(--cl-s2);
		max-width: 680px;
	}
	.chip-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-bottom: 4px;
	}
	.plain {
		font: var(--cl-body);
	}
	.banner-actions {
		display: grid;
		justify-items: end;
		gap: var(--cl-s3);
		flex: none;
	}
	.ext {
		font: 600 14px/20px var(--cl-font);
	}
	.not-rated {
		align-items: stretch;
		padding: 0;
		overflow: hidden;
	}
	.not-rated .banner-main {
		padding: var(--cl-s5);
	}
	.banner-art {
		flex: 0 0 280px;
		display: grid;
		place-items: center;
		border-left: 1px solid var(--cl-border);
		background-color: var(--cl-paper);
	}
	.art-mark {
		display: grid;
		place-items: center;
		width: 88px;
		height: 88px;
		border-radius: 50%;
		background: var(--cl-paper);
		color: var(--cl-text);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2) var(--cl-s5);
		margin-top: var(--cl-s2);
		font: 600 14px/20px var(--cl-font);
	}
	.notice-wrap {
		margin-top: var(--cl-s3);
	}
	.error-box {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
		max-width: 560px;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: var(--cl-s6);
		margin-top: var(--cl-s6);
		align-items: start;
	}
	.main {
		display: grid;
		gap: var(--cl-s6);
	}
	.block {
		display: grid;
		gap: var(--cl-s4);
	}
	.history {
		margin-top: var(--cl-s6);
	}
	.main .history {
		margin-top: 0;
	}
	.effects {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		overflow: hidden;
	}
	.effects li {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		font: var(--cl-body);
	}
	.effects li + li {
		border-left: 1px solid var(--cl-border);
	}
	.effects li.current {
		background: var(--cl-surface-raised);
	}
	.lvl {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.act {
		font-weight: 600;
	}
	.signal-groups {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s4);
	}
	.signal-group h3,
	.evidence h3 {
		font: 600 14px/20px var(--cl-font);
		color: var(--cl-text-muted);
		margin-bottom: 6px;
	}
	.signal-group ul {
		padding-left: 18px;
		font: var(--cl-body);
		display: grid;
		gap: 4px;
	}
	.type-tests {
		padding-top: var(--cl-s4);
		border-top: 1px solid var(--cl-border);
	}
	.type-tests dd {
		font: var(--cl-body);
	}
	.tests {
		list-style: none;
		display: grid;
		gap: 4px;
	}
	.evidence {
		padding: var(--cl-s4) var(--cl-s5);
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		display: grid;
		gap: var(--cl-s2);
	}
	.stack-bar {
		display: flex;
		gap: 2px;
		height: 14px;
		border-radius: 3px;
		overflow: hidden;
	}
	.seg {
		flex-basis: 0;
		min-width: 3px;
	}
	.seg-slop,
	.key-slop {
		background: var(--cl-text);
	}
	.seg-fine,
	.key-fine {
		background: color-mix(in srgb, var(--cl-text-muted) 55%, var(--cl-surface));
	}
	.seg-not,
	.key-not {
		background: var(--cl-surface);
		box-shadow: inset 0 0 0 1.5px var(--cl-text-muted);
	}
	.seg[style*='flex-grow: 0'] {
		display: none;
	}
	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 20px;
		font: var(--cl-body);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.key {
		width: 12px;
		height: 12px;
		border-radius: 2px;
	}
	.meter {
		position: relative;
		height: 14px;
		border-radius: 3px;
		background-image: radial-gradient(circle, var(--cl-border) 1.5px, transparent 1.9px);
		background-size: 8px 14px;
		margin-top: 22px;
	}
	.meter-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--cl-text);
		border-radius: 3px;
	}
	.meter-bar {
		position: absolute;
		left: 80%;
		top: -6px;
		bottom: -4px;
		border-left: 2px solid var(--cl-text-muted);
	}
	.meter-bar-label {
		position: absolute;
		left: -14px;
		top: -18px;
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}
	.timeline {
		list-style: none;
		border-left: 2px solid var(--cl-border);
		margin-left: 6px;
	}
	.timeline li {
		position: relative;
		padding-left: var(--cl-s5);
	}
	.timeline li::before {
		content: '';
		position: absolute;
		left: -7px;
		top: 30px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--cl-paper);
		border: 2px solid var(--cl-text-muted);
	}
	.timeline :global(.entry) {
		grid-template-columns: 1fr;
		padding-block: var(--cl-s4);
	}
	.timeline :global(.entry .when) {
		display: flex;
		gap: 8px;
	}
	.side {
		display: grid;
		gap: var(--cl-s4);
		position: sticky;
		top: 24px;
	}
	.appeal-card {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
	}
	.facts-title {
		font: 600 16px/24px var(--cl-font);
		margin-bottom: var(--cl-s3);
	}
	.facts {
		display: grid;
		gap: var(--cl-s3);
		font: var(--cl-body);
	}
	.facts dt {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.card-quiet {
		display: grid;
		gap: 0;
	}
	@media (max-width: 960px) {
		.grid {
			grid-template-columns: 1fr;
		}
		.side {
			position: static;
		}
	}
	@media (max-width: 720px) {
		.head {
			padding-top: var(--cl-s6);
		}
		.banner {
			flex-direction: column;
			align-items: stretch;
		}
		.banner-actions {
			justify-items: start;
		}
		.banner-art {
			flex-basis: 120px;
			border-left: 0;
			border-top: 1px solid var(--cl-border);
		}
		.effects {
			grid-template-columns: 1fr 1fr;
		}
		.effects li:nth-child(3) {
			border-left: 0;
		}
		.effects li:nth-child(n + 3) {
			border-top: 1px solid var(--cl-border);
		}
		.signal-groups {
			grid-template-columns: 1fr;
		}
	}
</style>
