<!--
@component LogRow: one decision log entry in a row at least 56 px tall: the time in figure type,
the platform, the source (and the item, for an item-level change), the verdict change, the reason
in up to 2 lines and who decided. Every
column but the source and the reason has a fixed track, so the platform tags, arrows and chips of
a list line up whatever the names; the source track never drops below 152 px (128 beside a date)
and the reason below 176, so names read whole.

Narrower than 960 px of width, the reason moves under the source and spans to the row's end, so it
reads in full rather than cut mid-sentence (the landing band, /s history). Below 768 it becomes a
3-line block: time and platform, then source and change, then the reason.

`time`: "14:02 UTC" under a day header (/log), `date` "2 Oct 2026" for rows from other days, and
`stamp` "4 Oct, 03:52 UTC" where no day header sits above (the landing band). `full` lets the
reason wrap whole (/s, the page that explains the verdict). With `children`, the row is a details
element that opens to them (the EvidenceCard on /log), with a chevron that turns when it is open;
the source name is then plain text, since a summary holds no links.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import PlatformTag from './PlatformTag.svelte';
	import VerdictTransition from './VerdictTransition.svelte';
	import type { LogEntry } from '../../api';
	import { actorText, fmtDayTime, fmtShortDate, fmtTime, sourcePath } from '../../utils/format';

	let {
		entry,
		time = 'time',
		full = false,
		site = '',
		children
	}: { entry: LogEntry; time?: 'time' | 'date' | 'stamp'; full?: boolean; site?: string; children?: Snippet } = $props();

	const name = $derived(entry.source_name ?? entry.source_id);
	const when = $derived(time === 'date' ? fmtShortDate(entry.at) : time === 'stamp' ? fmtDayTime(entry.at) : fmtTime(entry.at));
</script>

{#snippet row(link: boolean)}
	<span class="row" class:dated={time === 'date'} class:stamped={time === 'stamp'} class:expands={!link}>
		<span class="top">
			<time class="cl-figure when" datetime={entry.at}>{when}</time>
			<span class="plat"><PlatformTag platform={entry.platform} /></span>
		</span>
		<!-- An item-level change names its item, so it never reads like the source's own row. -->
		<span class="who">
			{#if link}
				<a class="src" href={site + sourcePath(entry.platform, entry.source_id)}>{name}</a>
			{:else}
				<span class="src">{name}</span>
			{/if}
			{#if entry.target_type === 'item'}<span class="item">Item <span class="cl-figure">{entry.target_id}</span></span>{/if}
		</span>
		<span class="change"><VerdictTransition from={entry.from} to={entry.to} /></span>
		<span class="why">
			<span class="reason" class:full>{entry.reason}</span>
			<span class="actor">{actorText(entry)}</span>
		</span>
		{#if !link}<span class="chev" aria-hidden="true"><ChevronDown size={16} /></span>{/if}
	</span>
{/snippet}

<div class="log">
	{#if children}
		<details>
			<summary>{@render row(false)}</summary>
			<div class="more">{@render children()}</div>
		</details>
	{:else}
		{@render row(true)}
	{/if}
</div>

<style>
	.log {
		container-type: inline-size;
		border-top: 1px solid var(--cl-border);
	}
	summary {
		display: block;
		margin-inline: -8px;
		padding-inline: 8px;
		border-radius: var(--cl-r-chip);
		cursor: pointer;
		list-style: none;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	summary:hover {
		background: color-mix(in srgb, var(--cl-text) 4%, transparent);
	}
	summary::-webkit-details-marker {
		display: none;
	}
	/* Time 64 (88 for dates, 120 for a date and time), platform 96, source, the change in a 232
	   track, then the reason, and a 16 px chevron when the row opens. */
	.row {
		--when: 64px;
		--src: 152px;
		display: grid;
		grid-template-columns: var(--when) 96px minmax(var(--src), 1fr) 232px minmax(176px, 1.5fr);
		gap: 12px;
		align-items: center;
		min-height: 56px;
		padding-block: 8px;
	}
	.dated {
		--when: 88px;
		--src: 128px;
	}
	.stamped {
		--when: 120px;
		--src: 128px;
	}
	.expands {
		grid-template-columns: var(--when) 96px minmax(var(--src), 1fr) 232px minmax(176px, 1.5fr) 16px;
	}
	.top {
		display: contents;
	}
	/* The from chip has a fixed box, so arrows and to chips form a column. */
	.change :global(.from) {
		min-width: 92px;
	}
	.when {
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
	.who {
		display: grid;
		min-width: 0;
	}
	.src,
	.item {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.src {
		color: var(--cl-text);
		font: var(--cl-body-strong);
	}
	.item {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	a.src {
		text-decoration: none;
	}
	a.src:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.why {
		display: grid;
		min-width: 0;
	}
	.actor {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The reason wraps to a second line before it is cut; `full` never cuts it. */
	.reason {
		display: -webkit-box;
		overflow: hidden;
		font: var(--cl-body);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.reason.full {
		display: block;
		overflow: visible;
	}
	.actor {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.chev {
		display: grid;
		color: var(--cl-text-muted);
		transition: transform var(--cl-fast) var(--cl-ease);
	}
	details[open] .chev {
		transform: rotate(180deg);
	}
	.more {
		padding: 0 0 16px;
	}
	/* The reason under the source, spanning to the end, so it has room to read whole. */
	@container (min-width: 768px) and (max-width: 959px) {
		.row {
			grid-template-columns: var(--when) 96px minmax(0, 1fr) 232px;
			grid-template-areas: 'when plat src change' '. . why why';
			row-gap: 2px;
		}
		.expands {
			grid-template-columns: var(--when) 96px minmax(0, 1fr) 232px 16px;
			grid-template-areas: 'when plat src change chev' '. . why why why';
		}
		.when {
			grid-area: when;
		}
		.plat {
			grid-area: plat;
		}
		.who {
			grid-area: src;
		}
		.change {
			grid-area: change;
		}
		.why {
			grid-area: why;
		}
		.chev {
			grid-area: chev;
		}
	}
	@container (max-width: 767px) {
		.row {
			grid-template-columns: minmax(0, 1fr) max-content;
			grid-template-areas: 'top top' 'src change' 'why why';
			gap: 4px 12px;
			min-height: 0;
			padding: 12px 0;
		}
		.expands {
			grid-template-areas: 'top chev' 'src change' 'why why';
		}
		/* The date and the platform always start at the left edge. */
		.top {
			display: flex;
			grid-area: top;
			align-items: center;
			gap: 12px;
		}
		.who {
			grid-area: src;
		}
		.change {
			grid-area: change;
		}
		.why {
			grid-area: why;
		}
		.chev {
			grid-area: chev;
			justify-self: end;
		}
	}
	@container (max-width: 359px) {
		.row {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'top' 'src' 'change' 'why';
		}
		.expands {
			grid-template-columns: minmax(0, 1fr) 16px;
			grid-template-areas: 'top chev' 'src src' 'change change' 'why why';
		}
		.change {
			justify-self: start;
		}
	}
</style>
