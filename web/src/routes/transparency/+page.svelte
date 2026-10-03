<script lang="ts">
	import { onMount } from 'svelte';
	import { VERDICTS, VerdictChip, VERDICT_WORD } from '@colander/shared';
	import type { Stats } from '@colander/shared/api';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { api, errorText } from '#lib/api.ts';
	import { fmtDateTime, fmtNum } from '#lib/format.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import PageHead from '#lib/components/PageHead.svelte';

	let stats = $state<Stats | null>(null);
	let error = $state('');

	async function load() {
		error = '';
		try {
			stats = await api<Stats>('/v1/stats');
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(load);

	const total = $derived(stats ? VERDICTS.reduce((n, v) => n + stats!.sources[v], 0) : 0);
	const max = $derived(stats ? Math.max(1, ...VERDICTS.map((v) => stats!.sources[v])) : 1);

	const funding = [
		['Plus subscriptions', '$3 a month or $30 a year, from version 1.0', 'Planned'],
		['Donations', 'Once or monthly, any amount, with optional credit', 'Open'],
		['Grants', 'From foundations that fund work on the information ecosystem', 'Sought'],
		['Advertising', 'Ads in the extension, on this site or in the lists', 'Never'],
		['Affiliate links', 'Commission from links we show or rewrite', 'Never'],
		['Selling or sharing data', 'Anything about the people who use Colander', 'Never'],
		['Paying to leave a list', 'Creators, platforms or advertisers buying their way off a list', 'Never']
	];

	const rules = [
		'Free blocking is never reduced to push upgrades.',
		'Paying or donating never changes tag weight, review priority or any verdict.',
		'No creator, platform or advertiser can pay to leave a list or join an allowlist.',
		'No ads, no affiliate links, and no sale or sharing of user data.',
		'Every funding source is published.'
	];
</script>

<svelte:head>
	<title>Transparency · Colander</title>
	<meta name="description" content="Live numbers for the Colander list, how it is funded, the independence rules and how verdicts expire." />
</svelte:head>

<PageHead
	eyebrow="Transparency"
	title="Open books, open list"
	lede="A blocker asks for trust. These are the live numbers behind the shared list, where the money comes from, and the rules that keep money away from verdicts."
/>

<div class="wrap page">
	<section aria-labelledby="live-title" class="block">
		<div class="block-head">
			<h2 class="t-title" id="live-title">The list right now</h2>
			{#if stats?.list_updated_at}
				<p class="t-body muted">List version <span class="cl-num">{fmtNum(stats.list_sequence)}</span>, published {fmtDateTime(stats.list_updated_at)}.</p>
			{/if}
		</div>

		{#if error}
			<div class="error-box">
				<Notice tone="error" title="Live numbers could not load"><p>{error}</p></Notice>
				<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={load}><RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Try again</button>
			</div>
		{:else if !stats}
			<Loading label="Loading live numbers" />
		{:else}
			<dl class="tiles">
				<div class="tile"><dt>Sources on the list</dt><dd>{fmtNum(total)}</dd></div>
				<div class="tile"><dt>Items with their own verdict</dt><dd>{fmtNum(stats.items)}</dd></div>
				<div class="tile"><dt>Decisions in the last 7 days</dt><dd>{fmtNum(stats.decisions_7d)}</dd></div>
				<div class="tile"><dt>Open appeals</dt><dd>{fmtNum(stats.appeals.open)}</dd></div>
				<div class="tile">
					<dt>Median days to decide an appeal</dt>
					<dd>
						{stats.appeals.median_days === null ? 'No data yet' : stats.appeals.median_days.toFixed(1)}
						<span class="tile-note">The goal is 7 days or fewer.</span>
					</dd>
				</div>
				<div class="tile">
					<dt>Active installs</dt>
					<dd>
						{fmtNum(stats.active_installs)}
						<span class="tile-note">Estimated from list downloads, which carry no identifier.</span>
					</dd>
				</div>
			</dl>

			<figure class="card chart">
				<figcaption class="t-title">Sources by verdict</figcaption>
				<table class="bars">
					<thead class="sr-only"><tr><th scope="col">Verdict</th><th scope="col">Sources</th></tr></thead>
					<tbody>
						{#each VERDICTS as v (v)}
							{@const n = stats.sources[v]}
							<tr title="{VERDICT_WORD[v]}: {fmtNum(n)} sources">
								<th scope="row"><VerdictChip verdict={v} /></th>
								<td>
									<span class="bar-track" aria-hidden="true"><span class="bar" style:width="{(n / max) * 100}%"></span></span>
									<span class="value cl-num">{fmtNum(n)}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="t-caption muted">Clear sources stay on the list so the extension knows they were checked.</p>
			</figure>
		{/if}
	</section>

	<section aria-labelledby="funding-title" class="block">
		<h2 class="t-title" id="funding-title">Where the money comes from</h2>
		<p class="t-body-lg muted prose">
			Blocking is free, and the work behind it is paid for by a low-priced subscription, donations and grants. A yearly report
			publishes income by source and spending by category on this page.
		</p>
		<div class="table-scroll">
			<table class="plain stack-sm">
				<thead><tr><th scope="col">Source</th><th scope="col">What it is</th><th scope="col">Status</th></tr></thead>
				<tbody>
					{#each funding as [name, what, status] (name)}
						<tr><th scope="row" class="row-name">{name}</th><td>{what}</td><td data-label="Status"><span class="tag">{status}</span></td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<div class="two">
		<section aria-labelledby="independence-title" class="block" id="independence">
			<h2 class="t-title" id="independence-title">Independence rules</h2>
			<ol class="rules">
				{#each rules as r, i (r)}<li><span class="n cl-num" aria-hidden="true">{i + 1}</span><span>{r}</span></li>{/each}
			</ol>
			<p class="t-body muted">The scoring and review code never reads plan or payment state. It is an input nobody can buy.</p>
		</section>

		<section aria-labelledby="expiry-title" class="block">
			<h2 class="t-title" id="expiry-title">How verdicts expire</h2>
			<ul class="plain-list">
				<li>Every verdict carries a re-score date, 90 days after it last changed.</li>
				<li>At that date, staff and curator decisions lapse and the source is scored again from fresh evidence.</li>
				<li>If re-scoring would make it Slop, it stays Likely slop until a person reviews it.</li>
				<li>An appeal triggers re-review at once, and a verified appeal shows the source as Disputed within a minute.</li>
				<li>The extension syncs about once an hour, and works offline from its last copy.</li>
			</ul>
		</section>
	</div>

	<section aria-labelledby="review-title" class="block">
		<h2 class="t-title" id="review-title">How review works</h2>
		<div class="review-grid">
			<div class="card-quiet">
				<h3>Curators</h3>
				<p class="t-body muted">Volunteers who review reports and items, with spot audits. They cannot decide large sources or appeals.</p>
			</div>
			<div class="card-quiet">
				<h3>Staff</h3>
				<p class="t-body muted">Decide large sources, escalations and every appeal. A list-wide Slop verdict on a large source always needs staff.</p>
			</div>
			<div class="card-quiet">
				<h3>Community scoring</h3>
				<p class="t-body muted">Runs every few minutes from weighted tags. Every change it makes is logged with a reason built from its signals.</p>
			</div>
		</div>
		<p class="t-body"><a href="/log">Read every decision in the log</a></p>
	</section>
</div>

<style>
	.page {
		display: grid;
		gap: 64px;
		padding-top: var(--cl-s6);
	}
	.block {
		display: grid;
		gap: var(--cl-s4);
		align-content: start;
	}
	.block-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--cl-s2) var(--cl-s5);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--cl-s4);
	}
	.tile {
		padding: var(--cl-s4) var(--cl-s5);
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		display: grid;
		align-content: start;
		gap: 2px;
	}
	.tile dt {
		font: var(--cl-body);
		color: var(--cl-text-muted);
	}
	.tile dd {
		font: var(--cl-display);
		font-variant-numeric: tabular-nums;
	}
	.tile-note {
		display: block;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.chart {
		margin: 0;
		display: grid;
		gap: var(--cl-s4);
	}
	.bars {
		width: 100%;
		border-collapse: collapse;
	}
	.bars th {
		width: 136px;
		text-align: left;
		padding: var(--cl-s2) 0;
	}
	.bars td {
		display: flex;
		align-items: center;
		gap: var(--cl-s3);
		padding: var(--cl-s2) 0;
	}
	.bars tr:hover .bar {
		background: color-mix(in srgb, var(--cl-text) 80%, var(--cl-surface));
	}
	.bar-track {
		flex: 1;
		height: 12px;
		display: flex;
		border-left: 1px solid var(--w-control-border);
	}
	.bar {
		height: 100%;
		background: var(--cl-text);
		border-radius: 0 4px 4px 0;
		min-width: 2px;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.value {
		width: 72px;
		text-align: right;
		font: 600 14px/20px var(--cl-font);
	}
	.row-name {
		color: var(--cl-text) !important;
		white-space: nowrap;
	}
	.two {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 64px;
	}
	.rules {
		list-style: none;
		display: grid;
		gap: var(--cl-s3);
		font: var(--cl-body-lg);
	}
	.rules li {
		display: flex;
		gap: var(--cl-s3);
	}
	.n {
		flex: none;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 1.5px solid var(--cl-text);
		font: 700 12px/1 var(--cl-font);
	}
	.plain-list {
		padding-left: var(--cl-s5);
		display: grid;
		gap: var(--cl-s2);
		font: var(--cl-body-lg);
	}
	.plain-list li::marker {
		color: var(--cl-text-muted);
	}
	.review-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--cl-s4);
	}
	.review-grid h3 {
		font: 600 16px/24px var(--cl-font);
		margin-bottom: var(--cl-s1);
	}
	.error-box {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
		max-width: 560px;
	}
	@media (max-width: 860px) {
		.tiles {
			grid-template-columns: 1fr 1fr;
		}
		.two,
		.review-grid {
			grid-template-columns: 1fr;
			gap: var(--cl-s6);
		}
	}
	@media (max-width: 480px) {
		.tile {
			padding: var(--cl-s3) var(--cl-s4);
		}
		.bars th {
			width: 112px;
		}
		.value {
			width: 56px;
		}
	}
</style>
