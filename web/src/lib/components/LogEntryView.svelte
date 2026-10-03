<!-- @component One decision log entry: when, what changed, who decided, and why. -->
<script lang="ts">
	import { PLATFORM_NAME, SIGNAL_TEXT } from '@colander/shared';
	import type { LogEntry } from '@colander/shared/api';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { actorText, fmtDateTime, sourcePath } from '#lib/format.ts';
	import VerdictOrNone from './VerdictOrNone.svelte';

	let { entry, showSource = true, headingLevel = 3 }: { entry: LogEntry; showSource?: boolean; headingLevel?: 2 | 3 | 4 } = $props();
</script>

<article class="entry">
	<div class="when">
		<time datetime={entry.at}>{fmtDateTime(entry.at)}</time>
		<span class="platform">{PLATFORM_NAME[entry.platform]}</span>
	</div>
	<div class="body">
		{#if showSource}
			<svelte:element this={'h' + headingLevel} class="source">
				<a href={sourcePath(entry.platform, entry.source_id)}>{entry.source_name ?? entry.source_id}</a>
				{#if entry.target_type === 'item'}<span class="item">item <span class="mono">{entry.target_id}</span></span>{/if}
			</svelte:element>
		{:else if entry.target_type === 'item'}
			<p class="item">Item <span class="mono">{entry.target_id}</span></p>
		{/if}
		<p class="change">
			<span class="sr-only">Verdict changed from</span>
			<VerdictOrNone verdict={entry.from} />
			<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
			<span class="sr-only">to</span>
			<VerdictOrNone verdict={entry.to} />
		</p>
		<p class="reason">{entry.reason}</p>
		{#if entry.signals.length}
			<ul class="signals" aria-label="Signals">
				{#each entry.signals as s (s)}<li>{SIGNAL_TEXT[s]}</li>{/each}
			</ul>
		{/if}
		<p class="actor">{actorText(entry)}</p>
	</div>
</article>

<style>
	.entry {
		display: grid;
		grid-template-columns: 168px 1fr;
		gap: var(--cl-s2) var(--cl-s5);
		padding-block: var(--cl-s5);
	}
	.when {
		display: grid;
		align-content: start;
		gap: 2px;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.when time {
		font-variant-numeric: tabular-nums;
	}
	.platform {
		font-weight: 600;
	}
	.body {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.source {
		font: 600 16px/24px var(--cl-font);
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--cl-s1) var(--cl-s2);
	}
	.source a {
		color: var(--cl-text);
	}
	.item {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.change {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--cl-text-muted);
	}
	.reason {
		font: var(--cl-body);
		max-width: 64ch;
	}
	.signals {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: var(--cl-s2);
	}
	.signals li {
		padding: 2px 8px;
		border-radius: var(--cl-r-chip);
		background: var(--w-ink-soft);
		font: var(--cl-caption);
	}
	.actor {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	@media (max-width: 640px) {
		.entry {
			grid-template-columns: 1fr;
		}
		.when {
			display: flex;
			gap: 8px;
		}
	}
</style>
