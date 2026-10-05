<!--
@component StrictnessTable: what each level does to each verdict, as icons with words. Standard
carries an outline Default badge; the `current` level sits on brand-tint. The same table on
/definition and in options.

It fits a 640 px column (the 680 reading measure, the 720 options column). Narrower than that, it
becomes one block per level, each listing the five verdicts with their treatment, so nothing
scrolls sideways and no chip is ever cut.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Tag from '@lucide/svelte/icons/tag';
	import VerdictChip from './VerdictChip.svelte';
	import { ACTION_DONE_WORD, ACTION_TABLE, STRICTNESS, STRICTNESS_WORD, VERDICTS, type Strictness, type Verdict } from '../../verdicts';

	let { current, caption = 'What each strictness level does' }: { current?: Strictness; caption?: string } = $props();
	const ICON = { hide: EyeOff, label: Tag, allow: Eye };
</script>

{#snippet level(l: Strictness)}
	<span class="level">{STRICTNESS_WORD[l]}{#if l === 'standard'}<span class="uin-badge uin-badge-md">Default</span>{/if}</span>
{/snippet}

{#snippet act(l: Strictness, v: Verdict)}
	{@const a = ACTION_TABLE[l][v]}
	{@const Icon = ICON[a]}
	<span class="act"><Icon size={16} aria-hidden="true" />{ACTION_DONE_WORD[a]}</span>
{/snippet}

<div class="st">
	<table class="wide">
		<caption class="cl-sr-only">{caption}</caption>
		<thead>
			<tr>
				<th scope="col">Level</th>
				{#each VERDICTS as v (v)}<th scope="col"><VerdictChip verdict={v} size="sm" /></th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each STRICTNESS as l (l)}
				<tr class:current={l === current} aria-current={l === current ? 'true' : undefined}>
					<th scope="row">{@render level(l)}</th>
					{#each VERDICTS as v (v)}<td>{@render act(l, v)}</td>{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	<ul class="stacked" aria-label={caption}>
		{#each STRICTNESS as l (l)}
			<li class:current={l === current} aria-current={l === current ? 'true' : undefined}>
				<p class="name">{@render level(l)}</p>
				<dl>
					{#each VERDICTS as v (v)}
						<div><dt><VerdictChip verdict={v} size="sm" /></dt><dd>{@render act(l, v)}</dd></div>
					{/each}
				</dl>
			</li>
		{/each}
	</ul>
</div>

<style>
	.st {
		container-type: inline-size;
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font: var(--cl-body);
	}
	th,
	td {
		padding: 12px 10px;
		text-align: left;
		white-space: nowrap;
	}
	th:first-child {
		padding-left: 16px;
	}
	th:last-child,
	td:last-child {
		padding-right: 16px;
	}
	thead th {
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	tbody tr {
		border-top: 1px solid var(--cl-border);
	}
	tbody th {
		font: var(--cl-body-strong);
	}
	.current {
		background: var(--cl-brand-tint);
	}
	.level,
	.act {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.act {
		gap: 4px;
	}
	.act :global(svg) {
		flex: none;
	}
	.stacked {
		display: none;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.stacked li {
		padding: 12px 16px 16px;
	}
	.stacked li + li {
		border-top: 1px solid var(--cl-border);
	}
	.name {
		margin: 0 0 8px;
		font: var(--cl-body-strong);
	}
	dl {
		display: grid;
		gap: 6px;
		margin: 0;
	}
	dl div {
		display: grid;
		grid-template-columns: 112px minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		font: var(--cl-body);
	}
	dt,
	dd {
		margin: 0;
	}
	@container (max-width: 639px) {
		.wide {
			display: none;
		}
		.stacked {
			display: block;
		}
	}
</style>
