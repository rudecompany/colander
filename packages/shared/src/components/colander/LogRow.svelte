<!--
@component LogRow: one decision log entry in a row at least 56 px tall: the time in figure type,
the platform, the source, the verdict change, the reason in up to 2 lines and who decided. Every
column but the source and the reason has a fixed track, so the platform tags, arrows and chips of
a list line up whatever the names; the source track never drops below 152 px (128 beside a date)
and the reason below 176, so names read whole. Below 768 px of width it becomes a 3-line block:
time and platform, then source and change, then the reason. With `children`, the row is a details element that opens to them (the
EvidenceCard on /log); the source name is then plain text, since a summary holds no links.
`time="date"` shows "2 Oct 2026" instead of "14:02 UTC".
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import PlatformTag from './PlatformTag.svelte';
	import VerdictTransition from './VerdictTransition.svelte';
	import type { LogEntry } from '../../api';
	import { actorText, fmtShortDate, fmtTime, sourcePath } from '../../utils/format';

	let {
		entry,
		time = 'time',
		site = '',
		children
	}: { entry: LogEntry; time?: 'time' | 'date'; site?: string; children?: Snippet } = $props();

	const name = $derived(entry.source_name ?? entry.source_id);
</script>

{#snippet row(link: boolean)}
	<span class="row" class:dated={time === 'date'}>
		<span class="top">
			<time class="cl-figure when" datetime={entry.at}>{time === 'date' ? fmtShortDate(entry.at) : fmtTime(entry.at)}</time>
			<span class="plat"><PlatformTag platform={entry.platform} /></span>
		</span>
		{#if link}
			<a class="src" href={site + sourcePath(entry.platform, entry.source_id)}>{name}</a>
		{:else}
			<span class="src">{name}</span>
		{/if}
		<span class="change"><VerdictTransition from={entry.from} to={entry.to} /></span>
		<span class="why">
			<span class="reason">{entry.reason}</span>
			<span class="actor">{actorText(entry)}</span>
		</span>
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
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	/* Time 64 (88 for dates), platform 96, source, the change in a 232 track, then the reason. */
	.row {
		display: grid;
		grid-template-columns: 64px 96px minmax(152px, 1fr) 232px minmax(176px, 1.5fr);
		gap: 12px;
		align-items: center;
		min-height: 56px;
		padding-block: 8px;
	}
	.dated {
		grid-template-columns: 88px 96px minmax(128px, 1fr) 232px minmax(176px, 1.5fr);
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
	.src {
		overflow: hidden;
		color: var(--cl-text);
		font: var(--cl-body-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
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
	/* The reason wraps to a second line before it is cut. */
	.reason {
		display: -webkit-box;
		overflow: hidden;
		font: var(--cl-body);
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.actor {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.more {
		padding: 0 0 16px;
	}
	@container (max-width: 767px) {
		.row,
		.dated {
			grid-template-columns: minmax(0, 1fr) max-content;
			grid-template-areas: 'top top' 'src change' 'why why';
			gap: 4px 12px;
			min-height: 0;
			padding: 12px 0;
		}
		/* The date and the platform always start at the left edge. */
		.top {
			display: flex;
			grid-area: top;
			align-items: center;
			gap: 12px;
		}
		.src {
			grid-area: src;
		}
		.change {
			grid-area: change;
		}
		.why {
			grid-area: why;
		}
	}
	@container (max-width: 359px) {
		.row,
		.dated {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'top' 'src' 'change' 'why';
		}
		.change {
			justify-self: start;
		}
	}
</style>
