<script lang="ts">
	import { LiveBadge, PageHeader, PLAN_COPY, StatCell, VerdictTally, VERDICTS, fmtListVersion, fmtNum, fmtShortDate, fmtTime } from '@colander/shared';
	import Ban from '@lucide/svelte/icons/ban';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import Search from '@lucide/svelte/icons/search';
	import { live } from '#lib/live.svelte.ts';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	const stats = $derived(live.stats);
	const total = $derived(stats ? VERDICTS.reduce((n, v) => n + stats.sources[v], 0) : 0);
	/** Each dot of the 50-dot meters stands for this many sources. */
	const perDot = $derived(stats ? Math.max(1, Math.ceil(Math.max(...VERDICTS.map((v) => stats.sources[v])) / 50)) : 1);

	const STATUS = {
		Open: CircleDot,
		Sought: Search,
		Never: Ban
	} as const;
	const funding: [string, string, keyof typeof STATUS][] = [
		['Plus subscriptions', PLAN_COPY.plus.short, 'Open'],
		['Gifts', 'Once or monthly, any amount, with optional credit', 'Open'],
		['Grants', 'From foundations that fund work on the information ecosystem', 'Sought'],
		['Advertising', 'Ads in the extension, on this site or in the lists', 'Never'],
		['Affiliate links', 'Commission from links we show or rewrite', 'Never'],
		['Selling or sharing data', 'Anything about the people who use Colander', 'Never'],
		['Paying to leave a list', 'Creators, platforms or advertisers buying their way off a list', 'Never']
	];

	const rules = [
		'Free blocking is never reduced to push upgrades.',
		'Paying or giving never changes tag weight, review priority or any verdict.',
		'No creator, platform or advertiser can pay to leave a list or join an allowlist.',
		'No ads, no affiliate links, and no sale or sharing of user data.',
		'Every funding source is published.'
	];
</script>

<svelte:head>
	<title>Transparency · Colander</title>
	<meta name="description" content="Live numbers for the Colander list, how it is funded, the independence rules and how verdicts expire." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Transparency"
		title="Open books,"
		title2="open list."
		lede="A blocker asks for trust. These are the live numbers behind the shared list, where the money comes from, and the rules that keep money away from verdicts."
	>
		<div class="badge"><LiveBadge sequence={stats?.list_sequence} updatedAt={stats?.list_updated_at} now={live.now ?? undefined} /></div>
	</PageHeader>
</div>

<div class="cl-container page-body body">
	<section class="block" aria-labelledby="live-title">
		<div class="block-head">
			<h2 class="cl-title" id="live-title">The list, right now</h2>
			<!-- The line keeps its height before the numbers arrive, so the body never moves. -->
			<p class="cl-figure cl-muted as-of">{#if live.asOf}As of {fmtShortDate(live.asOf)}, {fmtTime(live.asOf)}{/if}</p>
		</div>
		{#if !stats && live.failed}
			<Notice tone="error" title="Live numbers could not load"><p>Please try again in a moment.</p></Notice>
		{:else if !stats}
			<!-- The numbers' space is held while they load, so the sections below never jump. -->
			<div class="reserve"><Loading /></div>
		{:else}
			<div class="cells uin-card">
				<div class="cell"><StatCell size="lg" label="Sources on the list" value={total} reserve={6} /></div>
				<div class="cell"><StatCell size="lg" label="Items with their own verdict" value={stats.items} reserve={6} /></div>
				<div class="cell"><StatCell size="lg" label="Verdict changes in the last 7 days" value={stats.decisions_7d} zero="None this week" reserve={5} /></div>
				<div class="cell"><StatCell size="lg" label="Appeals open" value={stats.appeals.open} zero="No open appeals" reserve={4} /></div>
				<div class="cell">
					<StatCell size="lg" label="Median days to decide an appeal" value={stats.appeals.median_days} zero="No appeals decided yet" foot="The goal is 7 days or fewer." reserve={4} />
				</div>
			</div>

			<div class="two even">
				<section class="uin-card uin-card-lg uin-card-pad" aria-labelledby="by-title">
					<h3 class="cl-title" id="by-title">Sources by verdict</h3>
					<VerdictTally counts={stats.sources} layout="rows" {perDot} />
					<p class="cl-caption cl-muted">Each dot is {fmtNum(perDot)} {perDot === 1 ? 'source' : 'sources'}. Clear sources stay on the list so the extension knows they were checked.</p>
				</section>
				<div class="side">
					<section class="uin-card uin-card-lg uin-card-pad list-card" aria-labelledby="list-title">
						<h3 class="cl-title" id="list-title">Core list {fmtListVersion(stats.list_sequence)}</h3>
						{#if stats.list_updated_at}<p class="cl-muted">Published {fmtShortDate(stats.list_updated_at)}, {fmtTime(stats.list_updated_at)}</p>{/if}
						<ArrowLink href="/definition#signing">How signing works</ArrowLink>
					</section>
					<section class="uin-card uin-card-lg uin-card-pad" aria-label="Installs">
						{#if stats.active_installs < 1000}
							<p class="cl-muted">Install counts appear here once 1,000 people use Colander.</p>
						{:else}
							<StatCell size="lg" label="Active installs" value={stats.active_installs} foot="Estimated from list downloads, which carry no identifier." reserve={7} />
						{/if}
					</section>
				</div>
			</div>
		{/if}
	</section>

	<section class="block" aria-labelledby="funding-title" id="funding">
		<h2 class="cl-title" id="funding-title">Where the money comes from</h2>
		<p class="cl-muted lede">
			Blocking is free, and the work behind it is paid for by a low-priced subscription, gifts and grants. A yearly report publishes income by
			source and spending by category on this page.
		</p>
		<div class="table-card">
			<table class="plain stack-sm">
				<thead><tr><th scope="col">Source</th><th scope="col">What it is</th><th scope="col">Status</th></tr></thead>
				<tbody>
					{#each funding as [name, what, status] (name)}
						{@const Icon = STATUS[status]}
						<tr>
							<th scope="row">{name}</th>
							<td>{what}</td>
							<td data-label="Status"><span class="status"><Icon size={16} aria-hidden="true" />{status}</span></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<div class="two">
		<section class="block" aria-labelledby="independence-title" id="independence">
			<h2 class="cl-title" id="independence-title">Independence rules</h2>
			<ol class="rules">
				{#each rules as r, i (r)}<li><span class="cl-figure n">0{i + 1}</span><span>{r}</span></li>{/each}
			</ol>
			<p class="cl-muted small">The scoring and review code never reads plan or payment state. It is an input nobody can buy.</p>
		</section>

		<section class="block" aria-labelledby="expiry-title">
			<h2 class="cl-title" id="expiry-title">How verdicts expire</h2>
			<ul class="dots-list small">
				<li>Every verdict carries a re-score date, 90 days after it last changed.</li>
				<li>At that date, staff and curator decisions lapse and the source is scored again from fresh evidence.</li>
				<li>If re-scoring would make it Slop, it stays Likely slop until a person reviews it.</li>
				<li>An appeal triggers re-review at once, and a verified appeal shows the source as Disputed within a minute.</li>
				<li>The extension syncs about once an hour, and works offline from its last copy.</li>
			</ul>
		</section>
	</div>

	<section class="block" aria-labelledby="review-title">
		<h2 class="cl-title" id="review-title">How review works</h2>
		<div class="three">
			<div class="uin-card uin-card-lg uin-card-pad">
				<h3>Curators</h3>
				<p class="cl-muted small">Volunteers who review reports and items, with spot audits. They cannot decide large sources or appeals.</p>
			</div>
			<div class="uin-card uin-card-lg uin-card-pad">
				<h3>Staff</h3>
				<p class="cl-muted small">Decide large sources, escalations and every appeal. A list-wide Slop verdict on a large source always needs staff.</p>
			</div>
			<div class="uin-card uin-card-lg uin-card-pad">
				<h3>Community scoring</h3>
				<p class="cl-muted small">Runs every few minutes from weighted tags. Every change it makes is logged with a reason built from its signals.</p>
			</div>
		</div>
		<ArrowLink href="/log">Read every decision in the log</ArrowLink>
	</section>
</div>

<style>
	/* The badge's line is held before the list version is known, so the page below never moves. */
	.badge {
		min-height: 24px;
		margin-top: 16px;
	}
	.as-of {
		min-height: 16px;
	}
	.body {
		display: grid;
		gap: 64px;
	}
	.block {
		display: grid;
		justify-items: start;
		gap: 16px;
		align-content: start;
	}
	.block > :global(*) {
		width: 100%;
	}
	.block > :global(.arrow) {
		width: auto;
	}
	.block-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 24px;
	}
	.cells {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}
	.cell {
		padding: 24px;
	}
	.cell + .cell {
		border-left: 1px solid var(--cl-border);
	}
	.cell :global(.label) {
		min-height: 40px;
	}
	.two {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
		align-items: start;
	}
	.two > section {
		display: grid;
		gap: 16px;
	}
	.side {
		display: grid;
		gap: 24px;
	}
	.reserve {
		min-height: 420px;
	}
	@media (max-width: 1023px) {
		.reserve {
			min-height: 940px;
		}
	}
	/* The verdict card and the two beside it end on one line. */
	.two.even {
		align-items: stretch;
	}
	.even .side {
		grid-template-rows: auto 1fr;
	}
	/* The 50-dot meters shrink with the card instead of pushing past it on phones. */
	.two :global(.tally-rows) {
		grid-template-columns: max-content minmax(0, 300px) max-content;
	}
	.two :global(.tally-rows .chart) {
		width: 100%;
	}
	.list-card {
		display: grid;
		justify-items: start;
		gap: 8px;
	}
	.lede {
		max-width: 68ch;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
		white-space: nowrap;
	}
	.rules {
		display: grid;
		gap: 12px;
		list-style: none;
	}
	.rules li {
		display: grid;
		grid-template-columns: 32px 1fr;
		gap: 8px;
		font: var(--cl-body-lg);
	}
	.n {
		padding-top: 4px;
		color: var(--cl-text-muted);
	}
	.small {
		font: var(--cl-body);
	}
	.three {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 24px;
	}
	.three h3 {
		margin-bottom: 8px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	@media (max-width: 1023px) {
		.cells {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.cell + .cell {
			border-left: 0;
		}
		.cell {
			border-top: 1px solid var(--cl-border);
		}
		.cell:first-child {
			grid-column: 1 / -1;
			border-top: 0;
		}
		.cell:nth-child(odd):not(:first-child) {
			border-left: 1px solid var(--cl-border);
		}
		.two,
		.three {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 639px) {
		.cell {
			padding: 16px;
		}
	}
</style>
