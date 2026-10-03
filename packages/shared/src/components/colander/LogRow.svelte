<!--
@component LogRow: one decision log entry in a 56 px row: the time in figure type, the platform,
the source, the verdict change, a one-line reason and who decided. Below 720 px of width it
becomes a 3-line block. With `children`, the row is a details element that opens to them (the
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
	<span class="row">
		<time class="cl-figure when" datetime={entry.at}>{time === 'date' ? fmtShortDate(entry.at) : fmtTime(entry.at)}</time>
		<span class="plat"><PlatformTag platform={entry.platform} /></span>
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
	.row {
		display: grid;
		grid-template-columns: 64px 96px minmax(96px, 1fr) max-content minmax(0, 2fr);
		gap: 16px;
		align-items: center;
		height: 56px;
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
	.reason,
	.actor {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reason {
		font: var(--cl-body);
	}
	.actor {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.more {
		padding: 0 0 16px;
	}
	@container (max-width: 719px) {
		.row {
			grid-template-columns: auto minmax(0, 1fr);
			gap: 4px 12px;
			height: auto;
			padding: 12px 0;
		}
		.src {
			grid-column: 1;
		}
		.change {
			grid-column: 2;
			justify-self: start;
		}
		.why {
			grid-column: 1 / -1;
		}
	}
</style>
